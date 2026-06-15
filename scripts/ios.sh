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
#   scripts/ios.sh smoke        Full loop: rust → gen → build → install → launch → verify
#                               boot+core markers, then inject a tp://p?d=… deep link and
#                               verify the TP_PAIR_OK pairing marker (M1, no daemon needed)
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
PAIR_MARKER="TP_PAIR_OK"
# Deterministic pairing deep link injected during smoke (M1 offline ingestion).
# Layout (pairing.rs v3): magic "tp" | ver 3 | did_len | did | relay_len(0=default)
# | ps(32×0x01) | pk(32×0x02); base64url-wrapped as tp://p?d=…
SMOKE_DAEMON_ID="daemon-smoketest"
XCFRAMEWORK="$REPO_ROOT/rust/target/TpCore.xcframework"
# Ad-hoc sign Simulator builds so entitlements (keychain-access-groups) embed —
# the Simulator Keychain rejects SecItemAdd without an entitlement (-34018).
# No developer identity needed; "-" is accepted by the Simulator.
SIGN_FLAGS="CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES"

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

# Emit the deterministic smoke pairing deep link (tp://p?d=…) to stdout.
# Built in Python to match pairing.rs's v3 binary layout + base64url byte-for-byte
# so the on-device FFI decode (`decodePairingData`) succeeds without a daemon.
smoke_pair_link() {
  /usr/bin/python3 -c '
import base64, sys
did = sys.argv[1]
prefix = "daemon-"
wire_did = did[len(prefix):] if did.startswith(prefix) else did
buf = bytearray()
buf += b"tp"                       # magic
buf.append(3)                       # version
buf.append(len(wire_did))          # did_len
buf += wire_did.encode()           # did
buf.append(0)                       # relay_len = 0 → default relay
buf += bytes([0x01]) * 32          # ps
buf += bytes([0x02]) * 32          # pk
b64 = base64.b64encode(bytes(buf)).decode()
b64url = b64.replace("+", "-").replace("/", "_").rstrip("=")
print(f"tp://p?d={b64url}")
' "$1"
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
    $SIGN_FLAGS \
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
    "$CORE_MARKER"*) log "core OK — '$core_line'" ;;
    *) die "SMOKE FAIL — tp-core round-trip failed on-device: $core_line" ;;
  esac

  # M1: offline pairing ingestion. Open a deterministic tp://p?d=… deep link and
  # verify the app decodes it via FFI and emits TP_PAIR_OK did=<id> (or
  # TP_PAIR_FAIL). This exercises the OS URL-routing path + DeepLinkHandler +
  # PairingStore + Keychain end-to-end, no daemon required.
  local link; link="$(smoke_pair_link "$SMOKE_DAEMON_ID")"
  log "opening pairing deep link (M1) — watching for '$PAIR_MARKER did=$SMOKE_DAEMON_ID'"
  xcrun simctl openurl "$udid" "$link" >/dev/null
  local pair_line=""
  for _ in $(seq 1 20); do
    local pout
    pout="$(xcrun simctl spawn "$udid" log show --last 30s --style compact \
             --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null)" || true
    pair_line="$(printf '%s\n' "$pout" | grep -Eo 'TP_PAIR_(OK|FAIL)[^"]*' | tail -n1 || true)"
    if [ -n "$pair_line" ]; then break; fi
    sleep 0.5
  done
  [ -n "$pair_line" ] || die "SMOKE FAIL — pairing deep link opened but no '$PAIR_MARKER'/TP_PAIR_FAIL line (URL not routed to app?)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*)
      log "✅ SMOKE PASS — boot + core + pairing markers observed on $SIM_NAME ('$pair_line')" ;;
    "$PAIR_MARKER"*)
      die "SMOKE FAIL — pairing succeeded but wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *)
      die "SMOKE FAIL — pairing ingestion failed on-device: $pair_line" ;;
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
    $SIGN_FLAGS \
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
