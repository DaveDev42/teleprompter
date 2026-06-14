#!/usr/bin/env bash
# Teleprompter native iOS Simulator harness (ADR-0001 rewrite).
#
# Drives the Swift app headlessly: generate project → build → install → launch
# → verify boot, plus run the XCTest bundle. No Xcode GUI required.
#
# Usage:
#   scripts/ios.sh gen          Regenerate Teleprompter.xcodeproj from project.yml
#   scripts/ios.sh rust         Build TpCore.xcframework + Swift bindings from rust/tp-core
#   scripts/ios.sh build        Build the app for the iOS Simulator (rust first)
#   scripts/ios.sh run          Install + launch on the Simulator
#   scripts/ios.sh smoke        Full loop: rust → gen → build → install → launch → verify markers
#   scripts/ios.sh test         Run the XCTest bundle on the Simulator (rust first)
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
CORE_MARKER="TP_CORE_OK"
XCFRAMEWORK="$REPO_ROOT/rust/target/TpCore.xcframework"

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

# Build the Rust core into TpCore.xcframework + regenerate Swift bindings.
# Delegates to rust/build-xcframework.sh, which handles the rustup PATH-shim
# workaround, the 3 iOS slices, the simulator lipo, and binding generation.
cmd_rust() {
  log "building TpCore.xcframework + Swift bindings (rust/tp-core)"
  "$REPO_ROOT/rust/build-xcframework.sh" "$@"
}

# The app/test targets link the xcframework; build it first if missing. Pass
# --force to always rebuild (e.g. after editing Rust sources).
ensure_xcframework() {
  if [ "${TP_SKIP_RUST:-}" = "1" ]; then
    log "TP_SKIP_RUST=1 — skipping xcframework build"
    [ -d "$XCFRAMEWORK" ] || die "TP_SKIP_RUST set but xcframework absent: $XCFRAMEWORK"
    return
  fi
  if [ -d "$XCFRAMEWORK" ] && [ "${1:-}" != "--force" ] && [ "${TP_FORCE_RUST:-}" != "1" ]; then
    log "xcframework present ($XCFRAMEWORK) — skipping rebuild (set TP_FORCE_RUST=1 to force)"
  else
    cmd_rust
  fi
}

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
  ensure_xcframework
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
  ensure_xcframework
  cmd_gen
  cmd_build
  local udid; udid="$(cmd_boot)"
  local app; app="$(app_path)"
  log "installing"
  xcrun simctl install "$udid" "$app"
  # Fresh launch so the markers are emitted now (terminate any prior instance).
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching + watching log for '$BOOT_MARKER' and '$CORE_MARKER'"
  xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  # Poll the unified log for the markers emitted in ContentView.onAppear. Filter
  # by our subsystem — the default `log show` level drops Debug/Info lines.
  # TP_CORE_OK proves the Rust FFI is linked AND the encode→encrypt→decrypt→decode
  # round-trip succeeds on-device; TP_CORE_FAIL means it linked but a step diverged.
  local boot_seen="" core_line=""
  for _ in $(seq 1 20); do
    # Capture into a variable first — `| grep -q` SIGPIPEs the producer under
    # pipefail (rc=141) once grep exits on the first match.
    local out
    out="$(xcrun simctl spawn "$udid" log show --last 30s --style compact \
            --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null)" || true
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    # Grab the whole TP_CORE_ line so a FAIL surfaces its step/detail.
    core_line="$(printf '%s\n' "$out" | grep -Eo 'TP_CORE_(OK|FAIL)[^"]*' | tail -n1 || true)"
    if [ -n "$boot_seen" ] && [ -n "$core_line" ]; then break; fi
    sleep 0.5
  done
  [ -n "$boot_seen" ] || die "SMOKE FAIL — boot marker '$BOOT_MARKER' not seen in Simulator log"
  [ -n "$core_line" ] || die "SMOKE FAIL — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) log "✅ SMOKE PASS — boot marker + '$core_line' observed on $SIM_NAME" ;;
    *) die "SMOKE FAIL — tp-core round-trip failed on-device: $core_line" ;;
  esac
}

cmd_test() {
  require xcodebuild
  ensure_xcframework
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
    rust)  cmd_rust "$@" ;;
    boot)  cmd_boot ;;
    build) cmd_build "$@" ;;
    run)   cmd_run ;;
    smoke) cmd_smoke ;;
    test)  cmd_test ;;
    *) die "unknown subcommand: $sub (use: gen|rust|boot|build|run|smoke|test)" ;;
  esac
}

main "$@"
