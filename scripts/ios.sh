#!/usr/bin/env bash
# Teleprompter native iOS Simulator harness (ADR-0001 rewrite).
#
# Drives the Swift app headlessly: generate project → build → install → launch
# → verify boot, plus run the XCTest bundle. No Xcode GUI required.
#
# Usage:
#   scripts/ios.sh gen          Regenerate Teleprompter.xcodeproj from project.yml
#   scripts/ios.sh build        Build the app for the iOS Simulator
#   scripts/ios.sh run          Install + launch on the Simulator
#   scripts/ios.sh smoke        Full loop: gen → build → install → launch → verify boot marker
#   scripts/ios.sh test         Run the XCTest bundle on the Simulator
#   scripts/ios.sh boot         Boot the target simulator (idempotent)
#
# Env:
#   TP_SIM     Simulator device name (default: "iPhone 17 Pro")
#   TP_SCHEME  Xcode scheme (default: "Teleprompter")

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
PROJECT="$IOS_DIR/Teleprompter.xcodeproj"
DERIVED="$IOS_DIR/build/DerivedData"
SCHEME="${TP_SCHEME:-Teleprompter}"
SIM_NAME="${TP_SIM:-iPhone 17 Pro}"
BUNDLE_ID="dev.tpmt.teleprompter"
BOOT_MARKER="TP_BOOT_OK"

# Diagnostics go to stderr so `$(cmd_boot)` etc. capture only the clean stdout value.
log()  { printf '\033[1;34m[ios]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ios] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }

# Resolve the UDID for $SIM_NAME among available devices. Exact name match.
sim_udid() {
  xcrun simctl list devices available -j \
    | /usr/bin/python3 -c '
import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)
for runtime,devs in d["devices"].items():
    for dev in devs:
        if dev.get("isAvailable") and dev["name"]==name:
            print(dev["udid"]); sys.exit(0)
sys.exit(1)
' "$SIM_NAME"
}

cmd_gen() {
  require xcodegen
  log "generating project from project.yml"
  ( cd "$IOS_DIR" && xcodegen generate )
}

ensure_project() { [ -d "$PROJECT" ] || cmd_gen; }

cmd_boot() {
  local udid; udid="$(sim_udid)" || die "simulator not found: $SIM_NAME (set TP_SIM)"
  local state
  state="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev["state"]); sys.exit(0)
' "$udid")"
  if [ "$state" != "Booted" ]; then
    log "booting $SIM_NAME ($udid)"
    xcrun simctl boot "$udid"
  else
    log "$SIM_NAME already booted ($udid)"
  fi
  echo "$udid"
}

cmd_build() {
  require xcodebuild
  ensure_project
  log "building $SCHEME for iOS Simulator"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=$SIM_NAME" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO \
    build | xcbeautify_or_cat
}

# Pretty-print xcodebuild output if xcbeautify exists, else pass through.
xcbeautify_or_cat() {
  if command -v xcbeautify >/dev/null 2>&1; then xcbeautify; else cat; fi
}

app_path() {
  local p="$DERIVED/Build/Products/Debug-iphonesimulator/Teleprompter.app"
  [ -d "$p" ] || die "app not built yet: $p (run: scripts/ios.sh build)"
  echo "$p"
}

cmd_run() {
  local udid; udid="$(cmd_boot)"
  local app; app="$(app_path)"
  log "installing $app"
  xcrun simctl install "$udid" "$app"
  log "launching $BUNDLE_ID"
  xcrun simctl launch "$udid" "$BUNDLE_ID"
}

cmd_smoke() {
  cmd_gen
  cmd_build
  local udid; udid="$(cmd_boot)"
  local app; app="$(app_path)"
  log "installing"
  xcrun simctl install "$udid" "$app"
  # Fresh launch so the boot marker is emitted now (terminate any prior instance).
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching + watching log for '$BOOT_MARKER'"
  xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  # Poll the unified log for the marker emitted in ContentView.onAppear. Filter
  # by our subsystem — the default `log show` level drops Debug/Info lines.
  local found=""
  for _ in $(seq 1 20); do
    if xcrun simctl spawn "$udid" log show --last 30s --style compact \
         --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null \
         | grep -q "$BOOT_MARKER"; then
      found="yes"; break
    fi
    sleep 0.5
  done
  if [ -n "$found" ]; then
    log "✅ SMOKE PASS — boot marker '$BOOT_MARKER' observed on $SIM_NAME"
  else
    die "SMOKE FAIL — boot marker '$BOOT_MARKER' not seen in Simulator log"
  fi
}

cmd_test() {
  require xcodebuild
  ensure_project
  log "running tests for $SCHEME on iOS Simulator"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "platform=iOS Simulator,name=$SIM_NAME" \
    -derivedDataPath "$DERIVED" \
    CODE_SIGNING_ALLOWED=NO \
    test | xcbeautify_or_cat
}

main() {
  local sub="${1:-smoke}"; shift || true
  case "$sub" in
    gen)   cmd_gen ;;
    boot)  cmd_boot ;;
    build) cmd_build ;;
    run)   cmd_run ;;
    smoke) cmd_smoke ;;
    test)  cmd_test ;;
    *) die "unknown subcommand: $sub (use: gen|boot|build|run|smoke|test)" ;;
  esac
}

main "$@"
