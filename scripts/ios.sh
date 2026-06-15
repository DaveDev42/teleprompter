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
#                               boot+core markers; inject a tp://p?d=… deep link and verify
#                               the TP_PAIR_OK pairing marker (M1); then start a loopback
#                               relay and verify TP_RELAY_AUTH_OK frontend auth (M2)
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
# M2: relay connect + frontend auth. A local loopback relay (scripts/
# local-relay-loopback.ts) pre-seeds the golden token so the app's relay.auth
# (role=frontend) succeeds → TP_RELAY_AUTH_OK. The pairing link points the app at
# ws://localhost:$RELAY_LOOPBACK_PORT with the golden secret (0x00..0x1f).
RELAY_AUTH_OK_MARKER="TP_RELAY_AUTH_OK"
RELAY_AUTH_FAIL_MARKER="TP_RELAY_AUTH_FAIL"
RELAY_LOOPBACK_PORT="${TP_RELAY_LOOPBACK_PORT:-7099}"
RELAY_LOOPBACK_SCRIPT="$REPO_ROOT/scripts/local-relay-loopback.ts"
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
# smoke_pair_link <daemonId> [relayURL] [secretMode]
#   relayURL   "" → relay_len 0 (default relay); else embedded as the relay URL.
#   secretMode "ones" (default, ps=32×0x01) | "golden" (ps=0x00..0x1f, the
#              wire-vectors secret whose derive_relay_token matches the loopback's
#              seeded token a16760de…). pk is always 32×0x02.
smoke_pair_link() {
  /usr/bin/python3 -c '
import base64, sys
did = sys.argv[1]
relay = sys.argv[2] if len(sys.argv) > 2 else ""
secret_mode = sys.argv[3] if len(sys.argv) > 3 else "ones"
prefix = "daemon-"
wire_did = did[len(prefix):] if did.startswith(prefix) else did
ps = bytes(range(32)) if secret_mode == "golden" else bytes([0x01]) * 32
buf = bytearray()
buf += b"tp"                       # magic
buf.append(3)                       # version
buf.append(len(wire_did))          # did_len
buf += wire_did.encode()           # did
if relay:
    rb = relay.encode()
    buf.append(len(rb))            # relay_len
    buf += rb                       # relay url
else:
    buf.append(0)                   # relay_len = 0 → default relay
buf += ps                           # ps (32)
buf += bytes([0x02]) * 32          # pk (32)
b64 = base64.b64encode(bytes(buf)).decode()
b64url = b64.replace("+", "-").replace("/", "_").rstrip("=")
print(f"tp://p?d={b64url}")
' "$@"
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

  # M1 + M2 share ONE pairing deep link, mirroring the real flow: a single
  # tp://p?d=… both (M1) ingests offline → TP_PAIR_OK and (M2) drives the app's
  # auto-connect → relay.auth → TP_RELAY_AUTH_OK. The link points at a local
  # loopback relay (started here, golden secret so the FFI token matches the
  # pre-seeded one), so no prod relay is ever contacted. Bring the relay up
  # BEFORE injecting the link, since the app connects the instant it ingests.
  start_loopback

  # Golden secret + localhost relay so both the pairing ingest and the relay
  # auth target the loopback. did=$SMOKE_DAEMON_ID matches the seeded token's id.
  local link
  link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  log "opening pairing deep link (M1+M2) — want '$PAIR_MARKER did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  xcrun simctl openurl "$udid" "$link" >/dev/null

  # Poll for both the pairing marker (M1) and the relay-auth marker (M2).
  local pair_line="" auth_line=""
  for _ in $(seq 1 30); do
    local out
    out="$(xcrun simctl spawn "$udid" log show --last 30s --style compact \
            --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null)" || true
    pair_line="$(printf '%s\n' "$out" | grep -Eo 'TP_PAIR_(OK|FAIL)[^"]*' | tail -n1 || true)"
    auth_line="$(printf '%s\n' "$out" | grep -Eo "${RELAY_AUTH_OK_MARKER}[^\"]*|${RELAY_AUTH_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    if [ -n "$pair_line" ] && [ -n "$auth_line" ]; then break; fi
    sleep 0.5
  done

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL — pairing deep link opened but no '$PAIR_MARKER'/TP_PAIR_FAIL line (URL not routed to app?)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*) log "pairing OK (M1) — '$pair_line'" ;;
    "$PAIR_MARKER"*) die "SMOKE FAIL — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' line (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) log "relay auth OK (M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL — relay auth failed on-device: $auth_line" ;;
  esac

  # Relay-side confirmation: a frontend is now connected (clients >= 1).
  local clients
  clients="$(curl -s "http://localhost:$RELAY_LOOPBACK_PORT/health" \
              | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("clients",0))' 2>/dev/null || echo 0)"
  [ "${clients:-0}" -ge 1 ] || die "SMOKE FAIL — relay /health reports clients=$clients (expected >=1)"
  log "relay /health confirms clients=$clients"

  log "✅ SMOKE PASS — boot + core + pairing + relay-auth markers observed on $SIM_NAME"
}

# start_loopback — bring up the local seeded relay used by the M2 auth check and
# register cleanup so it always dies (RETURN is bypassed by `die`→exit, so trap
# EXIT too). Sets $LOOPBACK_PID for callers that want it.
start_loopback() {
  require bun
  [ -f "$RELAY_LOOPBACK_SCRIPT" ] || die "SMOKE FAIL — missing $RELAY_LOOPBACK_SCRIPT"

  # Reap any orphan relay still holding the port (a prior run that died before
  # its cleanup ran) so we always start fresh.
  lsof -nP -iTCP:"$RELAY_LOOPBACK_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true

  local lb_out; lb_out="$(mktemp -t tp-loopback.XXXXXX)"
  log "starting loopback relay on ws://localhost:$RELAY_LOOPBACK_PORT"
  RELAY_PORT="$RELAY_LOOPBACK_PORT" bun run "$RELAY_LOOPBACK_SCRIPT" >"$lb_out" 2>&1 &
  local lb_pid=$!
  trap 'kill "'"$lb_pid"'" 2>/dev/null || true; rm -f "'"$lb_out"'" 2>/dev/null || true' EXIT

  local ready=""
  for _ in $(seq 1 30); do
    kill -0 "$lb_pid" 2>/dev/null || die "SMOKE FAIL — loopback relay exited early: $(cat "$lb_out")"
    case "$(cat "$lb_out" 2>/dev/null)" in *"LOOPBACK_READY"*) ready="yes"; break ;; esac
    sleep 0.2
  done
  [ -n "$ready" ] || die "SMOKE FAIL — loopback relay never signalled LOOPBACK_READY: $(cat "$lb_out")"
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
