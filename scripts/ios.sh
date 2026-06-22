#!/usr/bin/env bash
# Teleprompter native app harness (ADR-0001 rewrite + ADR-0002 multiplatform).
#
# Drives the Swift multiplatform app (iOS/iPadOS/macOS/visionOS/watchOS) headlessly:
# generate project → build → install/launch → verify the 8 on-device markers (7 on
# watchOS — TP_INPUT_OK is excluded per ADR-0002 §watchOS), plus run the XCTest bundle.
# No Xcode GUI required.
# Platform = TP_PLATFORM (ios | ipad | macos | visionos | watchos).
#   "ipad" rides the iOS Simulator path with an iPad default device — same
#   iphonesimulator SDK + ios-arm64_x86_64-simulator slice (no new xcframework slice).
#
# Usage:
#   scripts/ios.sh gen          Regenerate Teleprompter.xcodeproj from project.yml
#   scripts/ios.sh rust         Build TpCore.xcframework + Swift bindings from rust/tp-core
#   scripts/ios.sh build        Build the app (for iOS Simulator by default, or macOS)
#   scripts/ios.sh run          Install + launch on the Simulator (ios) or open on macOS
#   scripts/ios.sh all          Run smoke on ALL 5 platforms; print a result matrix
#   scripts/ios.sh smoke        Full loop: rust → gen → build → install → launch → verify
#                               (TP_PLATFORM selects iOS Simulator / macOS / visionOS /
#                               watchOS Simulator)
#                               boot+core markers; inject a tp://p?d=… deep link and verify
#                               the TP_PAIR_OK pairing marker (M1); then start a loopback
#                               relay (+ fake daemon peer) and verify TP_RELAY_AUTH_OK
#                               frontend auth (M2), then TP_KX_OK + TP_FRAME_OK (M3 in-band
#                               kx + first decrypted hello frame).
#                               watchOS verifies 7 markers (TP_INPUT_OK intentionally absent).
#   scripts/ios.sh uitest       Run XCUITest UI-level E2E (TeleprompterUITests): launch with
#                               --tp-smoke-url, tap session row → pane picker, assert the
#                               rendered "Claude: smoke ok" bubble through the a11y tree.
#                               iOS/iPad/macOS full, visionOS partial, watchOS unsupported.
#   scripts/ios.sh test         Run the XCTest bundle on the Simulator (ios only; rust first)
#   scripts/ios.sh boot         Boot the target iOS Simulator (idempotent; ios only)
#
# Env:
#   TP_PLATFORM     Target platform: "ios" (default), "macos", "visionos", or "watchos".
#                   When unset or "ios", behaviour is byte-for-byte identical to
#                   the original harness. When "macos", builds for native macOS
#                   (NOT Catalyst), launches via `open`, and polls the HOST unified
#                   log instead of `xcrun simctl spawn`. When "visionos", builds
#                   for the visionOS Simulator (xrsimulator SDK), installs/launches
#                   via xcrun simctl, and polls the Simulator unified log.
#                   When "watchos", builds TeleprompterWatch for the watchOS Simulator
#                   (watchsimulator SDK), installs/launches via xcrun simctl, and verifies
#                   7 markers (TP_INPUT_OK absent — no terminal input on watch).
#   TP_SIM          iOS/iPad Simulator device name (default: "iPhone 17 Pro" for ios;
#                   "iPad Pro 13-inch (M5)" for ipad)
#   TP_VISION_SIM   visionOS Simulator device name (default: "Apple Vision Pro")
#   TP_WATCH_SIM    watchOS Simulator device name (default: "Apple Watch Series 11 (46mm)")
#   TP_SCHEME       Xcode scheme (default: "Teleprompter")
#   TP_SKIP_RUST    Set to 1 to skip xcframework rebuild (xcframework must exist)
#   TP_FORCE_RUST   Set to 1 to always rebuild xcframework even when present
#   TP_JSON         Set to 1 to emit a single-line JSON result as the last stdout
#                   line of a smoke run ({"platform","markers","passed","elapsed_s"})
#   TP_ARTIFACT_DIR Screenshot output directory (default: /tmp/tp-artifacts)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
PROJECT="$IOS_DIR/Teleprompter.xcodeproj"
DERIVED="$IOS_DIR/build/DerivedData"
SCHEME="${TP_SCHEME:-Teleprompter}"
SIM_NAME="${TP_SIM:-iPhone 17 Pro}"
VISION_SIM_NAME="${TP_VISION_SIM:-Apple Vision Pro}"
WATCH_SIM_NAME="${TP_WATCH_SIM:-Apple Watch Series 11 (46mm)}"
BUNDLE_ID="dev.tpmt.teleprompter"
WATCH_BUNDLE_ID="dev.tpmt.teleprompter.watch"
BOOT_MARKER="TP_BOOT_OK"
CORE_MARKER="TP_CORE_OK"
PAIR_MARKER="TP_PAIR_OK"
# Deterministic pairing deep link injected during smoke (M1 offline ingestion).
# Layout (pairing.rs v3): magic "tp" | ver 3 | did_len | did | relay_len(0=default)
# | ps(32×0x01) | pk(32×0x02); base64url-wrapped as tp://p?d=…
SMOKE_DAEMON_ID="daemon-smoketest"
# M4: the loopback's one fake session sid (must match FAKE_SESSIONS[0].sid in
# scripts/local-relay-loopback.ts). The app auto-attaches it and the daemon
# backfills one event record, driving TP_SESSION_OK sid=$SMOKE_SESSION_ID.
SMOKE_SESSION_ID="sess-smoketest"
# M2: relay connect + frontend auth. A local loopback relay (scripts/
# local-relay-loopback.ts) pre-seeds the golden token so the app's relay.auth
# (role=frontend) succeeds → TP_RELAY_AUTH_OK. The pairing link points the app at
# ws://localhost:$RELAY_LOOPBACK_PORT with the golden secret (0x00..0x1f).
RELAY_AUTH_OK_MARKER="TP_RELAY_AUTH_OK"
RELAY_AUTH_FAIL_MARKER="TP_RELAY_AUTH_FAIL"
# M3: in-band kx + first decrypted frame. The loopback now attaches a fake daemon
# peer (role=daemon) that does the kx handshake and pushes an encrypted `hello`
# session list, so the app reaches TP_KX_OK (session keys derived) then
# TP_FRAME_OK sessions=<n> (first hello frame decrypted + decoded).
KX_OK_MARKER="TP_KX_OK"
KX_FAIL_MARKER="TP_KX_FAIL"
FRAME_OK_MARKER="TP_FRAME_OK"
FRAME_FAIL_MARKER="TP_FRAME_FAIL"
# M4: live session render. After the hello, the app auto-attaches the first
# session (attach → state → resume → batch) and the loopback daemon replies with
# one synthetic event record, so the app reaches TP_SESSION_OK sid=<sid>
# events=<n> (>=1 hook event decoded + rendered as a chat item).
SESSION_OK_MARKER="TP_SESSION_OK"
SESSION_FAIL_MARKER="TP_SESSION_FAIL"
# M5: send input + terminal io tab. After the backfill, the app auto-sends an
# in.chat probe; the loopback daemon echoes it back as an io record; the app sees
# the probe bytes in the terminal stream and emits TP_INPUT_OK sid=<sid>.
INPUT_OK_MARKER="TP_INPUT_OK"
INPUT_FAIL_MARKER="TP_INPUT_FAIL"
RELAY_LOOPBACK_PORT="${TP_RELAY_LOOPBACK_PORT:-7099}"
RELAY_LOOPBACK_SCRIPT="$REPO_ROOT/scripts/local-relay-loopback.ts"
XCFRAMEWORK="$REPO_ROOT/rust/target/TpCore.xcframework"
# Ad-hoc sign Simulator/macOS local builds so entitlements embed —
# the Simulator Keychain rejects SecItemAdd without an entitlement (-34018).
# No developer identity needed; "-" is accepted by both Simulator and macOS local.
SIGN_FLAGS="CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES"

# Resolve the target platform (ios default = unchanged behaviour).
TP_PLATFORM="${TP_PLATFORM:-ios}"

# iPadOS rides the iOS Simulator code path (same iphonesimulator SDK, same
# ios-arm64_x86_64-simulator xcframework slice — no new slice). The ONLY
# differences are the default Simulator device (an iPad instead of an iPhone)
# and the platform label in artifacts/JSON. We collapse "ipad" → the iOS build/
# boot/smoke branches via $IOS_FAMILY, while keeping $TP_PLATFORM="ipad" for
# labelling. Setting the iPad default here (before $SIM_NAME is consumed) means
# `TP_SIM` still overrides it, exactly like the iPhone path.
if [ "$TP_PLATFORM" = "ipad" ]; then
  IOS_FAMILY="yes"
  # Default to the iPad Pro 13" (M5), which ships on a modern iOS 26.x runtime
  # (matching the iPhone default). cmd_build resolves this name to a single UDID
  # via sim_udid() and targets `id=…`, so even when the same model exists on two
  # runtimes (e.g. M5 on both 26.2 and 26.5) the destination stays unambiguous.
  # Override with TP_SIM for any other iPad.
  SIM_NAME="${TP_SIM:-iPad Pro 13-inch (M5)}"
elif [ "$TP_PLATFORM" = "ios" ]; then
  IOS_FAMILY="yes"
else
  IOS_FAMILY=""
fi

# Diagnostics go to stderr so `$(cmd_boot)` etc. capture only the clean stdout value.
log()  { printf '\033[1;34m[ios]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ios] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }

# ── Cleanup accumulator ────────────────────────────────────────────────────────
#
# bash keeps only ONE EXIT trap — each bare `trap '...' EXIT` clobbers the previous
# one. Several helpers need exit-time cleanup (loopback relay, macOS log stream, the
# launched macOS app instance). Without a single shared trap, the last helper to set
# its trap wins and the others' resources leak — that is exactly how macOS smoke runs
# left orphan Teleprompter windows piling up on the desktop.
#
# Register cleanup commands here instead of calling `trap '...' EXIT` directly. They
# run in LIFO order (most-recently-added first) on any exit: normal return, `die`→exit,
# or interrupt.
TP_CLEANUP_CMDS=()
tp_cleanup_add() { TP_CLEANUP_CMDS+=("$1"); }
tp_run_cleanup() {
  local i
  for (( i=${#TP_CLEANUP_CMDS[@]}-1; i>=0; i-- )); do
    eval "${TP_CLEANUP_CMDS[$i]}" || true
  done
}
trap 'tp_run_cleanup' EXIT

# ── Structured result (TP_JSON=1) ───────────────────────────────────────────────
#
# When TP_JSON=1, a smoke run emits ONE machine-readable line as the very last
# stdout line: {"platform":"ios","markers":{"TP_BOOT_OK":true,…},"passed":true,
# "elapsed_s":47}. Human/log output (all on stderr via log()/die()) is unchanged,
# so `… | tail -1 | jq` reads only the JSON.
#
# The emit fires from the EXIT trap so it is produced on BOTH success AND failure
# (a `die` mid-run still yields passed:false with whatever markers were seen).
# cmd_all consumes these lines to build the 5-platform matrix.
TP_SMOKE_PLATFORM=""          # set by tp_smoke_begin; empty = no smoke ran (skip emit)
TP_SMOKE_START=0
TP_SMOKE_PASSED=0             # flipped to 1 only when a smoke fn reaches its success tail
declare -a TP_SMOKE_MARKER_NAMES=()
declare -a TP_SMOKE_MARKER_STATES=()   # parallel array of 0/1, indexed with names

tp_now() { date +%s; }

# Begin tracking a smoke run for $1 platform with the marker name list $2.. .
tp_smoke_begin() {
  TP_SMOKE_PLATFORM="$1"; shift
  TP_SMOKE_START="$(tp_now)"
  TP_SMOKE_PASSED=0
  TP_SMOKE_MARKER_NAMES=("$@")
  TP_SMOKE_MARKER_STATES=()
  local _; for _ in "$@"; do TP_SMOKE_MARKER_STATES+=("0"); done
}

# Record marker $1 as seen (state 1). No-op if the name wasn't registered.
tp_mark() {
  local name="$1" i
  for i in "${!TP_SMOKE_MARKER_NAMES[@]}"; do
    if [ "${TP_SMOKE_MARKER_NAMES[$i]}" = "$name" ]; then
      TP_SMOKE_MARKER_STATES[$i]=1; return
    fi
  done
}

tp_smoke_pass() { TP_SMOKE_PASSED=1; }

# Emit the JSON result line (stdout). Registered on the EXIT trap so it runs on
# any exit path once a smoke has begun.
tp_smoke_emit() {
  [ "${TP_JSON:-}" = "1" ] || return 0
  [ -n "$TP_SMOKE_PLATFORM" ] || return 0
  local elapsed=$(( $(tp_now) - TP_SMOKE_START ))
  local markers="" i
  for i in "${!TP_SMOKE_MARKER_NAMES[@]}"; do
    local v="false"; [ "${TP_SMOKE_MARKER_STATES[$i]}" = "1" ] && v="true"
    [ -n "$markers" ] && markers+=","
    markers+="\"${TP_SMOKE_MARKER_NAMES[$i]}\":$v"
  done
  local passed="false"; [ "$TP_SMOKE_PASSED" = "1" ] && passed="true"
  printf '{"platform":"%s","markers":{%s},"passed":%s,"elapsed_s":%d}\n' \
    "$TP_SMOKE_PLATFORM" "$markers" "$passed" "$elapsed"
  # Clear so a re-entrant cmd_all loop doesn't double-emit a stale platform.
  TP_SMOKE_PLATFORM=""
}
tp_cleanup_add 'tp_smoke_emit'

# Resolve the UDID for $SIM_NAME among available iOS Simulator devices.
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

# Resolve the UDID for $VISION_SIM_NAME among available visionOS Simulator devices.
# Prefers the device with the highest runtime version (xrOS-26-5 > xrOS-26-2) so
# that the build targets the same runtime version as the installed SDK when multiple
# devices share the same name.
vision_sim_udid() {
  xcrun simctl list devices available -j \
    | /usr/bin/python3 -c '
import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)
best_udid=""
best_rt=""
for runtime,devs in d["devices"].items():
    if "xr" not in runtime.lower() and "vision" not in runtime.lower():
        continue
    for dev in devs:
        if dev.get("isAvailable") and dev["name"]==name:
            if runtime > best_rt:
                best_rt=runtime; best_udid=dev["udid"]
if best_udid: print(best_udid); sys.exit(0)
sys.exit(1)
' "$VISION_SIM_NAME"
}

# Resolve the UDID for $WATCH_SIM_NAME among available watchOS Simulator devices.
# Prefers the device with the highest runtime version, mirroring vision_sim_udid().
watch_sim_udid() {
  xcrun simctl list devices available -j \
    | /usr/bin/python3 -c '
import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)
best_udid=""
best_rt=""
for runtime,devs in d["devices"].items():
    if "watch" not in runtime.lower():
        continue
    for dev in devs:
        if dev.get("isAvailable") and dev["name"]==name:
            if runtime > best_rt:
                best_rt=runtime; best_udid=dev["udid"]
if best_udid: print(best_udid); sys.exit(0)
sys.exit(1)
' "$WATCH_SIM_NAME"
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
# workaround, the iOS slices, the macOS fat slice, and binding generation.
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

# ── iOS-specific helpers ──────────────────────────────────────────────────────

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

# ── Build ─────────────────────────────────────────────────────────────────────

cmd_build() {
  require xcodebuild
  ensure_xcframework
  ensure_project
  if [ "$TP_PLATFORM" = "macos" ]; then
    log "building $SCHEME for native macOS (NOT Catalyst)"
    # macOS ad-hoc signing: keychain-access-groups requires a real certificate on
    # macOS native (unlike iOS Simulator where ad-hoc works). Clear the entitlements
    # so the local dev build signs without them — Keychain access just falls back to
    # the default (unsigned items). For App Store/Developer ID distribution, sign
    # with a real certificate and Teleprompter-macOS.entitlements instead.
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination 'platform=macOS' \
      -derivedDataPath "$DERIVED" \
      $SIGN_FLAGS \
      CODE_SIGN_ENTITLEMENTS="" \
      build | xcbeautify_or_cat
  elif [ "$TP_PLATFORM" = "visionos" ]; then
    log "building $SCHEME for visionOS Simulator ($VISION_SIM_NAME)"
    local vision_udid; vision_udid="$(vision_sim_udid)" \
      || die "visionOS simulator not found: $VISION_SIM_NAME (set TP_VISION_SIM)"
    # Use UDID-based destination: name-based fails when multiple devices share the
    # same name (e.g. both xrOS-26.2 and xrOS-26.5 devices named "Apple Vision Pro").
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$vision_udid" \
      -derivedDataPath "$DERIVED" \
      $SIGN_FLAGS \
      build | xcbeautify_or_cat
  elif [ "$TP_PLATFORM" = "watchos" ]; then
    log "building TeleprompterWatch for watchOS Simulator ($WATCH_SIM_NAME)"
    # watchOS Simulator: use -target (not -scheme) with the watchsimulator SDK to
    # bypass destination-matching, which fails when a real watch is paired (Xcode
    # tries the device first and rejects it because watchOS 26.5 device software
    # isn't installed). ARCHS=arm64 + ONLY_ACTIVE_ARCH=YES ensures the arm64
    # watchOS Simulator slice of TpCore.xcframework is linked (not x86_64).
    # -derivedDataPath cannot be used with -target; use SYMROOT/OBJROOT instead
    # to place build products in the same DerivedData tree as other platforms.
    xcodebuild \
      -project "$PROJECT" \
      -target TeleprompterWatch \
      -configuration Debug \
      -sdk watchsimulator26.5 \
      $SIGN_FLAGS \
      ARCHS=arm64 \
      ONLY_ACTIVE_ARCH=YES \
      SYMROOT="$DERIVED/Build/Products" \
      OBJROOT="$DERIVED/Build/Intermediates.noindex" \
      build | xcbeautify_or_cat
  else
    # iOS family (TP_PLATFORM=ios or ipad) — same iphonesimulator SDK; the only
    # difference is $SIM_NAME (iPhone vs iPad), set in the config block.
    #
    # Target the resolved UDID, NOT `name=$SIM_NAME`. A device NAME can be
    # ambiguous when the same model exists on two installed runtimes (e.g. two
    # "iPad Pro 13-inch (M5)" sims, one on iOS 26.2 and one on 26.5) — xcodebuild
    # then can't resolve a unique destination and the build fails. sim_udid()
    # picks one deterministically, and boot/install/launch use the same UDID, so
    # build+run always agree on a single device.
    local udid; udid="$(sim_udid)" \
      || die "iOS Simulator not found: $SIM_NAME (set TP_SIM)"
    log "building $SCHEME for iOS Simulator ($SIM_NAME — $udid)"
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath "$DERIVED" \
      $SIGN_FLAGS \
      build | xcbeautify_or_cat
  fi
}

# Pretty-print xcodebuild output if xcbeautify exists, else pass through.
xcbeautify_or_cat() {
  if command -v xcbeautify >/dev/null 2>&1; then xcbeautify; else cat; fi
}

# iOS app product path (for simctl install).
ios_app_path() {
  local p="$DERIVED/Build/Products/Debug-iphonesimulator/Teleprompter.app"
  [ -d "$p" ] || die "app not built yet: $p (run: scripts/ios.sh build)"
  echo "$p"
}

# macOS app product path (no SDK suffix for native macOS destination).
macos_app_path() {
  local p="$DERIVED/Build/Products/Debug/Teleprompter.app"
  [ -d "$p" ] || die "macOS app not built yet: $p (run: TP_PLATFORM=macos scripts/ios.sh build)"
  echo "$p"
}

# visionOS Simulator app product path.
visionos_app_path() {
  local p="$DERIVED/Build/Products/Debug-xrsimulator/Teleprompter.app"
  [ -d "$p" ] || die "visionOS app not built yet: $p (run: TP_PLATFORM=visionos scripts/ios.sh build)"
  echo "$p"
}

# watchOS Simulator app product path.
# NOTE: -target builds go into $DERIVED/Build/Products/ (not DerivedDataPath sub-path).
# When -derivedDataPath is set, products land in $DERIVED/Build/Products/Debug-watchsimulator/.
watchos_app_path() {
  local p="$DERIVED/Build/Products/Debug-watchsimulator/TeleprompterWatch.app"
  [ -d "$p" ] || die "watchOS app not built yet: $p (run: TP_PLATFORM=watchos scripts/ios.sh build)"
  echo "$p"
}

cmd_run() {
  if [ "$TP_PLATFORM" = "macos" ]; then
    local app; app="$(macos_app_path)"
    log "opening $app (macOS)"
    open "$app"
  elif [ "$TP_PLATFORM" = "visionos" ]; then
    local udid; udid="$(vision_sim_udid)" || die "visionOS simulator not found: $VISION_SIM_NAME (set TP_VISION_SIM)"
    local state
    state="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev.get("state","unknown")); sys.exit(0)
sys.exit(0)
' "$udid")"
    if [ "$state" != "Booted" ]; then
      log "booting $VISION_SIM_NAME ($udid)"
      xcrun simctl boot "$udid"
    else
      log "$VISION_SIM_NAME already booted ($udid)"
    fi
    local app; app="$(visionos_app_path)"
    log "installing $app on visionOS Simulator"
    xcrun simctl install "$udid" "$app"
    log "launching $BUNDLE_ID on visionOS Simulator"
    xcrun simctl launch "$udid" "$BUNDLE_ID"
  else
    local udid; udid="$(cmd_boot)"
    local app; app="$(ios_app_path)"
    log "installing $app"
    xcrun simctl install "$udid" "$app"
    log "launching $BUNDLE_ID"
    xcrun simctl launch "$udid" "$BUNDLE_ID"
  fi
}

# ── Log polling helpers ────────────────────────────────────────────────────────

# ios_log_snapshot — capture recent simulator log for our subsystem.
ios_log_snapshot() {
  local udid="$1" secs="$2"
  xcrun simctl spawn "$udid" log show --last "${secs}s" --style compact \
    --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null || true
}

# macos_log_snapshot — return lines captured so far from $MACOS_LOG_FILE.
# macOS `log show --last Ns` drops Default-level messages from app bundles
# (historical compression). We instead stream live via `log stream` (started
# before launch) into a tmp file and poll the file. No argument needed.
macos_log_snapshot() {
  cat "${MACOS_LOG_FILE:-/dev/null}" 2>/dev/null || true
}

# start_macos_log_stream — start `log stream` for our subsystem into $MACOS_LOG_FILE.
# Must be called before launching the app. The stream process is cleaned up via
# the EXIT trap (merged with start_loopback's trap).
# NOTE: use /usr/bin/log explicitly — there is a bash log() function in this script
# that would shadow the `log` command if called without the full path.
MACOS_LOG_FILE=""
start_macos_log_stream() {
  MACOS_LOG_FILE="$(mktemp -t tp-macos-log.XXXXXX)"
  /usr/bin/log stream --debug --info \
    --predicate "subsystem == \"$BUNDLE_ID\"" \
    > "$MACOS_LOG_FILE" 2>/dev/null &
  MACOS_LOG_PID=$!
  # Register cleanup via the shared accumulator (a bare `trap ... EXIT` would clobber
  # start_loopback's trap and the app-kill, leaking the relay/app on exit).
  tp_cleanup_add 'kill "${MACOS_LOG_PID:-}" 2>/dev/null || true; rm -f "${MACOS_LOG_FILE:-}" 2>/dev/null || true'
  # Give the stream a moment to start up before the app launches.
  sleep 0.3
}

# ── Artifacts (screenshots/video) ───────────────────────────────────────────────
#
# Visual-regression artifacts land in $TP_ARTIFACT_DIR (default /tmp/tp-artifacts).
# Screenshots work on EVERY platform's Simulator — including watchOS/visionOS where
# UI automation (XCUITest) does not — so this is the only visual signal we get there.
TP_ARTIFACT_DIR="${TP_ARTIFACT_DIR:-/tmp/tp-artifacts}"

# Capture a Simulator screenshot for the given UDID + platform label. Best-effort:
# a capture failure never fails the smoke (artifacts are diagnostic, not a gate).
capture_sim_screenshot() {
  local udid="$1" platform="$2"
  mkdir -p "$TP_ARTIFACT_DIR" 2>/dev/null || return 0
  local out="$TP_ARTIFACT_DIR/smoke-${platform}.png"
  if xcrun simctl io "$udid" screenshot "$out" >/dev/null 2>&1; then
    log "📸 screenshot → $out"
  else
    log "screenshot capture skipped (simctl io failed — non-fatal)"
  fi
}

# Capture the focused macOS app window (native macOS has no `simctl io`).
# Uses `screencapture -x` (no shutter sound). Best-effort.
capture_macos_screenshot() {
  local platform="$1"
  mkdir -p "$TP_ARTIFACT_DIR" 2>/dev/null || return 0
  local out="$TP_ARTIFACT_DIR/smoke-${platform}.png"
  if screencapture -x "$out" >/dev/null 2>&1; then
    log "📸 screenshot → $out"
  else
    log "screenshot capture skipped (screencapture failed — non-fatal)"
  fi
}

# ── Smoke ─────────────────────────────────────────────────────────────────────

cmd_smoke() {
  ensure_xcframework
  cmd_gen
  cmd_build

  if [ "$TP_PLATFORM" = "macos" ]; then
    cmd_smoke_macos
  elif [ "$TP_PLATFORM" = "visionos" ]; then
    cmd_smoke_visionos
  elif [ "$TP_PLATFORM" = "watchos" ]; then
    cmd_smoke_watchos
  else
    cmd_smoke_ios
  fi
}

cmd_smoke_ios() {
  # TP_E2E_REAL=1 swaps the fake loopback for a genuine `tp` daemon+relay. The real
  # daemon serves an empty hello (no sessions) and has no PTY, so this mode asserts
  # M0–M2 (boot/core/pair/relay-auth) — the deterministic reach of a real headless
  # daemon E2E. kx/frame/session/input depend on a pre-seeded session + careful
  # daemon-side sequencing the fake loopback provides but a real daemon does not
  # (see start_real_daemon_relay / native-testing.md).
  # Four modes, in increasing reach:
  #   loopback  (default)      — fake scripted daemon, all 8 markers (M0–M5).
  #   real_e2e  (TP_E2E_REAL)  — real tp daemon+relay, no session: M0–M2 (4 markers).
  #   claude_e2e(TP_E2E_CLAUDE)— real daemon + a REAL `claude -p` PRINT session spawned
  #                            pre-pairing: M0–M4 (7 markers). Print mode ends after one
  #                            Stop, so the input round-trip (M5) is impossible here.
  #                            Implies real_e2e (strict superset of the real path).
  #   claude_m5 (TP_E2E_CLAUDE_M5)— real daemon + a REAL INTERACTIVE claude session
  #                            (`--permission-mode bypassPermissions`, no `-p`): all 8
  #                            markers (M0–M5). The holder accepts claude's trust-folder
  #                            prompt (one `\r` over IPC), leaving claude idle at the
  #                            REPL; then the APP's auto-probe (in.chat over the relay)
  #                            submits a real prompt, claude responds, and a NEW assistant
  #                            Stop chat item drives TP_INPUT_OK. Strict superset of
  #                            claude_e2e (proves the genuine app→relay→daemon→PTY→claude
  #                            input path end to end). See native-testing.md.
  local real_e2e="" claude_e2e="" claude_m5=""
  [ "${TP_E2E_REAL:-}" = "1" ] && real_e2e="yes"
  [ "${TP_E2E_CLAUDE:-}" = "1" ] && { real_e2e="yes"; claude_e2e="yes"; }
  [ "${TP_E2E_CLAUDE_M5:-}" = "1" ] && { real_e2e="yes"; claude_e2e="yes"; claude_m5="yes"; }

  if [ -n "$claude_m5" ]; then
    # M0–M5: full input round-trip against an interactive real claude.
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  elif [ -n "$claude_e2e" ]; then
    # M0–M4: boot+core, pairing, relay-auth, kx, first-frame, session-render.
    # No M5 (input round-trip) — print mode ends before input arrives (use M5 mode).
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  elif [ -n "$real_e2e" ]; then
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER"
  else
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  fi

  # In claude mode, extract the real Claude Code OAuth token from the macOS keychain
  # and export it: the isolated daemon runs under a temp HOME with no credentials of
  # its own, so this env is the ONLY auth vector for the spawned claude. The keychain
  # service is `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>`.
  if [ -n "$claude_e2e" ]; then
    require claude
    local real_cfg svc
    real_cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    svc="Claude Code-credentials-$(printf %s "$real_cfg" | shasum -a 256 | cut -c1-8)"
    # Refresh the OAuth token BEFORE extracting it. The keychain access token expires
    # (~8h); a stale one yields a 401 in the spawned session (claude reaches the REPL,
    # the prompt submits, but the API call fails → StopFailure, never Stop → M4/M5 fail).
    # Running real claude once in print mode against the real config dir refreshes the
    # access token (via the stored refresh token) AND persists it back to the keychain,
    # so the extraction below picks up a fresh one. Cheap, deterministic, idempotent.
    log "refreshing Claude OAuth token (one print-mode call against CLAUDE_CONFIG_DIR=$real_cfg)…"
    CLAUDE_CONFIG_DIR="$real_cfg" timeout 60 claude -p "Reply with exactly: OK" \
      --dangerously-skip-permissions >/dev/null 2>&1 \
      || log "WARN — token-refresh print call did not exit clean; proceeding with whatever is in the keychain"
    local tok
    tok="$(security find-generic-password -s "$svc" -w 2>/dev/null \
      | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])' 2>/dev/null || true)"
    [ -n "$tok" ] \
      || die "E2E_CLAUDE FAIL — could not extract OAuth token from keychain service '$svc' (is Claude Code logged in for CLAUDE_CONFIG_DIR=$real_cfg?)"
    export CLAUDE_CODE_OAUTH_TOKEN="$tok"
    log "extracted Claude OAuth token from keychain (service '$svc') — injecting into isolated daemon"
  fi
  local udid; udid="$(cmd_boot)"
  local app; app="$(ios_app_path)"
  # Uninstall first so each smoke run starts from a clean app container: this
  # clears UserDefaults (the device-local `frontendId` + the saved `daemonIds`
  # that drive boot-time auto-reconnect). Without it, a prior run's saved pairing
  # makes the app auto-reconnect to the *previous* run's now-dead loopback before
  # the fresh deep link re-ingests, polluting the markers. (The iCloud-synced
  # pairing *secret* survives uninstall by design — but it is the same golden
  # secret every run and is re-ingested by the deep link, so isolation holds.)
  log "uninstalling (clean container for test isolation)"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "installing"
  xcrun simctl install "$udid" "$app"

  # M1 + M2 share ONE pairing deep link, mirroring the real flow: a single
  # tp://p?d=… both (M1) ingests offline → TP_PAIR_OK and (M2) drives the app's
  # auto-connect → relay.auth → TP_RELAY_AUTH_OK. The link points at a local
  # loopback relay, so no prod relay is ever contacted.
  #
  # Bring the loopback relay up BEFORE launching the app: the app connects the
  # instant the pairing is ingested in onAppear.
  #
  # We pass the link as --tp-smoke-url <link> launch argument instead of using
  # `xcrun simctl openurl`. This bypasses LaunchServices URL-scheme approval
  # routing, which started blocking ad-hoc-signed sideloaded apps on iOS 26.5
  # Simulator (lsd error -10814 "Error fetching bundle record for scheme
  # approval"). The TeleprompterApp reads --tp-smoke-url in its onAppear and
  # calls DeepLinkHandler.handle() directly, producing the same M1 marker.
  # Link source: the REAL daemon path pairs over IPC and hands back a tp://p?d=…
  # whose embedded daemonId is dynamic; the loopback path builds a golden link with
  # the fixed $SMOKE_DAEMON_ID. In real mode we re-point $SMOKE_DAEMON_ID at the
  # real id so the did= / daemon= marker assertions below match.
  local link
  if [ -n "$real_e2e" ]; then
    # Pass the claude flag through a global the function reads (it spawns a real
    # claude session post-pairing and reports its sid back via $REAL_SESSION_SID).
    REAL_SPAWN_CLAUDE="$claude_e2e"
    REAL_SPAWN_CLAUDE_M5="$claude_m5"
    start_real_daemon_relay
    link="$REAL_PAIR_LINK"
    SMOKE_DAEMON_ID="$REAL_DAEMON_ID"
    # In claude mode the spawned session has a fixed sid; the M4 (TP_SESSION_OK)
    # assertion keys on $SMOKE_SESSION_ID, so re-point it at the real session sid.
    if [ -n "$claude_e2e" ] && [ -n "${REAL_SESSION_SID:-}" ]; then
      SMOKE_SESSION_ID="$REAL_SESSION_SID"
      log "claude session sid=$SMOKE_SESSION_ID (M4 assertion re-pointed)"
    fi
  else
    start_loopback
    link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  fi

  # Terminate any prior instance before launching with the URL arg.
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$PAIR_MARKER did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  xcrun simctl launch "$udid" "$BUNDLE_ID" -- --tp-smoke-url "$link" >/dev/null

  # Poll for ALL markers in one loop: boot+core (M0) + pairing (M1) + relay-auth
  # (M2) + kx + first-frame (M3) + session-render (M4) + input round-trip (M5).
  # Since we launch with --tp-smoke-url, the boot/core markers and the pairing
  # markers are both emitted in the same process run.
  # The real-daemon path adds connection latency (the daemon may retry auth.resume
  # against any stale saved relay before the fresh deep-link pairing lands), so it
  # gets a wider log window and more poll iterations. It also prefers the *_OK
  # marker over a co-present *_FAIL (a stale-resume FAIL can sit alongside the real
  # OK in the same window — see TP_RELAY_AUTH_FAIL from a dead prior relay).
  local snap_secs=60 poll_iters=60
  if [ -n "$real_e2e" ]; then snap_secs=240; poll_iters=120; fi
  # Real claude cold-start + first Stop hook can take 10s+ on top of the daemon
  # connect latency; give the claude path a wider window than M0–M2-only real mode.
  if [ -n "$claude_e2e" ]; then snap_secs=300; poll_iters=150; fi
  # Prefer an OK line; fall back to the last OK|FAIL only if no OK is present.
  prefer_ok() { # <text> <ok-marker> <fail-marker>
    local ok; ok="$(printf '%s\n' "$1" | grep -Eo "$2[^\"]*" | tail -n1 || true)"
    if [ -n "$ok" ]; then printf '%s' "$ok"; else
      printf '%s\n' "$1" | grep -Eo "$2[^\"]*|$3[^\"]*" | tail -n1 || true
    fi
  }
  local boot_seen="" core_line="" pair_line="" auth_line="" kx_line="" frame_line="" session_line="" input_line=""
  for _ in $(seq 1 "$poll_iters"); do
    local out
    out="$(ios_log_snapshot "$udid" "$snap_secs")"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(prefer_ok "$out" 'TP_CORE_OK' 'TP_CORE_FAIL')"
    pair_line="$(prefer_ok "$out" 'TP_PAIR_OK' 'TP_PAIR_FAIL')"
    auth_line="$(prefer_ok "$out" "$RELAY_AUTH_OK_MARKER" "$RELAY_AUTH_FAIL_MARKER")"
    kx_line="$(prefer_ok "$out" "$KX_OK_MARKER" "$KX_FAIL_MARKER")"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(printf '%s\n' "$out" | grep -Eo "${SESSION_OK_MARKER}[^\"]*|${SESSION_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    input_line="$(printf '%s\n' "$out" | grep -Eo "${INPUT_OK_MARKER}[^\"]*|${INPUT_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    if [ -n "$claude_m5" ]; then
      # Real daemon + a real INTERACTIVE claude session: reach M5 (all 8 markers).
      # The app's relayed probe submits a prompt to the idle REPL, claude responds,
      # and a NEW assistant Stop chat item drives TP_INPUT_OK. Must wait for the
      # input line too — otherwise the loop breaks at M4 before M5 can fire.
      if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ]; then break; fi
    elif [ -n "$claude_e2e" ]; then
      # Real daemon + a real claude print-mode session: reach M4 (boot + core +
      # pairing + relay-auth + kx + first-frame + session-render). The spawned
      # session gives the daemon a non-empty hello to push, so kx/frame/session
      # now flow (unlike M0–M2-only real mode). No M5 here — input round-trip
      # needs the interactive session (TP_E2E_CLAUDE_M5).
      if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ]; then break; fi
    elif [ -n "$real_e2e" ]; then
      # Real daemon: deterministically reaches M2 (boot + core + pairing +
      # relay-auth against a genuine tp daemon that self-registered with a real
      # relay). M3 (kx) is best-effort here — with no pre-seeded session the daemon
      # has nothing to push, and a real daemon's kx-pubkey broadcast can race the
      # frontend's own kx completion ("relay.frame before kx — dropping"), so we do
      # NOT gate on kx. The genuine daemon→relay→app AUTH pipeline is the assertion.
      if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ]; then break; fi
    else
      if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ]; then break; fi
    fi
    sleep 0.5
  done

  # M0 assertions.
  [ -n "$boot_seen" ] || die "SMOKE FAIL — boot marker '$BOOT_MARKER' not seen in Simulator log"
  tp_mark "$BOOT_MARKER"
  [ -n "$core_line" ] || die "SMOKE FAIL — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) tp_mark "$CORE_MARKER"; log "core OK — '$core_line'" ;;
    *) die "SMOKE FAIL — tp-core round-trip failed on-device: $core_line" ;;
  esac

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL — --tp-smoke-url injected but no '$PAIR_MARKER'/TP_PAIR_FAIL line (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*) tp_mark "$PAIR_MARKER"; log "pairing OK (M1) — '$pair_line'" ;;
    "$PAIR_MARKER"*) die "SMOKE FAIL — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' line (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL — relay auth failed on-device: $auth_line" ;;
  esac

  # ── REAL daemon E2E (NO spawned session) stops here (M0–M2). The genuine
  # daemon→relay→app AUTH pipeline is proven end to end: boot + tp-core FFI +
  # pairing ingest + relay frontend-auth all succeeded against a real `tp` daemon
  # that self-registered with a REAL relay (the daemon is the relay's only outbound
  # client; the app reaches it only through the relay; the relay forwards ciphertext
  # only — all invariants intact). kx / frame / session are out of scope WITHOUT a
  # session: the real daemon has no pre-seeded session to push and its kx-pubkey
  # broadcast can race the frontend's own kx completion. Full M3–M4 → claude mode
  # (TP_E2E_CLAUDE, which spawns a real session and falls through below); full M5 →
  # loopback mode or an interactive claude session.
  if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
    capture_sim_screenshot "$udid" "$TP_PLATFORM"
    tp_smoke_pass
    log "✅ REAL-DAEMON E2E PASS — boot + core + pairing + relay-auth against a real tp daemon (id=$SMOKE_DAEMON_ID) + real relay (M3–M5 out of scope headless)"
    return 0
  fi

  # M3 assertion — in-band kx: the frontend derived per-frontend session keys.
  [ -n "$kx_line" ] || die "SMOKE FAIL — relay auth OK but no '$KX_OK_MARKER'/'$KX_FAIL_MARKER' line (kx never ran?)"
  case "$kx_line" in
    "$KX_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$KX_OK_MARKER"; log "kx OK (M3) — '$kx_line'" ;;
    "$KX_OK_MARKER"*) die "SMOKE FAIL — kx wrong daemon: $kx_line" ;;
    *) die "SMOKE FAIL — kx failed on-device: $kx_line" ;;
  esac

  # M3 assertion — first decrypted frame: the daemon's `hello` session list
  # decrypted with the frontend rx key and decoded. sessions=<n> must be >= 1
  # (the loopback fake daemon seeds one session) to prove non-empty rendering.
  [ -n "$frame_line" ] || die "SMOKE FAIL — kx OK but no '$FRAME_OK_MARKER'/'$FRAME_FAIL_MARKER' line (hello never decrypted?)"
  case "$frame_line" in
    "$FRAME_OK_MARKER sessions="*)
      local n="${frame_line#"$FRAME_OK_MARKER" sessions=}"
      n="${n%% *}"
      [ "${n:-0}" -ge 1 ] || die "SMOKE FAIL — hello decrypted but sessions=$n (expected >=1)"
      tp_mark "$FRAME_OK_MARKER"; log "frame OK (M3) — '$frame_line'"
      ;;
    *) die "SMOKE FAIL — first frame decrypt/decode failed on-device: $frame_line" ;;
  esac

  # M4 assertion — live session render: the app auto-attached the first session
  # (attach → state → resume → batch) and rendered >= 1 hook event as a chat
  # item. events=<n> must be >= 1 (the loopback daemon returns one synthetic Stop
  # event record on resume) to prove the full backfill + decode + render path.
  [ -n "$session_line" ] || die "SMOKE FAIL — frame OK but no '$SESSION_OK_MARKER'/'$SESSION_FAIL_MARKER' line (attach/resume never ran?)"
  case "$session_line" in
    "$SESSION_OK_MARKER sid=$SMOKE_SESSION_ID events="*)
      local ev="${session_line#"$SESSION_OK_MARKER" sid="$SMOKE_SESSION_ID" events=}"
      ev="${ev%% *}"
      [ "${ev:-0}" -ge 1 ] || die "SMOKE FAIL — session attached but events=$ev (expected >=1)"
      tp_mark "$SESSION_OK_MARKER"; log "session OK (M4) — '$session_line'"
      ;;
    "$SESSION_OK_MARKER"*) die "SMOKE FAIL — session render wrong sid: $session_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL — session attach/backfill failed on-device: $session_line" ;;
  esac

  # ── REAL claude PRINT E2E (TP_E2E_CLAUDE, NOT M5) stops here (M0–M4). A real
  # `claude -p` session was spawned against the isolated daemon pre-pairing; the app
  # auto-attached and rendered the real Stop hook's last_assistant_message (events>=1
  # above — a genuine non-empty assistant response flowed daemon→relay→app and rendered
  # as a ChatItem). That is the headline dogfood proof. M5 (input round-trip) needs an
  # INTERACTIVE claude (print mode exits before the probe arrives) — that is the
  # TP_E2E_CLAUDE_M5 mode, which does NOT return here and continues to the M5 assertion
  # below. The loopback /health clients>=2 check further down is loopback-only
  # ($RELAY_LOOPBACK_PORT is not bound in real mode), so claude modes skip it too.
  if [ -n "$claude_e2e" ] && [ -z "$claude_m5" ]; then
    capture_sim_screenshot "$udid" "$TP_PLATFORM"
    tp_smoke_pass
    log "✅ REAL-CLAUDE E2E PASS — boot + core + pairing + relay-auth + kx + first-frame + real-Stop session-render (sid=$SMOKE_SESSION_ID) against a real tp daemon + real claude (M5 input round-trip out of scope for print mode)"
    return 0
  fi

  # M5 assertion — input round-trip.
  #   loopback : the app auto-sent an in.chat probe, the loopback daemon echoed it back
  #              as an io record, and the app saw the probe bytes in the terminal stream
  #              (TP_INPUT_OK proof=echo).
  #   claude_m5: the app's relayed probe submitted a real prompt to the interactive
  #              claude (the holder accepted the trust prompt), claude responded, and a
  #              NEW assistant Stop chat item appeared (TP_INPUT_OK proof=response). Same
  #              marker, same sid assertion — proves the genuine app→relay→daemon→PTY→
  #              claude input path end to end.
  [ -n "$input_line" ] || die "SMOKE FAIL — session OK but no '$INPUT_OK_MARKER'/'$INPUT_FAIL_MARKER' line (input never sent/echoed?)"
  case "$input_line" in
    "$INPUT_OK_MARKER sid=$SMOKE_SESSION_ID"*) tp_mark "$INPUT_OK_MARKER"; log "input OK (M5) — '$input_line'" ;;
    "$INPUT_OK_MARKER"*) die "SMOKE FAIL — input round-trip wrong sid: $input_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL — input send/echo failed on-device: $input_line" ;;
  esac

  # claude_m5 has no loopback /health to check (real relay), so finish here with the
  # full 8-marker pass once M5 is confirmed.
  if [ -n "$claude_m5" ]; then
    capture_sim_screenshot "$udid" "$TP_PLATFORM"
    tp_smoke_pass
    log "✅ REAL-CLAUDE M5 E2E PASS — all 8 markers (M0–M5) against a real tp daemon + real INTERACTIVE claude: input round-trip (app→relay→daemon→PTY→claude→Stop→ChatItem) proven on-device (sid=$SMOKE_SESSION_ID)"
    return 0
  fi

  # Relay-side confirmation: both the frontend and the fake daemon are connected
  # (clients >= 2 with the M3 loopback daemon peer).
  local clients
  clients="$(curl -s "http://localhost:$RELAY_LOOPBACK_PORT/health" \
              | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("clients",0))' 2>/dev/null || echo 0)"
  [ "${clients:-0}" -ge 2 ] || die "SMOKE FAIL — relay /health reports clients=$clients (expected >=2: app + fake daemon)"
  log "relay /health confirms clients=$clients"

  capture_sim_screenshot "$udid" "$TP_PLATFORM"
  tp_smoke_pass
  log "✅ SMOKE PASS — boot + core + pairing + relay-auth + kx + first-frame + session-render + input-roundtrip markers observed on $SIM_NAME"
}

cmd_smoke_macos() {
  tp_smoke_begin "macos" \
    "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
    "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  local app; app="$(macos_app_path)"

  # Kill any prior macOS instance so each smoke run starts fresh. Use -KILL to
  # ensure the process doesn't survive a SIGTERM grace period, then wait for the
  # kernel to reap it before launching fresh (avoids `open` waking the old instance
  # via macOS AppKit single-instance behaviour).
  log "killing any prior macOS Teleprompter instance"
  pkill -9 -x Teleprompter 2>/dev/null || true
  local wait_count=0
  while pgrep -x Teleprompter >/dev/null 2>&1; do
    sleep 0.2; (( wait_count++ )); [ "$wait_count" -lt 20 ] || break
  done
  sleep 0.3  # extra buffer for AppKit deregistration

  # Clean macOS Keychain entries from prior smoke runs. On macOS, a rebuild changes
  # the app's code signature, so previously written Keychain items (keyed to the old
  # code hash) trigger a Keychain ACL prompt on the next access — blocking the app
  # before onAppear can fire. Delete the item to ensure a clean start.
  # (Analogous to `xcrun simctl uninstall` clearing UserDefaults/Keychain on iOS.)
  log "cleaning macOS Keychain entries from prior smoke runs"
  security delete-generic-password -s "dev.tpmt.teleprompter.pairing" 2>/dev/null || true
  # Also clear the UserDefaults tp.pairings.index and tp.pairing.*.meta keys so the
  # app doesn't try to reconnect to a stale pairing on boot (which would block kx).
  defaults delete dev.tpmt.teleprompter tp.pairings.index 2>/dev/null || true
  defaults delete dev.tpmt.teleprompter tp.frontendId 2>/dev/null || true
  # Delete all tp.pairing.* keys (the pairing meta stored by PairingStore).
  for key in $(defaults read dev.tpmt.teleprompter 2>/dev/null | grep '"tp\.pairing\.' | awk -F'"' '{print $2}'); do
    defaults delete dev.tpmt.teleprompter "$key" 2>/dev/null || true
  done

  # Start streaming the host unified log BEFORE launching the app. macOS `log show
  # --last Ns` silently drops Default-level messages from app bundles (historical
  # compression) even with --debug --info. `log stream` captures them in real-time.
  start_macos_log_stream

  log "opening macOS app (TP_PLATFORM=macos)"
  # -n: always open new instance, even if bundle already running. -g: don't steal
  # focus. Capture the launched PID so the EXIT trap can kill exactly this instance
  # (so smoke runs never leave orphan windows piling up on the desktop).
  # `--args --tp-smoke` flags smoke mode to the app (RelayClient.isSmokeMode) so the
  # M5 input-probe auto-fires. macOS injects the pairing link as a deep link below
  # (not via --tp-smoke-url), so this bare marker is how the app knows it's a test.
  open -gn "$app" --args --tp-smoke
  # `open` returns immediately; resolve the PID of the instance we just launched.
  local app_pid=""
  for _ in $(seq 1 20); do
    app_pid="$(pgrep -n -x Teleprompter 2>/dev/null || true)"
    [ -n "$app_pid" ] && break
    sleep 0.1
  done
  MACOS_APP_PID="$app_pid"
  # Ensure the launched app is killed on ANY exit (pass, fail-via-die, or interrupt).
  # bash keeps only one EXIT trap, and start_loopback/start_macos_log_stream each set
  # their own; register the app kill via the shared cleanup accumulator instead.
  tp_cleanup_add "kill -9 '${MACOS_APP_PID:-0}' 2>/dev/null || true"

  # Poll the live stream file for boot + core markers.
  local boot_seen="" core_line=""
  for _ in $(seq 1 30); do
    local out
    out="$(macos_log_snapshot)"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(printf '%s\n' "$out" | grep -Eo 'TP_CORE_(OK|FAIL)[^"]*' | tail -n1 || true)"
    if [ -n "$boot_seen" ] && [ -n "$core_line" ]; then break; fi
    sleep 0.5
  done
  [ -n "$boot_seen" ] || die "SMOKE FAIL (macOS) — boot marker '$BOOT_MARKER' not seen in host log (subsystem=$BUNDLE_ID)"
  tp_mark "$BOOT_MARKER"
  [ -n "$core_line" ] || die "SMOKE FAIL (macOS) — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) tp_mark "$CORE_MARKER"; log "core OK (macOS) — '$core_line'" ;;
    *) die "SMOKE FAIL (macOS) — tp-core round-trip failed: $core_line" ;;
  esac

  # M1+M2: bring up loopback relay, inject the golden deep link via LaunchServices.
  start_loopback

  local link
  link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  log "opening pairing deep link via 'open' (macOS LaunchServices)"
  # Register the URL scheme handler first: macOS LaunchServices caches the
  # handler list and a freshly built app may not be registered yet. Reboot
  # of LaunchServices DB via lsregister forces registration.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$app" 2>/dev/null || true
  open "$link"

  local pair_line="" auth_line="" kx_line="" frame_line="" session_line="" input_line=""
  for _ in $(seq 1 60); do
    local out
    out="$(macos_log_snapshot)"
    pair_line="$(printf '%s\n' "$out" | grep -Eo 'TP_PAIR_(OK|FAIL)[^"]*' | tail -n1 || true)"
    auth_line="$(printf '%s\n' "$out" | grep -Eo "${RELAY_AUTH_OK_MARKER}[^\"]*|${RELAY_AUTH_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    kx_line="$(printf '%s\n' "$out" | grep -Eo "${KX_OK_MARKER}[^\"]*|${KX_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(printf '%s\n' "$out" | grep -Eo "${SESSION_OK_MARKER}[^\"]*|${SESSION_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    input_line="$(printf '%s\n' "$out" | grep -Eo "${INPUT_OK_MARKER}[^\"]*|${INPUT_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    if [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ]; then break; fi
    sleep 0.5
  done

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL (macOS) — deep link opened but no '$PAIR_MARKER'/TP_PAIR_FAIL (URL not routed to app? try: lsregister -f $app)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*) tp_mark "$PAIR_MARKER"; log "pairing OK (macOS M1) — '$pair_line'" ;;
    "$PAIR_MARKER"*) die "SMOKE FAIL (macOS) — pairing wrong daemon id: $pair_line" ;;
    *) die "SMOKE FAIL (macOS) — pairing ingestion failed: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (macOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (macOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (macOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (macOS) — relay auth failed: $auth_line" ;;
  esac

  # M3 assertions.
  [ -n "$kx_line" ] || die "SMOKE FAIL (macOS) — relay auth OK but no '$KX_OK_MARKER'/'$KX_FAIL_MARKER'"
  case "$kx_line" in
    "$KX_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$KX_OK_MARKER"; log "kx OK (macOS M3) — '$kx_line'" ;;
    "$KX_OK_MARKER"*) die "SMOKE FAIL (macOS) — kx wrong daemon: $kx_line" ;;
    *) die "SMOKE FAIL (macOS) — kx failed: $kx_line" ;;
  esac

  [ -n "$frame_line" ] || die "SMOKE FAIL (macOS) — kx OK but no '$FRAME_OK_MARKER'/'$FRAME_FAIL_MARKER'"
  case "$frame_line" in
    "$FRAME_OK_MARKER sessions="*)
      local n="${frame_line#"$FRAME_OK_MARKER" sessions=}"
      n="${n%% *}"
      [ "${n:-0}" -ge 1 ] || die "SMOKE FAIL (macOS) — hello decrypted but sessions=$n"
      tp_mark "$FRAME_OK_MARKER"; log "frame OK (macOS M3) — '$frame_line'"
      ;;
    *) die "SMOKE FAIL (macOS) — frame decrypt/decode failed: $frame_line" ;;
  esac

  # M4 assertion.
  [ -n "$session_line" ] || die "SMOKE FAIL (macOS) — frame OK but no '$SESSION_OK_MARKER'/'$SESSION_FAIL_MARKER'"
  case "$session_line" in
    "$SESSION_OK_MARKER sid=$SMOKE_SESSION_ID events="*)
      local ev="${session_line#"$SESSION_OK_MARKER" sid="$SMOKE_SESSION_ID" events=}"
      ev="${ev%% *}"
      [ "${ev:-0}" -ge 1 ] || die "SMOKE FAIL (macOS) — session attached but events=$ev"
      tp_mark "$SESSION_OK_MARKER"; log "session OK (macOS M4) — '$session_line'"
      ;;
    "$SESSION_OK_MARKER"*) die "SMOKE FAIL (macOS) — session render wrong sid: $session_line" ;;
    *) die "SMOKE FAIL (macOS) — session attach/backfill failed: $session_line" ;;
  esac

  # M5 assertion.
  [ -n "$input_line" ] || die "SMOKE FAIL (macOS) — session OK but no '$INPUT_OK_MARKER'/'$INPUT_FAIL_MARKER'"
  case "$input_line" in
    "$INPUT_OK_MARKER sid=$SMOKE_SESSION_ID"*) tp_mark "$INPUT_OK_MARKER"; log "input OK (macOS M5) — '$input_line'" ;;
    "$INPUT_OK_MARKER"*) die "SMOKE FAIL (macOS) — input round-trip wrong sid: $input_line" ;;
    *) die "SMOKE FAIL (macOS) — input send/echo failed: $input_line" ;;
  esac

  local clients
  clients="$(curl -s "http://localhost:$RELAY_LOOPBACK_PORT/health" \
              | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("clients",0))' 2>/dev/null || echo 0)"
  [ "${clients:-0}" -ge 2 ] || die "SMOKE FAIL (macOS) — relay /health reports clients=$clients (expected >=2)"
  log "relay /health confirms clients=$clients"

  capture_macos_screenshot "macos"
  tp_smoke_pass
  log "✅ SMOKE PASS (macOS) — all 8 markers observed"
}

cmd_smoke_visionos() {
  tp_smoke_begin "visionos" \
    "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
    "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  local udid; udid="$(vision_sim_udid)" || die "visionOS simulator not found: $VISION_SIM_NAME (set TP_VISION_SIM)"
  log "visionOS Simulator UDID: $udid"

  # Boot the visionOS Simulator (idempotent).
  local state
  state="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev.get("state","unknown")); sys.exit(0)
sys.exit(0)
' "$udid")"
  if [ "$state" != "Booted" ]; then
    log "booting $VISION_SIM_NAME ($udid) — visionOS Simulator boot may take 60s+"
    xcrun simctl boot "$udid"
    # Wait for boot to complete (visionOS Simulator can be slow).
    local booted=""
    for _ in $(seq 1 60); do
      local s
      s="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev["state"]); sys.exit(0)
' "$udid" 2>/dev/null || echo "Unknown")"
      if [ "$s" = "Booted" ]; then booted="yes"; break; fi
      sleep 2
    done
    [ -n "$booted" ] || die "visionOS Simulator $VISION_SIM_NAME ($udid) failed to boot in 120s"
  else
    log "$VISION_SIM_NAME already booted ($udid)"
  fi

  local app; app="$(visionos_app_path)"

  # Clean install for test isolation (same rationale as iOS path).
  log "uninstalling (clean container for test isolation)"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "installing"
  xcrun simctl install "$udid" "$app"

  # M1+M2: bring loopback relay up BEFORE launching, then launch with --tp-smoke-url
  # to bypass LaunchServices URL-scheme approval (same fix as iOS path — simctl openurl
  # hits the -10814 bundle-record approval error on visionOS Simulator too).
  start_loopback

  local link
  link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"

  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (visionOS M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$PAIR_MARKER did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  xcrun simctl launch "$udid" "$BUNDLE_ID" -- --tp-smoke-url "$link" >/dev/null

  # Poll all 8 markers in one loop (boot+core+M1–M5), with longer timeouts for visionOS sim.
  local boot_seen="" core_line="" pair_line="" auth_line="" kx_line="" frame_line="" session_line="" input_line=""
  for _ in $(seq 1 90); do
    local out
    out="$(xcrun simctl spawn "$udid" log show --last 90s --style compact \
      --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null || true)"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(printf '%s\n' "$out" | grep -Eo 'TP_CORE_(OK|FAIL)[^"]*' | tail -n1 || true)"
    pair_line="$(printf '%s\n' "$out" | grep -Eo 'TP_PAIR_(OK|FAIL)[^"]*' | tail -n1 || true)"
    auth_line="$(printf '%s\n' "$out" | grep -Eo "${RELAY_AUTH_OK_MARKER}[^\"]*|${RELAY_AUTH_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    kx_line="$(printf '%s\n' "$out" | grep -Eo "${KX_OK_MARKER}[^\"]*|${KX_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(printf '%s\n' "$out" | grep -Eo "${SESSION_OK_MARKER}[^\"]*|${SESSION_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    input_line="$(printf '%s\n' "$out" | grep -Eo "${INPUT_OK_MARKER}[^\"]*|${INPUT_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ]; then break; fi
    sleep 1
  done

  # M0 assertions.
  [ -n "$boot_seen" ] || die "SMOKE FAIL (visionOS) — boot marker '$BOOT_MARKER' not seen in Simulator log"
  tp_mark "$BOOT_MARKER"
  [ -n "$core_line" ] || die "SMOKE FAIL (visionOS) — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) tp_mark "$CORE_MARKER"; log "core OK (visionOS) — '$core_line'" ;;
    *) die "SMOKE FAIL (visionOS) — tp-core round-trip failed on-device: $core_line" ;;
  esac

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL (visionOS) — --tp-smoke-url injected but no '$PAIR_MARKER'/TP_PAIR_FAIL (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*) tp_mark "$PAIR_MARKER"; log "pairing OK (visionOS M1) — '$pair_line'" ;;
    "$PAIR_MARKER"*) die "SMOKE FAIL (visionOS) — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL (visionOS) — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (visionOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (visionOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (visionOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (visionOS) — relay auth failed on-device: $auth_line" ;;
  esac

  # M3 assertion — in-band kx.
  [ -n "$kx_line" ] || die "SMOKE FAIL (visionOS) — relay auth OK but no '$KX_OK_MARKER'/'$KX_FAIL_MARKER' (kx never ran?)"
  case "$kx_line" in
    "$KX_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$KX_OK_MARKER"; log "kx OK (visionOS M3) — '$kx_line'" ;;
    "$KX_OK_MARKER"*) die "SMOKE FAIL (visionOS) — kx wrong daemon: $kx_line" ;;
    *) die "SMOKE FAIL (visionOS) — kx failed on-device: $kx_line" ;;
  esac

  # M3 assertion — first decrypted frame.
  [ -n "$frame_line" ] || die "SMOKE FAIL (visionOS) — kx OK but no '$FRAME_OK_MARKER'/'$FRAME_FAIL_MARKER' (hello never decrypted?)"
  case "$frame_line" in
    "$FRAME_OK_MARKER sessions="*)
      local n="${frame_line#"$FRAME_OK_MARKER" sessions=}"
      n="${n%% *}"
      [ "${n:-0}" -ge 1 ] || die "SMOKE FAIL (visionOS) — hello decrypted but sessions=$n (expected >=1)"
      tp_mark "$FRAME_OK_MARKER"; log "frame OK (visionOS M3) — '$frame_line'"
      ;;
    *) die "SMOKE FAIL (visionOS) — first frame decrypt/decode failed on-device: $frame_line" ;;
  esac

  # M4 assertion — live session render.
  [ -n "$session_line" ] || die "SMOKE FAIL (visionOS) — frame OK but no '$SESSION_OK_MARKER'/'$SESSION_FAIL_MARKER' (attach/resume never ran?)"
  case "$session_line" in
    "$SESSION_OK_MARKER sid=$SMOKE_SESSION_ID events="*)
      local ev="${session_line#"$SESSION_OK_MARKER" sid="$SMOKE_SESSION_ID" events=}"
      ev="${ev%% *}"
      [ "${ev:-0}" -ge 1 ] || die "SMOKE FAIL (visionOS) — session attached but events=$ev (expected >=1)"
      tp_mark "$SESSION_OK_MARKER"; log "session OK (visionOS M4) — '$session_line'"
      ;;
    "$SESSION_OK_MARKER"*) die "SMOKE FAIL (visionOS) — session render wrong sid: $session_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL (visionOS) — session attach/backfill failed on-device: $session_line" ;;
  esac

  # M5 assertion — input round-trip.
  [ -n "$input_line" ] || die "SMOKE FAIL (visionOS) — session OK but no '$INPUT_OK_MARKER'/'$INPUT_FAIL_MARKER' (input never sent/echoed?)"
  case "$input_line" in
    "$INPUT_OK_MARKER sid=$SMOKE_SESSION_ID"*) tp_mark "$INPUT_OK_MARKER"; log "input OK (visionOS M5) — '$input_line'" ;;
    "$INPUT_OK_MARKER"*) die "SMOKE FAIL (visionOS) — input round-trip wrong sid: $input_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL (visionOS) — input send/echo failed on-device: $input_line" ;;
  esac

  local clients
  clients="$(curl -s "http://localhost:$RELAY_LOOPBACK_PORT/health" \
              | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("clients",0))' 2>/dev/null || echo 0)"
  [ "${clients:-0}" -ge 2 ] || die "SMOKE FAIL (visionOS) — relay /health reports clients=$clients (expected >=2: app + fake daemon)"
  log "relay /health confirms clients=$clients"

  capture_sim_screenshot "$udid" "visionos"
  tp_smoke_pass
  log "✅ SMOKE PASS (visionOS) — boot + core + pairing + relay-auth + kx + first-frame + session-render + input-roundtrip markers observed on $VISION_SIM_NAME"
}

cmd_smoke_watchos() {
  # 7 markers — TP_INPUT_OK is intentionally absent on watchOS (ADR-0002 §watchOS).
  tp_smoke_begin "watchos" \
    "$BOOT_MARKER" "$CORE_MARKER" "$PAIR_MARKER" "$RELAY_AUTH_OK_MARKER" \
    "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  local udid; udid="$(watch_sim_udid)" || die "watchOS simulator not found: $WATCH_SIM_NAME (set TP_WATCH_SIM)"
  log "watchOS Simulator UDID: $udid"

  # Boot the watchOS Simulator (idempotent). watchOS sim boot can take 60s+.
  local state
  state="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev.get("state","unknown")); sys.exit(0)
sys.exit(0)
' "$udid")"
  if [ "$state" != "Booted" ]; then
    log "booting $WATCH_SIM_NAME ($udid) — watchOS Simulator boot may take 60s+"
    xcrun simctl boot "$udid"
    local booted=""
    for _ in $(seq 1 60); do
      local s
      s="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev["state"]); sys.exit(0)
' "$udid" 2>/dev/null || echo "Unknown")"
      if [ "$s" = "Booted" ]; then booted="yes"; break; fi
      sleep 2
    done
    [ -n "$booted" ] || die "watchOS Simulator $WATCH_SIM_NAME ($udid) failed to boot in 120s"
  else
    log "$WATCH_SIM_NAME already booted ($udid)"
  fi

  local app; app="$(watchos_app_path)"

  # Clean install for test isolation (same rationale as iOS path).
  log "uninstalling (clean container for test isolation)"
  xcrun simctl terminate "$udid" "$WATCH_BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl uninstall "$udid" "$WATCH_BUNDLE_ID" >/dev/null 2>&1 || true
  log "installing"
  xcrun simctl install "$udid" "$app"

  # M1+M2: bring loopback relay up BEFORE launching, then launch with --tp-smoke-url
  # to bypass LaunchServices URL-scheme approval (same fix as iOS/visionOS path).
  start_loopback

  local link
  link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"

  xcrun simctl terminate "$udid" "$WATCH_BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (watchOS M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$PAIR_MARKER did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  xcrun simctl launch "$udid" "$WATCH_BUNDLE_ID" -- --tp-smoke-url "$link" >/dev/null

  # Poll 7 markers (no TP_INPUT_OK on watch — no terminal input per ADR-0002 §watchOS).
  # Generous 120s poll loop: watchOS Simulator log delivery can lag behind iOS.
  local boot_seen="" core_line="" pair_line="" auth_line="" kx_line="" frame_line="" session_line=""
  for _ in $(seq 1 120); do
    local out
    out="$(xcrun simctl spawn "$udid" log show --last 120s --style compact \
      --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null || true)"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(printf '%s\n' "$out" | grep -Eo 'TP_CORE_(OK|FAIL)[^"]*' | tail -n1 || true)"
    pair_line="$(printf '%s\n' "$out" | grep -Eo 'TP_PAIR_(OK|FAIL)[^"]*' | tail -n1 || true)"
    auth_line="$(printf '%s\n' "$out" | grep -Eo "${RELAY_AUTH_OK_MARKER}[^\"]*|${RELAY_AUTH_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    kx_line="$(printf '%s\n' "$out" | grep -Eo "${KX_OK_MARKER}[^\"]*|${KX_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(printf '%s\n' "$out" | grep -Eo "${SESSION_OK_MARKER}[^\"]*|${SESSION_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    if [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ]; then break; fi
    sleep 1
  done

  # M0 assertions.
  [ -n "$boot_seen" ] || die "SMOKE FAIL (watchOS) — boot marker '$BOOT_MARKER' not seen in Simulator log"
  tp_mark "$BOOT_MARKER"
  [ -n "$core_line" ] || die "SMOKE FAIL (watchOS) — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) tp_mark "$CORE_MARKER"; log "core OK (watchOS) — '$core_line'" ;;
    *) die "SMOKE FAIL (watchOS) — tp-core round-trip failed on-device: $core_line" ;;
  esac

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL (watchOS) — --tp-smoke-url injected but no '$PAIR_MARKER'/TP_PAIR_FAIL (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$PAIR_MARKER did=$SMOKE_DAEMON_ID"*) tp_mark "$PAIR_MARKER"; log "pairing OK (watchOS M1) — '$pair_line'" ;;
    "$PAIR_MARKER"*) die "SMOKE FAIL (watchOS) — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL (watchOS) — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (watchOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (watchOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (watchOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (watchOS) — relay auth failed on-device: $auth_line" ;;
  esac

  # M3 assertion — in-band kx.
  [ -n "$kx_line" ] || die "SMOKE FAIL (watchOS) — relay auth OK but no '$KX_OK_MARKER'/'$KX_FAIL_MARKER' (kx never ran?)"
  case "$kx_line" in
    "$KX_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$KX_OK_MARKER"; log "kx OK (watchOS M3) — '$kx_line'" ;;
    "$KX_OK_MARKER"*) die "SMOKE FAIL (watchOS) — kx wrong daemon: $kx_line" ;;
    *) die "SMOKE FAIL (watchOS) — kx failed on-device: $kx_line" ;;
  esac

  # M3 assertion — first decrypted frame.
  [ -n "$frame_line" ] || die "SMOKE FAIL (watchOS) — kx OK but no '$FRAME_OK_MARKER'/'$FRAME_FAIL_MARKER' (hello never decrypted?)"
  case "$frame_line" in
    "$FRAME_OK_MARKER sessions="*)
      local n="${frame_line#"$FRAME_OK_MARKER" sessions=}"
      n="${n%% *}"
      [ "${n:-0}" -ge 1 ] || die "SMOKE FAIL (watchOS) — hello decrypted but sessions=$n (expected >=1)"
      tp_mark "$FRAME_OK_MARKER"; log "frame OK (watchOS M3) — '$frame_line'"
      ;;
    *) die "SMOKE FAIL (watchOS) — first frame decrypt/decode failed on-device: $frame_line" ;;
  esac

  # M4 assertion — live session render.
  [ -n "$session_line" ] || die "SMOKE FAIL (watchOS) — frame OK but no '$SESSION_OK_MARKER'/'$SESSION_FAIL_MARKER' (attach/resume never ran?)"
  case "$session_line" in
    "$SESSION_OK_MARKER sid=$SMOKE_SESSION_ID events="*)
      local ev="${session_line#"$SESSION_OK_MARKER" sid="$SMOKE_SESSION_ID" events=}"
      ev="${ev%% *}"
      [ "${ev:-0}" -ge 1 ] || die "SMOKE FAIL (watchOS) — session attached but events=$ev (expected >=1)"
      tp_mark "$SESSION_OK_MARKER"; log "session OK (watchOS M4) — '$session_line'"
      ;;
    "$SESSION_OK_MARKER"*) die "SMOKE FAIL (watchOS) — session render wrong sid: $session_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL (watchOS) — session attach/backfill failed on-device: $session_line" ;;
  esac

  # NOTE: TP_INPUT_OK is intentionally NOT checked on watchOS. The watch app
  # provides read-mostly glance experience — no terminal input (ADR-0002 §4).

  local clients
  clients="$(curl -s "http://localhost:$RELAY_LOOPBACK_PORT/health" \
              | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("clients",0))' 2>/dev/null || echo 0)"
  [ "${clients:-0}" -ge 2 ] || die "SMOKE FAIL (watchOS) — relay /health reports clients=$clients (expected >=2: app + fake daemon)"
  log "relay /health confirms clients=$clients"

  capture_sim_screenshot "$udid" "watchos"
  tp_smoke_pass
  log "✅ SMOKE PASS (watchOS) — 7/7 markers: boot + core + pairing + relay-auth + kx + first-frame + session-render observed on $WATCH_SIM_NAME (TP_INPUT_OK intentionally absent)"
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
  # Bake the local pid/path into the cleanup command now (they go out of scope when
  # this function returns). Registered on the shared accumulator so it coexists with
  # the macOS log-stream and app-kill cleanups instead of clobbering them.
  tp_cleanup_add "kill '$lb_pid' 2>/dev/null || true; rm -f '$lb_out' 2>/dev/null || true"

  local ready=""
  for _ in $(seq 1 30); do
    kill -0 "$lb_pid" 2>/dev/null || die "SMOKE FAIL — loopback relay exited early: $(cat "$lb_out")"
    case "$(cat "$lb_out" 2>/dev/null)" in *"LOOPBACK_READY"*) ready="yes"; break ;; esac
    sleep 0.2
  done
  [ -n "$ready" ] || die "SMOKE FAIL — loopback relay never signalled LOOPBACK_READY: $(cat "$lb_out")"
}

# ── start_real_daemon_relay (TP_E2E_REAL=1) ─────────────────────────────────────
#
# The REAL-daemon E2E path: instead of the fake scripted loopback, stand up a
# genuine `tp` relay + `tp` daemon (isolated store/socket under a temp dir) and
# pair the frontend headlessly. scripts/real-daemon-pair.ts does the heavy lifting;
# this wrapper backgrounds it, reads the emitted deep link, and records the REAL
# (dynamic) daemonId so the marker assertions can target it.
#
# Sets these globals for cmd_smoke_ios to consume:
#   REAL_PAIR_LINK   the tp://p?d=… deep link the app ingests (--tp-smoke-url)
#   REAL_DAEMON_ID   the daemon's runtime id (daemon-<base36>), for did= assertions
#
# Honest scope: the real daemon has NO sessions and no live PTY, so it serves an
# empty `hello` (frame sessions=0) and never reaches M4/M5. This path therefore
# asserts M0–M3 (boot + core + pairing + relay-auth + kx) — proof that the genuine
# daemon→relay→app pipeline works end to end. Full M4/M5 needs a spawned session +
# `claude` on PATH (see native-testing.md).
REAL_PAIR_LINK=""
REAL_DAEMON_ID=""
REAL_E2E_DIR=""
REAL_SESSION_SID=""
# Set by cmd_smoke_ios before calling us: "yes" → spawn a real claude session
# (TP_E2E_CLAUDE). Empty → M0–M2-only real-daemon mode (unchanged behavior).
REAL_SPAWN_CLAUDE=""
# "yes" → the spawned claude session is INTERACTIVE (TP_E2E_CLAUDE_M5), not print mode,
# so the input round-trip (M5) can be exercised. Implies REAL_SPAWN_CLAUDE.
REAL_SPAWN_CLAUDE_M5=""
start_real_daemon_relay() {
  require bun
  local script="$REPO_ROOT/scripts/real-daemon-pair.ts"
  [ -f "$script" ] || die "E2E_REAL FAIL — missing $script"

  # Per-run isolated XDG dirs so the real daemon never collides with the user's
  # dogfood daemon (separate socket, store, config). Cleaned up on exit (LIFO).
  REAL_E2E_DIR="$(mktemp -d -t tp-e2e.XXXXXX)"
  # TP_E2E_KEEP_DIR=1 preserves the isolated dir (session DB, daemon/runner logs) for
  # post-mortem debugging of a failed real/claude E2E. Off by default (LIFO cleanup).
  if [ "${TP_E2E_KEEP_DIR:-}" = "1" ]; then
    log "TP_E2E_KEEP_DIR=1 — preserving isolated dir for inspection: $REAL_E2E_DIR"
  else
    tp_cleanup_add "rm -rf '$REAL_E2E_DIR' 2>/dev/null || true"
  fi

  # In claude mode, pass --spawn-claude so the holder spawns a real `claude -p`
  # session after pairing. The fixed sid lets the M4 assertion key on it; the cwd is
  # a scratch dir under the isolated HOME. CLAUDE_CODE_OAUTH_TOKEN was exported by
  # cmd_smoke_ios (from the keychain) and is inherited here.
  # --spawn-claude       → real `claude -p` PRINT session (M4).
  # --spawn-claude-interactive → real INTERACTIVE claude session (M5): the holder also
  #                        accepts the trust-folder prompt (one `\r` over IPC) so claude
  #                        sits idle at the REPL, ready for the app's relayed probe.
  local spawn_args=() claude_sid=""
  if [ -n "$REAL_SPAWN_CLAUDE_M5" ]; then
    spawn_args+=("--spawn-claude-interactive")
    claude_sid="real-smoke-sess"
  elif [ -n "$REAL_SPAWN_CLAUDE" ]; then
    spawn_args+=("--spawn-claude")
    claude_sid="real-smoke-sess"
  fi

  local rp_out; rp_out="$(mktemp -t tp-realpair.XXXXXX)"
  log "starting REAL daemon+relay (isolated under $REAL_E2E_DIR)${REAL_SPAWN_CLAUDE:+ + real claude session}"
  # Isolate via XDG_* (socket/store/config) + HOME so nothing leaks to ~/.
  # TP_E2E_CLAUDE_* configure the spawned session (sid/cwd); inherited by the script.
  XDG_RUNTIME_DIR="$REAL_E2E_DIR/run" \
  XDG_DATA_HOME="$REAL_E2E_DIR/data" \
  XDG_CONFIG_HOME="$REAL_E2E_DIR/cfg" \
  HOME="$REAL_E2E_DIR/home" \
  TP_E2E_CLAUDE_SID="$claude_sid" \
  TP_E2E_CLAUDE_CWD="$REAL_E2E_DIR/home/work" \
  bun run "$script" "${spawn_args[@]}" >"$rp_out" 2>>"$rp_out" &
  local rp_pid=$!
  # SIGTERM the holder on cleanup (it tears down the daemon + relay + claude runner).
  tp_cleanup_add "kill '$rp_pid' 2>/dev/null || true; rm -f '$rp_out' 2>/dev/null || true"

  # Wait for the REAL_PAIR_URL line (the daemon authed to the relay and pair.begin
  # returned the deep link). pair.completed comes LATER (when the app finishes kx).
  local line=""
  for _ in $(seq 1 100); do
    kill -0 "$rp_pid" 2>/dev/null || die "E2E_REAL FAIL — real-daemon-pair exited early: $(cat "$rp_out")"
    line="$(grep -Eo 'REAL_PAIR_URL=tp://[^[:space:]]+' "$rp_out" 2>/dev/null | tail -n1 || true)"
    [ -n "$line" ] && break
    sleep 0.2
  done
  [ -n "$line" ] || die "E2E_REAL FAIL — real-daemon-pair never emitted REAL_PAIR_URL: $(cat "$rp_out")"
  REAL_PAIR_LINK="${line#REAL_PAIR_URL=}"

  # The daemon logs its id as "daemon daemon-<base36>"; capture it for did= asserts.
  REAL_DAEMON_ID="$(grep -Eo 'daemon daemon-[a-z0-9]+' "$rp_out" 2>/dev/null | tail -n1 | awk '{print $2}' || true)"
  [ -n "$REAL_DAEMON_ID" ] || die "E2E_REAL FAIL — could not determine real daemon id from: $(cat "$rp_out")"

  # In claude mode, the spawned session uses a FIXED sid ($claude_sid, passed to the
  # holder via TP_E2E_CLAUDE_SID) so the M4 assertion can key on it. We do NOT poll
  # for REAL_SESSION_SID= here: the holder spawns claude only AFTER pair.completed,
  # which fires after the APP finishes kx — and the app is launched by cmd_smoke_ios
  # *after* this function returns. Blocking on the sid here would deadlock (session
  # can't exist until the app pairs, app can't pair until we return). The sid is
  # deterministic, so just record it; the runner spawn + REAL_SESSION_SID= emission
  # happen later in the holder, and the marker poll observes the resulting session.
  if [ -n "$REAL_SPAWN_CLAUDE" ]; then
    REAL_SESSION_SID="$claude_sid"
    log "REAL daemon paired — id=$REAL_DAEMON_ID, session sid=$REAL_SESSION_SID (fixed; spawn deferred to post-pairing), link acquired"
  else
    log "REAL daemon paired — id=$REAL_DAEMON_ID, link acquired"
  fi
}

# ── cmd_all — 5-platform smoke matrix ───────────────────────────────────────────
#
# Run smoke for every platform and print a result matrix. Each platform runs in a
# SUBSHELL with TP_JSON=1 so its EXIT-trap JSON line is captured independently (the
# trap fires on the subshell's exit, success or fail). A subshell failure (`die`→
# exit 1) is caught so one bad platform doesn't abort the sweep; the matrix records
# it and cmd_all exits non-zero iff any platform failed.
cmd_all() {
  # fd 3 = the parent's stderr, so each subshell's stderr (live [ios] logs) streams
  # through while we capture ONLY its stdout JSON line. Works in CI/non-tty too.
  exec 3>&2
  local platforms=("ios" "ipad" "macos" "visionos" "watchos")
  local -a results=()
  local p json rc
  for p in "${platforms[@]}"; do
    log "──────── cmd_all: $p ────────"
    # Subshell: isolate TP_PLATFORM + the per-run smoke trap state. Capture only the
    # final stdout line (the JSON); human logs (stderr) pass straight through to the
    # parent's stderr so the operator still sees live progress.
    json="$( TP_PLATFORM="$p" TP_JSON=1 bash "$0" smoke 2>&3 | tail -n1 )" && rc=0 || rc=$?
    # Fallback: if the subshell died before emitting JSON, synthesize a failed row.
    case "$json" in
      '{"platform"'*) : ;;
      *) json="{\"platform\":\"$p\",\"markers\":{},\"passed\":false,\"elapsed_s\":0}" ;;
    esac
    results+=("$json")
  done

  # Render the matrix + compute overall pass/fail.
  printf '\n'
  printf '%-10s  %-7s  %-9s  %s\n' "PLATFORM" "PASSED" "ELAPSED" "MARKERS"
  printf '%-10s  %-7s  %-9s  %s\n' "--------" "------" "-------" "-------"
  local overall=0 row
  for row in "${results[@]}"; do
    printf '%s\n' "$row" | /usr/bin/python3 -c '
import json,sys
r=json.load(sys.stdin)
m=r.get("markers",{})
seen=sum(1 for v in m.values() if v); total=len(m)
passed="PASS" if r.get("passed") else "FAIL"
print("%-10s  %-7s  %-9s  %d/%d" % (
    r.get("platform","?"), passed, "%ds"%r.get("elapsed_s",0), seen, total))
sys.exit(0 if r.get("passed") else 1)
' || overall=1
  done
  printf '\n'
  if [ "$overall" -eq 0 ]; then
    log "✅ cmd_all: all platforms PASS"
  else
    die "cmd_all: one or more platforms FAILED (see matrix above)"
  fi
}

# ── cmd_uitest — XCUITest UI-level E2E (T3, #66) ────────────────────────────────
#
# Where `smoke` proves the wire/E2EE/kx bytes round-trip (markers polled from the
# unified log), THIS proves the SwiftUI layer actually RENDERS that decrypted data
# through the real Accessibility tree. The TeleprompterUITests target launches the
# app with `--tp-smoke-url <golden link>` (the SAME loopback path the marker smoke
# uses), then taps the seeded session row → pane picker and asserts the rendered
# "Claude: smoke ok" chat bubble (loopback Stop event, last_assistant_message).
#
# The harness's only job here is to (1) stand up the loopback relay, (2) build the
# golden pairing link, and (3) hand both to the test runner via TEST_RUNNER_-
# prefixed env (xcodebuild strips the prefix and injects them into the runner's
# ProcessInfo.environment, which SmokeUITests reads as TP_SMOKE_URL / TP_SMOKE_SID).
#
# Per-platform reach (ADR-0002): iOS / iPadOS / macOS = full UI automation;
# visionOS = element queries + flat-window taps (no spatial-gesture sim); watchOS =
# NONE (watchOS has no XCUIApplication — a hard Apple limit), rejected cleanly.
cmd_uitest() {
  require xcodebuild
  if [ "$TP_PLATFORM" = "watchos" ]; then
    die "uitest unsupported on watchOS — watchOS has no XCUIApplication (Apple hard limit). watchOS verification is markers + screenshot only (scripts/ios.sh smoke)."
  fi
  ensure_xcframework
  ensure_project

  # Resolve the destination per platform (UDID where a name could be ambiguous).
  # $extra_flags carries any per-platform build settings (e.g. macOS must clear
  # CODE_SIGN_ENTITLEMENTS — keychain-access-groups need a real cert on native
  # macOS, unlike the iOS Simulator where ad-hoc signing works; mirrors cmd_build).
  local dest
  local -a extra_flags=()
  case "$TP_PLATFORM" in
    macos)
      dest="platform=macOS"
      extra_flags+=(CODE_SIGN_ENTITLEMENTS="")
      ;;
    visionos)
      local vision_udid; vision_udid="$(vision_sim_udid)" \
        || die "visionOS simulator not found: $VISION_SIM_NAME (set TP_VISION_SIM)"
      dest="id=$vision_udid"
      ;;
    *)
      # iOS family (ios|ipad): boot first so the runner has a live device, and
      # target its UDID (avoids the two-same-name-sims destination ambiguity).
      local udid; udid="$(cmd_boot)"
      dest="id=$udid"
      ;;
  esac

  # Stand up the loopback relay + golden link, exactly like the marker smoke.
  start_loopback
  local link
  link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"

  log "running TeleprompterUITests on $TP_PLATFORM ($dest)"
  # xcodebuild forwards any of its OWN environment variables named TEST_RUNNER_<VAR>
  # into the test runner's process environment as <VAR> (Xcode convention). They
  # must be real env vars of the xcodebuild PROCESS — passing them as KEY=VALUE
  # build-setting arguments does NOT reach the runner (they'd become build settings).
  # SmokeUITests reads TP_SMOKE_URL (golden link) + TP_SMOKE_SID (loopback sid) and
  # feeds the link into app.launchArguments as --tp-smoke-url.
  # Use the dedicated TeleprompterUITests scheme (test action = UI tests ONLY), not
  # the main scheme. The main scheme also runs the iOS-hosted unit-test target,
  # whose TEST_HOST is wired for the iOS .app bundle layout and breaks a macOS
  # destination build. The dedicated scheme keeps macOS UI testing self-contained.
  #
  # Tee output to a log so we can distinguish a genuine test failure from a macOS-
  # host automation GATE (see below) while still streaming progress to the operator.
  local uit_log; uit_log="$(mktemp -t tp-uitest.XXXXXX)"
  tp_cleanup_add "rm -f '$uit_log' 2>/dev/null || true"
  local rc=0
  TEST_RUNNER_TP_SMOKE_URL="$link" \
  TEST_RUNNER_TP_SMOKE_SID="$SMOKE_SESSION_ID" \
  xcodebuild \
    -project "$PROJECT" \
    -scheme "TeleprompterUITests" \
    -configuration Debug \
    -destination "$dest" \
    -derivedDataPath "$DERIVED" \
    $SIGN_FLAGS \
    "${extra_flags[@]}" \
    test 2>&1 | tee "$uit_log" | xcbeautify_or_cat || rc="${PIPESTATUS[0]}"

  if [ "$rc" -eq 0 ]; then
    log "✅ UITEST PASS — session render + pane switch asserted through the a11y tree on $TP_PLATFORM"
    return 0
  fi

  # macOS-only host GATE, not a code failure: XCUITest's runner must initialize an
  # automation session, which native macOS guards behind a LocalAuthentication /
  # TCC (Accessibility + Automation) challenge. In a non-interactive or unauthorized
  # session that challenge can't complete ("Failed to initialize for UI testing …
  # System authentication is running" / LocalAuthentication Code=-4), so the run
  # can't even reach the assertions. Treat this as a SKIP — the build+sign path is
  # proven, and the SAME XCUITest code already passes on the iOS Simulator (no TCC
  # gate there). This mirrors how visionOS UI reach is documented as partial.
  if [ "$TP_PLATFORM" = "macos" ] \
     && grep -q "Failed to initialize for UI testing" "$uit_log" 2>/dev/null; then
    log "⏭️  UITEST SKIP (macOS host gate) — XCUITest runner could not initialize:"
    log "    LocalAuthentication/TCC blocked the automation session (needs an"
    log "    interactively-authorized, unlocked session with Accessibility +"
    log "    Automation granted to the test runner). Build+sign succeeded; the"
    log "    identical UI assertions pass on the iOS Simulator. Grant access in"
    log "    System Settings → Privacy & Security → Accessibility/Automation and"
    log "    re-run in a logged-in GUI session for full macOS UI E2E."
    return 0
  fi

  die "UITEST FAIL on $TP_PLATFORM (see output above; xcresult under $DERIVED/Logs/Test)"
}

cmd_test() {
  require xcodebuild
  if [ "$TP_PLATFORM" = "macos" ] || [ "$TP_PLATFORM" = "visionos" ] || [ "$TP_PLATFORM" = "watchos" ]; then
    die "XCTest (cmd_test) is ios/ipad-only in this milestone. Use TP_PLATFORM=ios for tests."
  fi
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

# Swift source roots that swift-format formats/lints (app + tests + watch target).
SWIFT_FMT_PATHS=("$IOS_DIR/Sources" "$IOS_DIR/Tests" "$IOS_DIR/UITests" "$IOS_DIR/Watch")
SWIFT_FMT_CONFIG="$REPO_ROOT/.swift-format"

# `swift-format` is bundled with Xcode — invoke via `xcrun` (no Homebrew dep).
swift_format() {
  require xcrun
  xcrun swift-format "$@"
}

# Rewrite all Swift sources in place per .swift-format (formatting rules only;
# lint-only rules like naming are never auto-applied). Run before committing.
cmd_fmt() {
  log "swift-format format -i (config: .swift-format)"
  swift_format format -i --configuration "$SWIFT_FMT_CONFIG" --recursive "${SWIFT_FMT_PATHS[@]}"
  log "✅ formatted"
}

# Fail on any style deviation. `--strict` promotes every finding to a nonzero
# exit so this is usable as a gate (mirrors `cargo fmt --check` on the Rust side).
cmd_lint() {
  log "swift-format lint --strict (config: .swift-format)"
  if swift_format lint --strict --configuration "$SWIFT_FMT_CONFIG" \
       --recursive "${SWIFT_FMT_PATHS[@]}"; then
    log "✅ swift-format lint clean"
  else
    die "swift-format lint failed — run 'scripts/ios.sh fmt' to auto-fix formatting"
  fi
}

main() {
  local sub="${1:-smoke}"; shift || true
  case "$sub" in
    gen)   cmd_gen ;;
    rust)  cmd_rust "$@" ;;
    boot)
      [ "$TP_PLATFORM" != "macos" ] || die "'boot' is Simulator-only (TP_PLATFORM=macos has no Simulator to boot)"
      cmd_boot
      ;;
    build) cmd_build "$@" ;;
    run)   cmd_run ;;
    smoke) cmd_smoke ;;
    all)   cmd_all ;;
    uitest) cmd_uitest ;;
    test)  cmd_test ;;
    fmt)   cmd_fmt ;;
    lint)  cmd_lint ;;
    *) die "unknown subcommand: $sub (use: gen|rust|boot|build|run|smoke|all|uitest|test|fmt|lint)" ;;
  esac
}

main "$@"
