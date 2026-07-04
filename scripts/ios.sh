#!/usr/bin/env bash
# Teleprompter native app harness (ADR-0001 rewrite + ADR-0002 multiplatform).
#
# SCOPE: Teleprompter is a user-owned, self-hosted dev tool (the operator's phone driving
# the operator's OWN Claude Code sessions on the operator's OWN machine — like SSH or VS
# Code Remote). This harness is a LOCAL test that automates the operator's own dev workflow
# in a throwaway sandbox. Where the real-claude E2E gates answer Claude's own first-run
# prompt or reuse the operator's own login token, that is unattended-CI plumbing for the
# operator's own box — not credential theft and not a safety bypass. The real-claude gates
# NEVER run in CI (see TP_E2E_CLAUDE* — local-only).
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
#                               Real-claude E2E (TP_E2E_*) on iOS/iPad/macOS/visionOS/watchOS;
#                               watchOS caps at M0–M4 (M5 input N/A on watch, ADR-0002 §4).
#   scripts/ios.sh uitest-all   Run XCUITest UI E2E on ALL supported platforms and print a
#                               PASS/SKIP/FAIL matrix: iOS/iPadOS/macOS/visionOS run; watchOS
#                               is always SKIP (no XCUIApplication — Apple hard limit); macOS
#                               is SKIP when the TCC host-gate blocks the runner (set
#                               TP_UITEST_STRICT=1 to make that a FAIL). Exits non-zero iff any
#                               platform FAILs. (Single-platform: TP_PLATFORM=<p> uitest.)
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
#   TP_UITEST_STRICT Set to 1 to make the macOS XCUITest TCC host-gate a hard
#                   failure instead of a non-fatal SKIP (use on authorized GUI/CI
#                   runners; default SKIP emits a `TP_UITEST_SKIP` marker)
#   TP_UITEST_JSON  Set to 1 (done internally by `uitest-all`) to emit a single-line
#                   JSON result as the last stdout line of a uitest run
#                   ({"platform","result","elapsed_s"}, result = PASS|SKIP|FAIL)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$REPO_ROOT/ios"
PROJECT="$IOS_DIR/Teleprompter.xcodeproj"
DERIVED="$IOS_DIR/build/DerivedData"
SCHEME="${TP_SCHEME:-Teleprompter}"
SIM_NAME="${TP_SIM:-iPhone 17 Pro}"
VISION_SIM_NAME="${TP_VISION_SIM:-Apple Vision Pro}"
WATCH_SIM_NAME="${TP_WATCH_SIM:-Apple Watch Series 11 (46mm)}"
BUNDLE_ID="dev.tpmt.app"
# The watch app is a companion embedded directly in the main iOS app (#123,
# ADR-0004 Amdt 2). Apple's WatchKit layout requires the watch app id to be
# <companion-id>.watchkitapp, so it is dev.tpmt.app.watchkitapp. The Simulator
# smoke path builds + launches TeleprompterWatch directly (standalone RUNTIME
# proof), so it uses this id; distribution rides the main app's .ipa.
WATCH_BUNDLE_ID="dev.tpmt.app.watchkitapp"
BOOT_MARKER="TP_BOOT_OK"
CORE_MARKER="TP_CORE_OK"
PAIR_MARKER="TP_PAIR_OK"
# PR-4 (connect-on-pending): QR decode + PENDING persist emits TP_PAIR_PENDING at
# ingest; TP_PAIR_OK now fires only after the pairing PROMOTES (kx complete). In
# loopback kx is deterministic so TP_PAIR_OK reliably fires (M1 keeps asserting
# it). In real-daemon E2E kx is out-of-scope/racy (M0–M2 honest scope), so those
# modes assert M1 via TP_PAIR_PENDING (= the same "ingest succeeded" meaning M1
# always had).
PAIR_PENDING_MARKER="TP_PAIR_PENDING"
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
# M6 (push E2E, TP_E2E_PUSH): an inbound relay.notification was received by the app's
# production RelayClient.onNotification and handed to NotificationService. Asserted only
# under TP_E2E_PUSH — NOT part of the default smoke marker set.
PUSH_NOTIFY_RECEIVED_MARKER="TP_PUSH_NOTIFY_RECEIVED"
RELAY_LOOPBACK_PORT="${TP_RELAY_LOOPBACK_PORT:-7099}"
RELAY_LOOPBACK_SCRIPT="$REPO_ROOT/scripts/local-relay-loopback.ts"
XCFRAMEWORK="$REPO_ROOT/rust/target/TpCore.xcframework"
# Ad-hoc sign Simulator/macOS local builds so entitlements embed —
# the Simulator Keychain rejects SecItemAdd without an entitlement (-34018).
# No developer identity needed; "-" is accepted by both Simulator and macOS local.
SIGN_FLAGS="CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES"

# ── TestFlight archive/export (cmd_archive) ─────────────────────────────────────
#
# Distribution build outputs. Unlike the Simulator/macOS smoke paths (ad-hoc "-"),
# the TestFlight archive needs a REAL Apple Distribution identity + provisioning
# profile (injected into a temporary keychain by .github/workflows/testflight.yml
# in CI, or present in the developer's login keychain locally). cmd_archive branches
# on TP_PLATFORM via resolve_archive_params() (ADR-0004 Amendment 1): ios/ipad →
# generic/platform=iOS → .ipa (ExportOptions.plist; embeds the companion watch),
# macos → generic/platform=macOS → MAS .pkg (ExportOptions.macos.plist), visionos →
# generic/platform=visionOS → .ipa (ExportOptions.visionos.plist). watchos dies
# (the watch rides inside the iOS .ipa, #123). The per-platform ExportOptions path
# is ARCHIVE_EXPORT_OPTIONS, set in resolve_archive_params() — NOT a top-level var.
ARCHIVE_DIR="${TP_ARCHIVE_DIR:-$IOS_DIR/build/archive}"
ARCHIVE_PATH="$ARCHIVE_DIR/Teleprompter.xcarchive"
EXPORT_DIR="${TP_EXPORT_DIR:-$IOS_DIR/build/export}"

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

# ── uitest matrix result (parallel to the smoke emit above) ─────────────────────
# uitest has no named markers to track, so instead of the full smoke framework it
# carries a single three-valued result (PASS | SKIP | FAIL) that cmd_uitest_all
# renders in its matrix. Namespaced under TP_UITEST_JSON (NOT TP_JSON) so the two
# matrix formats stay independent — a `TP_JSON=1` run never triggers this emit and
# vice-versa. Registered on the same EXIT trap so it fires on any exit path
# (including `die`) once a uitest run has begun.
TP_UITEST_RESULT=""
TP_UITEST_START=0
tp_uitest_emit() {
  [ "${TP_UITEST_JSON:-}" = "1" ] || return 0
  [ -n "$TP_UITEST_RESULT" ] || return 0
  local elapsed=$(( $(tp_now) - TP_UITEST_START ))
  printf '{"platform":"%s","result":"%s","elapsed_s":%d}\n' \
    "$TP_PLATFORM" "$TP_UITEST_RESULT" "$elapsed"
  # Clear so a re-entrant loop doesn't double-emit a stale result.
  TP_UITEST_RESULT=""
}
tp_cleanup_add 'tp_uitest_emit'

# Resolve the UDID for $SIM_NAME among available iOS Simulator devices.
#
# Resolution order:
#   1. Exact `$SIM_NAME` match, preferring the HIGHEST iOS runtime (so a device
#      that exists on both iOS 18 and iOS 26 resolves to the 26 one, matching the
#      installed SDK — same rationale as vision_sim_udid).
#   2. FALLBACK: if no exact match (e.g. a CI runner whose preinstalled device
#      lineup differs from the local "iPhone 17 Pro" default), pick ANY available
#      iPhone on the highest iOS runtime. This keeps the headless CI smoke robust
#      against GitHub-runner device-name drift without the caller having to know
#      the exact model the runner ships. Locally the exact match always wins, so
#      behavior there is unchanged.
sim_udid() {
  xcrun simctl list devices available -j \
    | /usr/bin/python3 -c '
import json,sys
name=sys.argv[1]
d=json.load(sys.stdin)

def is_ios(runtime):
    r=runtime.lower()
    return "ios" in r and "vision" not in r and "watch" not in r and "tv" not in r

# Pass 1: exact name, highest iOS runtime.
best_udid=""; best_rt=""
for runtime,devs in d["devices"].items():
    if not is_ios(runtime):
        continue
    for dev in devs:
        if dev.get("isAvailable") and dev["name"]==name and runtime>best_rt:
            best_rt=runtime; best_udid=dev["udid"]
if best_udid:
    print(best_udid); sys.exit(0)

# Pass 2 (fallback): any available iPhone on the highest iOS runtime.
best_udid=""; best_rt=""
for runtime,devs in d["devices"].items():
    if not is_ios(runtime):
        continue
    for dev in devs:
        if dev.get("isAvailable") and dev["name"].startswith("iPhone") and runtime>best_rt:
            best_rt=runtime; best_udid=dev["udid"]
if best_udid:
    sys.stderr.write("[ios] sim_udid: exact \"%s\" not found; falling back to %s\n" % (name, best_udid))
    print(best_udid); sys.exit(0)

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
  # xcodegen prints "⚙️  Generating project..." to STDOUT. cmd_archive captures its
  # own stdout (the lone artifact path) into $GITHUB_OUTPUT via `IPA="$(… archive)"`,
  # and ensure_project()→cmd_gen runs inside that capture — so any xcodegen stdout
  # leaks into the captured value and corrupts the `ipa=<path>` GITHUB_OUTPUT line
  # ("Invalid format '⚙️  Generating project...'"). Redirect to stderr so only the
  # artifact path ever reaches stdout (same discipline as cmd_archive's xcodebuild >&2).
  ( cd "$IOS_DIR" && xcodegen generate ) >&2
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
# A built xcframework is VALID only if it carries its top-level Info.plist.
# A bare directory is not enough: CI caches can restore a half-written/corrupted
# xcframework dir (e.g. the slices but no Info.plist), and xcodebuild then hard-fails
# with "There is no Info.plist found at .../TpCore.xcframework/Info.plist". Validate
# the plist, not just the directory, so a corrupted cache triggers a rebuild instead
# of a confusing downstream build failure.
xcframework_valid() {
  [ -d "$XCFRAMEWORK" ] && [ -f "$XCFRAMEWORK/Info.plist" ]
}

ensure_xcframework() {
  if [ "${TP_SKIP_RUST:-}" = "1" ]; then
    log "TP_SKIP_RUST=1 — skipping xcframework build"
    xcframework_valid \
      || die "TP_SKIP_RUST set but xcframework absent/corrupt (missing Info.plist): $XCFRAMEWORK"
    return
  fi
  if xcframework_valid && [ "${1:-}" != "--force" ] && [ "${TP_FORCE_RUST:-}" != "1" ]; then
    log "xcframework present ($XCFRAMEWORK) — skipping rebuild (set TP_FORCE_RUST=1 to force)"
  else
    if [ -d "$XCFRAMEWORK" ] && ! xcframework_valid; then
      log "xcframework dir present but missing Info.plist (corrupt cache) — rebuilding"
    fi
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
    # CRITICAL: `simctl boot` is ASYNC — it returns immediately while the runtime
    # is still coming up. Locally the sim is usually already Booted so this never
    # bites, but on a COLD CI runner the sim starts Shutdown and the very next
    # `simctl install`/`launch` hits a not-yet-ready runtime: the app launch
    # silently no-ops and TP_BOOT_OK never fires (exactly the headless
    # swift-smoke-ios failure mode).
    #
    # `simctl bootstatus -b` is used as a BEST-EFFORT pre-wait, NOT a hard gate:
    # on a freshly-created CI sim the FIRST boot runs a one-time data migration
    # (CoreLocation/CloudRecents/… migrators) that can end in a non-clean terminal
    # status — bootstatus then exits non-zero (observed exit 148 with
    # Status=4294967295 "Finished") even though the device does reach a usable
    # Booted state moments later. So we run bootstatus to absorb most of the
    # migration wait, ignore its exit code, and then make the DEVICE STATE the
    # source of truth: poll `simctl list` until state==Booted (generous window for
    # the cold first-boot migration), dying only if it never gets there.
    log "waiting for boot to complete (bootstatus best-effort + state poll)…"
    if command -v timeout >/dev/null 2>&1; then
      timeout 240 xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
    else
      xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true
    fi
    # Authoritative wait: poll the device state. 0.5s × 360 = up to 180s after the
    # bootstatus pre-wait — comfortably covers the cold-sim data migration.
    local booted="" i
    for i in $(seq 1 360); do
      state="$(xcrun simctl list devices -j | /usr/bin/python3 -c '
import json,sys
u=sys.argv[1]; d=json.load(sys.stdin)
for devs in d["devices"].values():
    for dev in devs:
        if dev["udid"]==u: print(dev["state"]); sys.exit(0)
' "$udid" 2>/dev/null)"
      if [ "$state" = "Booted" ]; then booted="yes"; break; fi
      sleep 0.5
    done
    [ -n "$booted" ] || die "simulator never reached Booted state: $SIM_NAME ($udid) (last state: ${state:-unknown})"
    log "$SIM_NAME reached Booted state"
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
    # ONLY_ACTIVE_ARCH=YES: the iOS app now EMBEDS the companion watch app (#123),
    # so building the iOS Simulator app drags in a watchOS-Simulator build of
    # TeleprompterWatch. TpCore.xcframework's watchos-arm64-simulator slice is
    # arm64-ONLY (no x86_64) — without restricting to the active arch, the embedded
    # watch links against x86_64 and fails "symbol(s) not found for architecture
    # x86_64". On this (arm64) host the active arch is arm64, which the slice has.
    # Harmless for the iOS app itself (a local Simulator build only needs the host
    # arch); the universal device slices are still built in the Release archive.
    xcodebuild \
      -project "$PROJECT" \
      -scheme "$SCHEME" \
      -configuration Debug \
      -destination "id=$udid" \
      -derivedDataPath "$DERIVED" \
      $SIGN_FLAGS \
      ONLY_ACTIVE_ARCH=YES \
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
  parse_e2e_gates
  local real_e2e="$E2E_REAL" claude_e2e="$E2E_CLAUDE" claude_m5="$E2E_CLAUDE_M5" claude_coding="$E2E_CLAUDE_CODING" claude_webpage="$E2E_WEBPAGE" claude_push="$E2E_PUSH"
  # PR-4: M1 marker is mode-dependent. Real-daemon modes (kx out-of-scope/racy,
  # honest M0–M2) assert ingest via TP_PAIR_PENDING; loopback (deterministic kx →
  # promote) keeps TP_PAIR_OK.
  local m1_marker; if [ -n "$real_e2e" ]; then m1_marker="$PAIR_PENDING_MARKER"; else m1_marker="$PAIR_MARKER"; fi

  if [ -n "$claude_m5" ]; then
    # M0–M5: full input round-trip against an interactive real claude.
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  elif [ -n "$claude_e2e" ]; then
    # M0–M4: boot+core, pairing, relay-auth, kx, first-frame, session-render.
    # No M5 (input round-trip) — print mode ends before input arrives (use M5 mode).
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  elif [ -n "$real_e2e" ]; then
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER"
  else
    tp_smoke_begin "$TP_PLATFORM" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  fi

  # In claude mode, reuse the operator's own already-logged-in Claude Code token (read via
  # the standard macOS credential API) and export CLAUDE_CODE_OAUTH_TOKEN (the isolated
  # daemon's only auth vector). Token stays on the machine. Shared helper — no-op otherwise.
  reuse_operator_claude_token
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
    # Real daemon+relay: setup_real_link spawns the real claude session (per
    # $E2E_CLAUDE/$E2E_CLAUDE_M5), re-points $SMOKE_DAEMON_ID/$SMOKE_SESSION_ID at the
    # real dynamic ids, and leaves the pairing deep link in $REAL_PAIR_LINK.
    setup_real_link
    link="$REAL_PAIR_LINK"
  else
    start_loopback
    link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  fi

  # Terminate any prior instance before launching with the URL arg.
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$m1_marker did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  # Launch with retry: even after the device reports Booted, a cold CI sim may still
  # be warming SpringBoard/system apps (bootstatus's final "Waiting on System App"
  # phase), and the first `simctl launch` can fail (FBSOpenApplicationService error)
  # or no-op. Retry a few times so a transient warmup miss doesn't fail the whole
  # smoke. Locally (already-warm sim) the first attempt succeeds immediately.
  # In CODING/WEBPAGE mode the holder owns input, so suppress the app's auto-probe (it
  # would interleave with the holder's turns on the same REPL). In PUSH mode tell the
  # app to register a synthetic push token (--tp-push-smoke) so the daemon's push gate
  # opens (no real APNs token on the Simulator).
  local probe_arg=(); { [ -n "$claude_coding" ] || [ -n "$claude_webpage" ]; } && probe_arg=(--tp-no-input-probe)
  [ -n "$claude_push" ] && probe_arg+=(--tp-push-smoke)
  local launch_ok="" attempt
  for attempt in 1 2 3 4 5; do
    if xcrun simctl launch "$udid" "$BUNDLE_ID" -- --tp-smoke-url "$link" "${probe_arg[@]}" >/dev/null 2>&1; then
      launch_ok="yes"; break
    fi
    log "launch attempt $attempt failed (sim still warming?) — retrying in 3s"
    sleep 3
  done
  [ -n "$launch_ok" ] || die "SMOKE FAIL — app never launched after 5 attempts: $BUNDLE_ID on $SIM_NAME"

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
    pair_line="$(prefer_ok "$out" "$m1_marker" 'TP_PAIR_FAIL')"
    auth_line="$(prefer_ok "$out" "$RELAY_AUTH_OK_MARKER" "$RELAY_AUTH_FAIL_MARKER")"
    kx_line="$(prefer_ok "$out" "$KX_OK_MARKER" "$KX_FAIL_MARKER")"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(prefer_sid "$out" "$SESSION_OK_MARKER" "$SESSION_FAIL_MARKER")"
    input_line="$(prefer_sid "$out" "$INPUT_OK_MARKER" "$INPUT_FAIL_MARKER")"
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
  if [ -z "$boot_seen" ]; then
    # Boot marker miss is the classic headless-CI failure. Before dying, dump
    # diagnostics so a CI run is debuggable without a local repro: the app's
    # install/launch state and a raw (predicate-less) tail of the sim log. The
    # boot marker fires in TeleprompterApp.init() before any view, so a miss means
    # either the app process never really ran (cold-boot race — see cmd_boot
    # bootstatus) or it crashed before the os.Logger flushed.
    log "── boot-marker miss diagnostics ──────────────────────────────"
    log "app container: $(xcrun simctl get_app_container "$udid" "$BUNDLE_ID" 2>&1 || echo '(not installed)')"
    log "last 30s of ALL sim log lines mentioning teleprompter/Teleprompter:"
    xcrun simctl spawn "$udid" log show --last 30s --style compact 2>/dev/null \
      | grep -iE "teleprompter|TP_BOOT|TP_CORE|crash|fault|signal" | tail -40 >&2 || true
    log "──────────────────────────────────────────────────────────────"
    die "SMOKE FAIL — boot marker '$BOOT_MARKER' not seen in Simulator log"
  fi
  tp_mark "$BOOT_MARKER"
  [ -n "$core_line" ] || die "SMOKE FAIL — boot OK but no '$CORE_MARKER'/TP_CORE_FAIL line (tp-core FFI never ran?)"
  case "$core_line" in
    "$CORE_MARKER"*) tp_mark "$CORE_MARKER"; log "core OK — '$core_line'" ;;
    *) die "SMOKE FAIL — tp-core round-trip failed on-device: $core_line" ;;
  esac

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL — --tp-smoke-url injected but no '$m1_marker'/TP_PAIR_FAIL line (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$m1_marker did=$SMOKE_DAEMON_ID"*) tp_mark "$m1_marker"; log "pairing OK (M1) — '$pair_line'" ;;
    "$m1_marker"*) die "SMOKE FAIL — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
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
    [ -n "$claude_coding" ] && assert_coding_e2e
    [ -n "$claude_webpage" ] && assert_webpage_e2e
    [ -n "$claude_push" ] && assert_push_e2e "$udid"
    capture_sim_screenshot "$udid" "$TP_PLATFORM"
    tp_smoke_pass
    log "✅ REAL-CLAUDE E2E PASS — boot + core + pairing + relay-auth + kx + first-frame + real-Stop session-render (sid=$SMOKE_SESSION_ID) against a real tp daemon + real claude (M5 input round-trip out of scope for print mode)${claude_coding:+ + multi-turn CODING (Write+Bash) verified}${claude_webpage:+ + WEBPAGE (Write HTML5+Bash validate) verified}${claude_push:+ + in-band PUSH receive verified}"
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
  # Real-claude E2E gating, identical to the iOS path (see cmd_smoke_ios for the
  # mode taxonomy). Default = loopback (all 8 markers). TP_E2E_REAL/CLAUDE/CLAUDE_M5
  # swap in a genuine tp daemon+relay (+ real claude session) on the HOST — the macOS
  # app under test connects to it through the real relay exactly as a phone would.
  parse_e2e_gates
  local real_e2e="$E2E_REAL" claude_e2e="$E2E_CLAUDE" claude_m5="$E2E_CLAUDE_M5" claude_coding="$E2E_CLAUDE_CODING" claude_webpage="$E2E_WEBPAGE" claude_push="$E2E_PUSH"
  # PR-4: M1 marker is mode-dependent. Real-daemon modes (kx out-of-scope/racy,
  # honest M0–M2) assert ingest via TP_PAIR_PENDING; loopback (deterministic kx →
  # promote) keeps TP_PAIR_OK.
  local m1_marker; if [ -n "$real_e2e" ]; then m1_marker="$PAIR_PENDING_MARKER"; else m1_marker="$PAIR_MARKER"; fi

  # Marker set scales with reach: real_e2e (no session) → M0–M2; claude_e2e (print
  # session) → M0–M4; claude_m5 / loopback → all M0–M5.
  if [ -n "$claude_m5" ]; then
    tp_smoke_begin "macos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  elif [ -n "$claude_e2e" ]; then
    tp_smoke_begin "macos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  elif [ -n "$real_e2e" ]; then
    tp_smoke_begin "macos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER"
  else
    tp_smoke_begin "macos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  fi

  # In claude mode, reuse the operator's own already-logged-in Claude token before launching
  # (read via the standard macOS credential API; the isolated daemon's only auth vector). No-op otherwise.
  reuse_operator_claude_token

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
  security delete-generic-password -s "dev.tpmt.app.pairing" 2>/dev/null || true
  # Also clear the UserDefaults tp.pairings.index and tp.pairing.*.meta keys so the
  # app doesn't try to reconnect to a stale pairing on boot (which would block kx).
  defaults delete dev.tpmt.app tp.pairings.index 2>/dev/null || true
  defaults delete dev.tpmt.app tp.frontendId 2>/dev/null || true
  # Delete all tp.pairing.* keys (the pairing meta stored by PairingStore).
  for key in $(defaults read dev.tpmt.app 2>/dev/null | grep '"tp\.pairing\.' | awk -F'"' '{print $2}'); do
    defaults delete dev.tpmt.app "$key" 2>/dev/null || true
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
  # In CODING/WEBPAGE mode the holder owns input, so suppress the app's auto-probe (it
  # would interleave with the holder's turns on the same REPL). In PUSH mode tell the
  # app to register a synthetic push token (--tp-push-smoke) so the daemon's push gate
  # opens (no real APNs token on macOS either).
  local probe_arg=(); { [ -n "$claude_coding" ] || [ -n "$claude_webpage" ]; } && probe_arg=(--tp-no-input-probe)
  [ -n "$claude_push" ] && probe_arg+=(--tp-push-smoke)
  open -gn "$app" --args --tp-smoke "${probe_arg[@]}"
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

  # M1+M2: bring up the relay (real or loopback), then inject the deep link via
  # LaunchServices. Real mode stands up a genuine tp daemon+relay on the host and
  # re-points $SMOKE_DAEMON_ID/$SMOKE_SESSION_ID at the real dynamic ids; loopback
  # mode uses the fake scripted daemon + golden ids.
  local link
  if [ -n "$real_e2e" ]; then
    setup_real_link
    link="$REAL_PAIR_LINK"
  else
    start_loopback
    link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  fi
  log "opening pairing deep link via 'open -a' (route to THIS dev build)"
  # Register the URL scheme handler first: macOS LaunchServices caches the
  # handler list and a freshly built app may not be registered yet. Reboot
  # of LaunchServices DB via lsregister forces registration.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$app" 2>/dev/null || true
  # MUST target the dev build explicitly with `open -a "$app"`. A bare
  # `open "$link"` lets LaunchServices pick the tp:// handler by priority, and a
  # production app installed in /Applications (which outranks a DerivedData path)
  # steals the deep link — that instance has NO `--tp-smoke` arg, so its
  # RelayClient.isSmokeMode is false, the M5 auto-probe never fires, and the
  # smoke fails at M5 deterministically (M0-M4 still pass on the wrong instance).
  # `open -a "$app"` bypasses the handler-priority lookup and routes the URL to
  # the freshly launched dev build that actually carries --tp-smoke.
  open -a "$app" "$link"

  # Real-daemon modes add connection latency (stale auth.resume retries) + real
  # claude cold-start, and a stale-resume *_FAIL can sit alongside the real *_OK in
  # the same window — so widen the poll and prefer an OK line over a co-present FAIL
  # (mirrors the iOS path).
  local poll_iters=60
  if [ -n "$real_e2e" ]; then poll_iters=240; fi
  if [ -n "$claude_e2e" ]; then poll_iters=300; fi
  prefer_ok() { # <text> <ok-marker> <fail-marker>
    local ok; ok="$(printf '%s\n' "$1" | grep -Eo "$2[^\"]*" | tail -n1 || true)"
    if [ -n "$ok" ]; then printf '%s' "$ok"; else
      printf '%s\n' "$1" | grep -Eo "$2[^\"]*|$3[^\"]*" | tail -n1 || true
    fi
  }
  local pair_line="" auth_line="" kx_line="" frame_line="" session_line="" input_line=""
  for _ in $(seq 1 "$poll_iters"); do
    local out
    out="$(macos_log_snapshot)"
    pair_line="$(prefer_ok "$out" "$m1_marker" 'TP_PAIR_FAIL')"
    auth_line="$(prefer_ok "$out" "$RELAY_AUTH_OK_MARKER" "$RELAY_AUTH_FAIL_MARKER")"
    kx_line="$(prefer_ok "$out" "$KX_OK_MARKER" "$KX_FAIL_MARKER")"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(prefer_sid "$out" "$SESSION_OK_MARKER" "$SESSION_FAIL_MARKER")"
    input_line="$(prefer_sid "$out" "$INPUT_OK_MARKER" "$INPUT_FAIL_MARKER")"
    if [ -n "$claude_m5" ]; then
      [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ] && break
    elif [ -n "$claude_e2e" ]; then
      [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && break
    elif [ -n "$real_e2e" ]; then
      [ -n "$pair_line" ] && [ -n "$auth_line" ] && break
    else
      [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ] && break
    fi
    sleep 0.5
  done

  # M1 assertion.
  [ -n "$pair_line" ] || die "SMOKE FAIL (macOS) — deep link opened but no '$m1_marker'/TP_PAIR_FAIL (URL not routed to app? try: lsregister -f $app)"
  case "$pair_line" in
    "$m1_marker did=$SMOKE_DAEMON_ID"*) tp_mark "$m1_marker"; log "pairing OK (macOS M1) — '$pair_line'" ;;
    "$m1_marker"*) die "SMOKE FAIL (macOS) — pairing wrong daemon id: $pair_line" ;;
    *) die "SMOKE FAIL (macOS) — pairing ingestion failed: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (macOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (macOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (macOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (macOS) — relay auth failed: $auth_line" ;;
  esac

  # REAL daemon E2E (no spawned session) stops at M2: the genuine daemon→relay→app
  # AUTH pipeline is proven, but with no session the real daemon has nothing to push
  # (kx/frame/session out of scope — see start_real_daemon_relay).
  if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
    capture_macos_screenshot "macos"
    tp_smoke_pass
    log "✅ REAL-DAEMON E2E PASS (macOS) — boot + core + pairing + relay-auth against a real tp daemon (id=$SMOKE_DAEMON_ID) + real relay (M3–M5 out of scope headless)"
    return 0
  fi

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

  # REAL claude PRINT E2E (TP_E2E_CLAUDE, not M5) stops at M4: the app rendered the
  # real Stop hook's last_assistant_message (events>=1). Input round-trip (M5) needs
  # an interactive claude (print mode exits before the probe arrives) — that's
  # claude_m5, which continues below.
  if [ -n "$claude_e2e" ] && [ -z "$claude_m5" ]; then
    [ -n "$claude_coding" ] && assert_coding_e2e
    [ -n "$claude_webpage" ] && assert_webpage_e2e
    [ -n "$claude_push" ] && assert_push_e2e ""
    capture_macos_screenshot "macos"
    tp_smoke_pass
    log "✅ REAL-CLAUDE E2E PASS (macOS) — boot + core + pairing + relay-auth + kx + first-frame + real-Stop session-render (sid=$SMOKE_SESSION_ID) against a real tp daemon + real claude (M5 out of scope for print mode)${claude_coding:+ + multi-turn CODING (Write+Bash) verified}${claude_webpage:+ + WEBPAGE (Write HTML5+Bash validate) verified}${claude_push:+ + in-band PUSH receive verified}"
    return 0
  fi

  # M5 assertion.
  [ -n "$input_line" ] || die "SMOKE FAIL (macOS) — session OK but no '$INPUT_OK_MARKER'/'$INPUT_FAIL_MARKER'"
  case "$input_line" in
    "$INPUT_OK_MARKER sid=$SMOKE_SESSION_ID"*) tp_mark "$INPUT_OK_MARKER"; log "input OK (macOS M5) — '$input_line'" ;;
    "$INPUT_OK_MARKER"*) die "SMOKE FAIL (macOS) — input round-trip wrong sid: $input_line" ;;
    *) die "SMOKE FAIL (macOS) — input send/echo failed: $input_line" ;;
  esac

  # claude_m5 uses a real relay (no loopback /health to poll), so finish here with
  # the full 8-marker pass once M5 is confirmed.
  if [ -n "$claude_m5" ]; then
    capture_macos_screenshot "macos"
    tp_smoke_pass
    log "✅ REAL-CLAUDE M5 E2E PASS (macOS) — all 8 markers (M0–M5) against a real tp daemon + real INTERACTIVE claude: input round-trip (app→relay→daemon→PTY→claude→Stop→ChatItem) proven (sid=$SMOKE_SESSION_ID)"
    return 0
  fi

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
  # Real-claude E2E gating, identical to the iOS/macOS paths (see cmd_smoke_ios for
  # the mode taxonomy). The daemon+relay (+ real claude) run on the HOST; only the
  # app runs in the visionOS Simulator and connects through the real relay.
  parse_e2e_gates
  local real_e2e="$E2E_REAL" claude_e2e="$E2E_CLAUDE" claude_m5="$E2E_CLAUDE_M5" claude_coding="$E2E_CLAUDE_CODING" claude_webpage="$E2E_WEBPAGE" claude_push="$E2E_PUSH"
  # PR-4: M1 marker is mode-dependent. Real-daemon modes (kx out-of-scope/racy,
  # honest M0–M2) assert ingest via TP_PAIR_PENDING; loopback (deterministic kx →
  # promote) keeps TP_PAIR_OK.
  local m1_marker; if [ -n "$real_e2e" ]; then m1_marker="$PAIR_PENDING_MARKER"; else m1_marker="$PAIR_MARKER"; fi

  # Marker set scales with reach: real_e2e → M0–M2; claude_e2e → M0–M4; claude_m5 /
  # loopback → all M0–M5.
  if [ -n "$claude_m5" ]; then
    tp_smoke_begin "visionos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  elif [ -n "$claude_e2e" ]; then
    tp_smoke_begin "visionos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  elif [ -n "$real_e2e" ]; then
    tp_smoke_begin "visionos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER"
  else
    tp_smoke_begin "visionos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER" "$INPUT_OK_MARKER"
  fi

  # In claude mode, reuse the operator's own already-logged-in Claude token before launching
  # (read via the standard macOS credential API; the isolated daemon's only auth vector). No-op otherwise.
  reuse_operator_claude_token

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

  # M1+M2: bring the relay up BEFORE launching, then launch with --tp-smoke-url to
  # bypass LaunchServices URL-scheme approval (same fix as iOS path — simctl openurl
  # hits the -10814 bundle-record approval error on visionOS Simulator too). Real
  # mode swaps the loopback for a genuine host tp daemon+relay and re-points the
  # marker ids; loopback mode uses the fake scripted daemon + golden ids.
  local link
  if [ -n "$real_e2e" ]; then
    setup_real_link
    link="$REAL_PAIR_LINK"
  else
    start_loopback
    link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  fi

  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (visionOS M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$m1_marker did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  # In CODING/WEBPAGE mode the holder owns input, so suppress the app's auto-probe. In
  # PUSH mode tell the app to register a synthetic push token (--tp-push-smoke).
  local probe_arg=(); { [ -n "$claude_coding" ] || [ -n "$claude_webpage" ]; } && probe_arg=(--tp-no-input-probe)
  [ -n "$claude_push" ] && probe_arg+=(--tp-push-smoke)
  xcrun simctl launch "$udid" "$BUNDLE_ID" -- --tp-smoke-url "$link" "${probe_arg[@]}" >/dev/null

  # Poll all markers in one loop. Real-daemon modes add connection latency + real
  # claude cold-start, and a stale-resume *_FAIL can sit alongside the real *_OK in
  # the same window — so widen the poll, widen the log window, and prefer an OK line
  # over a co-present FAIL (mirrors the iOS path).
  local poll_iters=90 snap_secs=90
  if [ -n "$real_e2e" ]; then poll_iters=240; snap_secs=240; fi
  if [ -n "$claude_e2e" ]; then poll_iters=300; snap_secs=300; fi
  prefer_ok() { # <text> <ok-marker> <fail-marker>
    local ok; ok="$(printf '%s\n' "$1" | grep -Eo "$2[^\"]*" | tail -n1 || true)"
    if [ -n "$ok" ]; then printf '%s' "$ok"; else
      printf '%s\n' "$1" | grep -Eo "$2[^\"]*|$3[^\"]*" | tail -n1 || true
    fi
  }
  local boot_seen="" core_line="" pair_line="" auth_line="" kx_line="" frame_line="" session_line="" input_line=""
  for _ in $(seq 1 "$poll_iters"); do
    local out
    out="$(xcrun simctl spawn "$udid" log show --last "${snap_secs}s" --style compact \
      --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null || true)"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(prefer_ok "$out" 'TP_CORE_OK' 'TP_CORE_FAIL')"
    pair_line="$(prefer_ok "$out" "$m1_marker" 'TP_PAIR_FAIL')"
    auth_line="$(prefer_ok "$out" "$RELAY_AUTH_OK_MARKER" "$RELAY_AUTH_FAIL_MARKER")"
    kx_line="$(prefer_ok "$out" "$KX_OK_MARKER" "$KX_FAIL_MARKER")"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(prefer_sid "$out" "$SESSION_OK_MARKER" "$SESSION_FAIL_MARKER")"
    input_line="$(prefer_sid "$out" "$INPUT_OK_MARKER" "$INPUT_FAIL_MARKER")"
    if [ -n "$claude_m5" ]; then
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ] && break
    elif [ -n "$claude_e2e" ]; then
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && break
    elif [ -n "$real_e2e" ]; then
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && break
    else
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && [ -n "$input_line" ] && break
    fi
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
  [ -n "$pair_line" ] || die "SMOKE FAIL (visionOS) — --tp-smoke-url injected but no '$m1_marker'/TP_PAIR_FAIL (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$m1_marker did=$SMOKE_DAEMON_ID"*) tp_mark "$m1_marker"; log "pairing OK (visionOS M1) — '$pair_line'" ;;
    "$m1_marker"*) die "SMOKE FAIL (visionOS) — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL (visionOS) — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (visionOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (visionOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (visionOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (visionOS) — relay auth failed on-device: $auth_line" ;;
  esac

  # REAL daemon E2E (no spawned session) stops at M2 — the real daemon has no session
  # to push (kx/frame/session out of scope; see start_real_daemon_relay).
  if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
    capture_sim_screenshot "$udid" "visionos"
    tp_smoke_pass
    log "✅ REAL-DAEMON E2E PASS (visionOS) — boot + core + pairing + relay-auth against a real tp daemon (id=$SMOKE_DAEMON_ID) + real relay (M3–M5 out of scope headless)"
    return 0
  fi

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

  # REAL claude PRINT E2E (TP_E2E_CLAUDE, not M5) stops at M4 — the app rendered the
  # real Stop hook's last_assistant_message. M5 needs an interactive claude (claude_m5).
  if [ -n "$claude_e2e" ] && [ -z "$claude_m5" ]; then
    [ -n "$claude_coding" ] && assert_coding_e2e
    [ -n "$claude_webpage" ] && assert_webpage_e2e
    [ -n "$claude_push" ] && assert_push_e2e "$udid"
    capture_sim_screenshot "$udid" "visionos"
    tp_smoke_pass
    log "✅ REAL-CLAUDE E2E PASS (visionOS) — boot + core + pairing + relay-auth + kx + first-frame + real-Stop session-render (sid=$SMOKE_SESSION_ID) against a real tp daemon + real claude (M5 out of scope for print mode)${claude_coding:+ + multi-turn CODING (Write+Bash) verified}${claude_webpage:+ + WEBPAGE (Write HTML5+Bash validate) verified}${claude_push:+ + in-band PUSH receive verified}"
    return 0
  fi

  # M5 assertion — input round-trip.
  [ -n "$input_line" ] || die "SMOKE FAIL (visionOS) — session OK but no '$INPUT_OK_MARKER'/'$INPUT_FAIL_MARKER' (input never sent/echoed?)"
  case "$input_line" in
    "$INPUT_OK_MARKER sid=$SMOKE_SESSION_ID"*) tp_mark "$INPUT_OK_MARKER"; log "input OK (visionOS M5) — '$input_line'" ;;
    "$INPUT_OK_MARKER"*) die "SMOKE FAIL (visionOS) — input round-trip wrong sid: $input_line (want sid=$SMOKE_SESSION_ID)" ;;
    *) die "SMOKE FAIL (visionOS) — input send/echo failed on-device: $input_line" ;;
  esac

  # claude_m5 uses a real relay (no loopback /health to poll), so finish here.
  if [ -n "$claude_m5" ]; then
    capture_sim_screenshot "$udid" "visionos"
    tp_smoke_pass
    log "✅ REAL-CLAUDE M5 E2E PASS (visionOS) — all 8 markers (M0–M5) against a real tp daemon + real INTERACTIVE claude: input round-trip (app→relay→daemon→PTY→claude→Stop→ChatItem) proven on $VISION_SIM_NAME (sid=$SMOKE_SESSION_ID)"
    return 0
  fi

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
  # Real-claude E2E gating, same taxonomy as the iOS/macOS/visionOS paths (see
  # cmd_smoke_ios), with ONE watch-specific cap: TP_INPUT_OK (M5) is never checked
  # — the watch app is a read-mostly glance experience with no terminal input
  # (ADR-0002 §watchOS). So watchOS tops out at M0–M4 (7 markers) in every mode;
  # there is no 8-marker branch, and claude_m5 collapses onto claude_e2e here
  # (TP_E2E_CLAUDE_M5 implies claude_e2e via parse_e2e_gates — the extra M5 reach
  # is simply N/A on watch). The daemon+relay (+ real claude PRINT session) run on
  # the HOST; only the watch app runs in the Simulator and connects through the
  # real relay.
  parse_e2e_gates
  local real_e2e="$E2E_REAL" claude_e2e="$E2E_CLAUDE" claude_coding="$E2E_CLAUDE_CODING" claude_webpage="$E2E_WEBPAGE" claude_push="$E2E_PUSH"
  # PR-4: M1 marker is mode-dependent (see cmd_smoke_ios).
  local m1_marker; if [ -n "$real_e2e" ]; then m1_marker="$PAIR_PENDING_MARKER"; else m1_marker="$PAIR_MARKER"; fi

  # Marker set scales with reach: real_e2e → M0–M2 (4 markers); claude_e2e /
  # loopback → M0–M4 (7 markers). No M5 on watch in any mode.
  if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
    tp_smoke_begin "watchos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER"
  else
    tp_smoke_begin "watchos" \
      "$BOOT_MARKER" "$CORE_MARKER" "$m1_marker" "$RELAY_AUTH_OK_MARKER" \
      "$KX_OK_MARKER" "$FRAME_OK_MARKER" "$SESSION_OK_MARKER"
  fi

  # In claude mode, reuse the operator's own already-logged-in Claude token before launching
  # (read via the standard macOS credential API; the isolated daemon's only auth vector). No-op otherwise.
  reuse_operator_claude_token

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

  # M1+M2: bring the relay up BEFORE launching, then launch with --tp-smoke-url to
  # bypass LaunchServices URL-scheme approval (same fix as iOS/visionOS path). Real
  # mode swaps the loopback for a genuine host tp daemon+relay (+ real claude PRINT
  # session) and re-points the marker ids; loopback mode uses the fake scripted
  # daemon + golden ids.
  local link
  if [ -n "$real_e2e" ]; then
    setup_real_link
    link="$REAL_PAIR_LINK"
  else
    start_loopback
    link="$(smoke_pair_link "$SMOKE_DAEMON_ID" "ws://localhost:$RELAY_LOOPBACK_PORT" "golden")"
  fi

  xcrun simctl terminate "$udid" "$WATCH_BUNDLE_ID" >/dev/null 2>&1 || true
  log "launching with --tp-smoke-url (watchOS M0+M1+M2) — want '$BOOT_MARKER' + '$CORE_MARKER' + '$m1_marker did=$SMOKE_DAEMON_ID' + '$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID'"
  # In CODING/WEBPAGE mode the holder owns input, so suppress the app's auto-probe. In
  # PUSH mode tell the app to register a synthetic push token (--tp-push-smoke).
  local probe_arg=(); { [ -n "$claude_coding" ] || [ -n "$claude_webpage" ]; } && probe_arg=(--tp-no-input-probe)
  [ -n "$claude_push" ] && probe_arg+=(--tp-push-smoke)
  xcrun simctl launch "$udid" "$WATCH_BUNDLE_ID" -- --tp-smoke-url "$link" "${probe_arg[@]}" >/dev/null

  # Poll markers (no TP_INPUT_OK on watch — no terminal input per ADR-0002 §watchOS).
  # Generous loop: watchOS Simulator log delivery can lag behind iOS. Real-daemon
  # modes add connection latency + real claude cold-start, and a stale-resume *_FAIL
  # can sit alongside the real *_OK in the same window — so widen the poll/log window
  # and prefer an OK line over a co-present FAIL (mirrors the iOS/visionOS path).
  local poll_iters=120 snap_secs=120
  if [ -n "$real_e2e" ]; then poll_iters=240; snap_secs=240; fi
  if [ -n "$claude_e2e" ]; then poll_iters=300; snap_secs=300; fi
  prefer_ok() { # <text> <ok-marker> <fail-marker>
    local ok; ok="$(printf '%s\n' "$1" | grep -Eo "$2[^\"]*" | tail -n1 || true)"
    if [ -n "$ok" ]; then printf '%s' "$ok"; else
      printf '%s\n' "$1" | grep -Eo "$2[^\"]*|$3[^\"]*" | tail -n1 || true
    fi
  }
  local boot_seen="" core_line="" pair_line="" auth_line="" kx_line="" frame_line="" session_line=""
  for _ in $(seq 1 "$poll_iters"); do
    local out
    out="$(xcrun simctl spawn "$udid" log show --last "${snap_secs}s" --style compact \
      --predicate "subsystem == \"$BUNDLE_ID\"" 2>/dev/null || true)"
    case "$out" in *"$BOOT_MARKER"*) boot_seen="yes" ;; esac
    core_line="$(prefer_ok "$out" 'TP_CORE_OK' 'TP_CORE_FAIL')"
    pair_line="$(prefer_ok "$out" "$m1_marker" 'TP_PAIR_FAIL')"
    auth_line="$(prefer_ok "$out" "$RELAY_AUTH_OK_MARKER" "$RELAY_AUTH_FAIL_MARKER")"
    kx_line="$(prefer_ok "$out" "$KX_OK_MARKER" "$KX_FAIL_MARKER")"
    frame_line="$(printf '%s\n' "$out" | grep -Eo "${FRAME_OK_MARKER}[^\"]*|${FRAME_FAIL_MARKER}[^\"]*" | tail -n1 || true)"
    session_line="$(prefer_sid "$out" "$SESSION_OK_MARKER" "$SESSION_FAIL_MARKER")"
    if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && break
    else
      [ -n "$boot_seen" ] && [ -n "$core_line" ] && [ -n "$pair_line" ] && [ -n "$auth_line" ] && [ -n "$kx_line" ] && [ -n "$frame_line" ] && [ -n "$session_line" ] && break
    fi
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
  [ -n "$pair_line" ] || die "SMOKE FAIL (watchOS) — --tp-smoke-url injected but no '$m1_marker'/TP_PAIR_FAIL (DeepLinkHandler.handle never ran?)"
  case "$pair_line" in
    "$m1_marker did=$SMOKE_DAEMON_ID"*) tp_mark "$m1_marker"; log "pairing OK (watchOS M1) — '$pair_line'" ;;
    "$m1_marker"*) die "SMOKE FAIL (watchOS) — pairing wrong daemon id: $pair_line (want did=$SMOKE_DAEMON_ID)" ;;
    *) die "SMOKE FAIL (watchOS) — pairing ingestion failed on-device: $pair_line" ;;
  esac

  # M2 assertion.
  [ -n "$auth_line" ] || die "SMOKE FAIL (watchOS) — paired but no '$RELAY_AUTH_OK_MARKER'/'$RELAY_AUTH_FAIL_MARKER' (relay connect never ran?)"
  case "$auth_line" in
    "$RELAY_AUTH_OK_MARKER daemon=$SMOKE_DAEMON_ID"*) tp_mark "$RELAY_AUTH_OK_MARKER"; log "relay auth OK (watchOS M2) — '$auth_line'" ;;
    "$RELAY_AUTH_OK_MARKER"*) die "SMOKE FAIL (watchOS) — relay auth wrong daemon: $auth_line" ;;
    *) die "SMOKE FAIL (watchOS) — relay auth failed on-device: $auth_line" ;;
  esac

  # REAL daemon E2E (no spawned session) stops at M2 — the real daemon has no session
  # to push (kx/frame/session out of scope; see start_real_daemon_relay).
  if [ -n "$real_e2e" ] && [ -z "$claude_e2e" ]; then
    capture_sim_screenshot "$udid" "watchos"
    tp_smoke_pass
    log "✅ REAL-DAEMON E2E PASS (watchOS) — boot + core + pairing + relay-auth against a real tp daemon (id=$SMOKE_DAEMON_ID) + real relay (M3–M4 out of scope headless; M5 N/A on watch)"
    return 0
  fi

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

  # NOTE: TP_INPUT_OK (M5) is intentionally NOT checked on watchOS in ANY mode. The
  # watch app provides a read-mostly glance experience — no terminal input
  # (ADR-0002 §4). So watchOS caps at M4 even under TP_E2E_CLAUDE_M5.

  # REAL claude PRINT E2E (TP_E2E_CLAUDE) stops at M4 — the watch rendered the real
  # Stop hook's last_assistant_message over a genuine daemon+relay+claude. There is
  # no loopback relay to /health-poll, so finish here.
  if [ -n "$claude_e2e" ]; then
    [ -n "$claude_coding" ] && assert_coding_e2e
    [ -n "$claude_webpage" ] && assert_webpage_e2e
    [ -n "$claude_push" ] && assert_push_e2e "$udid"
    capture_sim_screenshot "$udid" "watchos"
    tp_smoke_pass
    log "✅ REAL-CLAUDE E2E PASS (watchOS) — 7/7 markers: boot + core + pairing + relay-auth + kx + first-frame + real-Stop session-render (sid=$SMOKE_SESSION_ID) against a real tp daemon + real claude on $WATCH_SIM_NAME (M5 N/A on watch)${claude_coding:+ + multi-turn CODING (Write+Bash) verified}${claude_webpage:+ + WEBPAGE (Write HTML5+Bash validate) verified}${claude_push:+ + in-band PUSH receive verified}"
    return 0
  fi

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

# ── Shared real-claude E2E helpers (iOS / macOS / visionOS) ─────────────────────
#
# Three smoke paths (iOS-family, macOS-native, visionOS) all gate the same way on
# TP_E2E_REAL / TP_E2E_CLAUDE / TP_E2E_CLAUDE_M5 and, in claude mode, all need the
# same OAuth-token extraction + the same real-daemon link setup. These helpers
# factor that shared logic so the three platform smoke functions stay byte-identical
# in their real-claude prelude (the only platform-specific part is how the app is
# launched + how markers are scraped from that platform's log surface).
#
# Modes (increasing reach), identical across platforms:
#   loopback  (default)        — fake scripted daemon, all markers (M0–M5).
#   real_e2e  (TP_E2E_REAL)    — real tp daemon+relay, no session: M0–M2.
#   claude_e2e(TP_E2E_CLAUDE)  — real daemon + real `claude -p` PRINT session: M0–M4.
#   claude_m5 (TP_E2E_CLAUDE_M5)— real daemon + real INTERACTIVE claude: all M0–M5.
# Each higher mode implies the ones below it (claude_m5 ⊃ claude_e2e ⊃ real_e2e).

# parse_e2e_gates — read TP_E2E_* env into the globals E2E_REAL / E2E_CLAUDE /
# E2E_CLAUDE_M5 / E2E_CLAUDE_CODING ("yes" or ""). Same precedence the iOS path used inline.
#
# E2E_CLAUDE_CODING is a SIBLING of E2E_CLAUDE_M5, not a superset: both imply the real
# daemon + a real claude session (so both imply E2E_REAL + E2E_CLAUDE), but they exercise
# DIFFERENT, MUTUALLY-EXCLUSIVE reach over the same single session. M5 keeps the app's
# input probe round-trip; CODING instead has the HOLDER drive multiple coding turns
# (Write+Bash) and SUPPRESSES the app probe (--tp-no-input-probe) so it can't interleave
# with the holder's turns on the shared REPL. The two cannot both run against one session:
# the probe being suppressed means TP_INPUT_OK can never fire. So when BOTH gates are set,
# CODING WINS — E2E_CLAUDE_M5 is cleared below, the M5 marker is not registered, and the
# coding assertion (not the M5 assertion) runs. To exercise M5, run it WITHOUT the coding
# gate. (Run them as two separate invocations for full M0–M5 + coding coverage.)
E2E_REAL="" E2E_CLAUDE="" E2E_CLAUDE_M5="" E2E_CLAUDE_CODING="" E2E_WEBPAGE=""
parse_e2e_gates() {
  E2E_REAL="" E2E_CLAUDE="" E2E_CLAUDE_M5="" E2E_CLAUDE_CODING="" E2E_WEBPAGE="" E2E_PUSH=""
  [ "${TP_E2E_REAL:-}" = "1" ] && E2E_REAL="yes"
  [ "${TP_E2E_CLAUDE:-}" = "1" ] && { E2E_REAL="yes"; E2E_CLAUDE="yes"; }
  [ "${TP_E2E_CLAUDE_M5:-}" = "1" ] && { E2E_REAL="yes"; E2E_CLAUDE="yes"; E2E_CLAUDE_M5="yes"; }
  [ "${TP_E2E_CLAUDE_CODING:-}" = "1" ] && { E2E_REAL="yes"; E2E_CLAUDE="yes"; E2E_CLAUDE_CODING="yes"; }
  # WEBPAGE (TP_E2E_WEBPAGE): a SIBLING of CODING — holder drives two webpage-building turns
  # (Write an HTML5 file, Bash-validate it) instead of the generic coding turns. Implies
  # E2E_REAL + E2E_CLAUDE exactly like CODING. Suppresses M5 probe for the same reason.
  # WEBPAGE wins over CODING when both are set (webpage checked first → clears coding) so
  # only one multi-turn mode is active and --run-claude-webpage has clear precedence in
  # start_real_daemon_relay.
  [ "${TP_E2E_WEBPAGE:-}" = "1" ] && { E2E_REAL="yes"; E2E_CLAUDE="yes"; E2E_WEBPAGE="yes"; E2E_CLAUDE_CODING=""; }
  # PUSH (TP_E2E_PUSH): a SIBLING gate that implies a real daemon + a real claude PRINT
  # session — it needs a session DB (so the injected `rec` has a target) and a live app
  # on the socket (so the relay delivers the push in-band). Orthogonal to how the
  # session is driven; the simplest first cut rides print-mode E2E_CLAUDE.
  [ "${TP_E2E_PUSH:-}" = "1" ] && { E2E_REAL="yes"; E2E_CLAUDE="yes"; E2E_PUSH="yes"; }
  # CODING, WEBPAGE, and PUSH all win over M5 when co-requested (M5 is interactive;
  # CODING/WEBPAGE/PUSH ride the holder-owned input path). Clearing E2E_CLAUDE_M5 makes
  # `claude_m5` empty downstream, so the marker set excludes TP_INPUT_OK and the M4
  # early-return fires — which is the only place the coding/webpage/push assertions run.
  { [ -n "$E2E_CLAUDE_CODING" ] || [ -n "$E2E_WEBPAGE" ] || [ -n "$E2E_PUSH" ]; } && E2E_CLAUDE_M5=""
  # Force success: the script runs under `set -e`, and the last `[ … ] && …` short-
  # circuits to exit 1 when the gate is unset (the common loopback case). Without this
  # the function would return 1 and abort its caller. (This bit cmd_smoke_macos.)
  return 0
}

# reuse_operator_claude_token — when $E2E_CLAUDE, REUSE THE OPERATOR'S OWN already-logged-in
# Claude Code OAuth token so the isolated test daemon can authenticate as the same user who
# runs claude every day. It refreshes the token, then reads it via macOS's standard
# credential API and exports CLAUDE_CODE_OAUTH_TOKEN. The token never leaves the machine.
# The isolated test HOME has no credentials of its own, so this is the only auth vector for
# the spawned claude. Keychain service = `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>`.
# No-op when not in claude mode. (Host-side — same for every platform, since the daemon
# always runs on the host. Local-only; never runs in CI.)
reuse_operator_claude_token() {
  [ -n "$E2E_CLAUDE" ] || return 0
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
}

# setup_real_link — stand up the real daemon+relay (start_real_daemon_relay), then
# re-point the golden marker IDs ($SMOKE_DAEMON_ID / $SMOKE_SESSION_ID) at the real
# dynamic ones so the did= / sid= assertions match. Honors $E2E_CLAUDE / $E2E_CLAUDE_M5
# for the spawn flags. Call ONLY when $E2E_REAL is set; loopback callers build a golden
# link. After return the pairing deep link is in $REAL_PAIR_LINK — read it directly; do
# NOT call this in a command-substitution subshell or the ID re-points won't propagate.
setup_real_link() {
  REAL_RUN_CLAUDE="$E2E_CLAUDE"
  REAL_RUN_CLAUDE_M5="$E2E_CLAUDE_M5"
  REAL_RUN_CLAUDE_CODING="$E2E_CLAUDE_CODING"
  REAL_RUN_CLAUDE_WEBPAGE="$E2E_WEBPAGE"
  REAL_SPAWN_PUSH="$E2E_PUSH"
  start_real_daemon_relay
  SMOKE_DAEMON_ID="$REAL_DAEMON_ID"
  if [ -n "$E2E_CLAUDE" ] && [ -n "${REAL_SESSION_SID:-}" ]; then
    SMOKE_SESSION_ID="$REAL_SESSION_SID"
    log "claude session sid=$SMOKE_SESSION_ID (M4 assertion re-pointed)"
  fi
  return 0  # never let a false trailing `if` return 1 under `set -e`
}

# prefer_sid — extract a sid-keyed marker (TP_SESSION_OK / TP_INPUT_OK) from a log
# blob, preferring the line whose `sid=$SMOKE_SESSION_ID` matches, falling back to the
# last OK|FAIL line. Without this, a unified-log window that still holds a PRIOR run's
# same-marker line with a DIFFERENT sid (e.g. a real-mode `real-smoke-sess` line left
# over before a loopback `sess-smoketest` run on the same sim) can shadow the current
# run via a blind `tail -n1`, failing the assertion with "wrong sid". The fallback
# preserves the old behavior when no sid match exists, so loopback-only/CI runs are
# byte-identical. Args: <text> <ok-marker> <fail-marker>.
prefer_sid() {
  local hit; hit="$(printf '%s\n' "$1" | grep -E "$2 sid=$SMOKE_SESSION_ID( |$)" | tail -n1 || true)"
  if [ -n "$hit" ]; then
    # Trim to the marker token run (strip any trailing quote/garbage), matching the
    # grep -Eo shape used by the non-sid callers.
    printf '%s' "$hit" | grep -Eo "$2[^\"]*" | tail -n1 || true
  else
    printf '%s\n' "$1" | grep -Eo "$2[^\"]*|$3[^\"]*" | tail -n1 || true
  fi
}

# assert_coding_e2e — the TP_E2E_CLAUDE_CODING assertion. After the app rendered the
# real claude session (M0–M4 already passed), verify the HOLDER actually drove multiple
# CODING turns through the genuine pipeline by checking the deterministic side effects in
# the isolated dir ($REAL_E2E_DIR), NOT model text:
#   1. the file claude was told to write exists under the isolated cwd and its body is
#      exactly the marker (proves the Write tool ran with the controller's instruction)
#   2. the per-session DB has UserPromptSubmit >= 2 (two app-pipeline turns landed) and
#      Stop >= 2 (claude finished both turns)
#   3. the DB has a PostToolUse event with tool_name=Write AND one with tool_name=Bash,
#      both referencing the marker file (proves claude used those tools ON THE
#      CONTROLLER'S INSTRUCTIONS — a structured hook-event check, not a substring scan
#      of the ANSI-laden PTY io stream, which would false-positive on the command echo)
# Reads the SAME DB path layout the holder's countRecords uses (store/config.ts +
# store.ts). Call ONLY when $E2E_CLAUDE_CODING and after M4; dies on any failure.
assert_coding_e2e() {
  local sid="${SMOKE_SESSION_ID:-real-smoke-sess}"
  local marker="${TP_E2E_CODING_MARKER:-QA-CODING-OK}"
  local file="${TP_E2E_CODING_FILE:-tp_qa_marker.txt}"
  [ -n "$REAL_E2E_DIR" ] || die "CODING E2E FAIL — REAL_E2E_DIR unset (real daemon not started?)"
  local cwd="$REAL_E2E_DIR/home/work"
  local db="$REAL_E2E_DIR/data/teleprompter/vault/sessions/$sid.sqlite"

  # The holder gates turn 2 on Stop #1 and waits up to 180s for Stop #2, but the smoke
  # marker poll may have observed M4 (the FIRST Stop) before turn 2 even started. So give
  # the coding turns their own settle window here: poll the DB for the 2-turn shape +
  # the on-disk file before asserting, rather than reading once and failing a live run.
  [ -f "$db" ] || die "CODING E2E FAIL — session DB not found at $db"
  local deadline=$(( $(date +%s) + 240 )) ups=0 stops=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    ups="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='UserPromptSubmit';" 2>/dev/null || echo 0)"
    stops="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='Stop';" 2>/dev/null || echo 0)"
    { [ "${ups:-0}" -ge 2 ] && [ "${stops:-0}" -ge 2 ] && [ -f "$cwd/$file" ]; } && break
    sleep 2
  done

  # 1. the file claude wrote.
  [ -f "$cwd/$file" ] || die "CODING E2E FAIL — claude never created $cwd/$file (Write tool turn 1 did not land)"
  local body; body="$(cat "$cwd/$file" 2>/dev/null | tr -d '[:space:]')"
  [ "$body" = "$marker" ] || die "CODING E2E FAIL — $file body is '$body' (expected '$marker')"
  log "coding E2E — file OK: $cwd/$file contains '$marker' (Write tool ran)"

  # 2. the 2-turn session-DB shape.
  [ "${ups:-0}" -ge 2 ] || die "CODING E2E FAIL — UserPromptSubmit=$ups (expected >=2; two coding turns did not both land over the pipeline)"
  [ "${stops:-0}" -ge 2 ] || die "CODING E2E FAIL — Stop=$stops (expected >=2; claude did not finish both turns)"
  log "coding E2E — DB OK: UserPromptSubmit=$ups, Stop=$stops (two real turns landed + completed)"

  # 3. Structured tool-use proof from the hook events. PostToolUse payloads carry
  # "tool_name":"<Tool>" and the tool_input (which includes the filename) — a far
  # stronger signal than scanning the ANSI-laden io stream (which would match the
  # typed command's ECHO, a false positive). Require:
  #   - a PostToolUse with tool_name=Write referencing the marker file (turn 1)
  #   - a PostToolUse with tool_name=Bash referencing the marker file (turn 2)
  # Both must name the file so the probe's unrelated tool calls can't satisfy them.
  #
  # The tool_name match is a constant LIKE pattern (no metachars). The FILENAME match
  # uses instr() — a LITERAL substring search — NOT LIKE: a filename can contain LIKE
  # wildcards ('_' is in the default `tp_qa_marker.txt`, and TP_E2E_CODING_FILE could
  # carry '%'/'_'), which under LIKE would silently over-match (match the wrong rows).
  # instr() has no wildcard semantics, so the filename is matched verbatim regardless.
  local write_hits bash_hits
  write_hits="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='PostToolUse' AND CAST(payload AS TEXT) LIKE '%\"tool_name\":\"Write\"%' AND instr(CAST(payload AS TEXT), '$file') > 0;" 2>/dev/null || echo 0)"
  [ "${write_hits:-0}" -ge 1 ] || die "CODING E2E FAIL — no PostToolUse(Write) referencing '$file' (claude did not use the Write tool on turn 1's instruction)"
  log "coding E2E — Write tool OK: PostToolUse(Write) referencing '$file' ($write_hits)"
  bash_hits="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='PostToolUse' AND CAST(payload AS TEXT) LIKE '%\"tool_name\":\"Bash\"%' AND instr(CAST(payload AS TEXT), '$file') > 0;" 2>/dev/null || echo 0)"
  [ "${bash_hits:-0}" -ge 1 ] || die "CODING E2E FAIL — no PostToolUse(Bash) referencing '$file' (claude did not run turn 2's shell command)"
  log "coding E2E — Bash tool OK: PostToolUse(Bash) referencing '$file' ($bash_hits)"

  log "✅ CODING E2E PASS — the app→relay→daemon→PTY pipeline carried 2 real coding turns to claude (Write tool created the file, Bash tool read it back); all side effects verified on disk + in the session DB hook events"
}

# assert_webpage_e2e — the TP_E2E_WEBPAGE assertion. After the app rendered the real
# claude session (M0–M4 already passed), verify the HOLDER actually drove TWO WEBPAGE
# turns through the genuine pipeline by checking deterministic side effects in the
# isolated dir ($REAL_E2E_DIR), NOT model text:
#   1. the HTML5 file claude was told to write exists under the isolated cwd and its body
#      contains ALL of: <!DOCTYPE html>, <html, <body, </html>, the marker string, and at
#      least one <style tag (proves the Write tool ran with the controller's instruction
#      and produced a real HTML5 document, not a stub)
#   2. the per-session DB has UserPromptSubmit >= 2 (two app-pipeline turns landed) and
#      Stop >= 2 (claude finished both turns)
#   3. the DB has a PostToolUse event with tool_name=Write AND one with tool_name=Bash,
#      both referencing the html filename (structured hook-event check — not an ANSI io
#      scan which would false-positive on the command echo)
# Same DB path layout as assert_coding_e2e. Call ONLY when $E2E_WEBPAGE and after M4.
assert_webpage_e2e() {
  local sid="${SMOKE_SESSION_ID:-real-smoke-sess}"
  local marker="${TP_E2E_WEBPAGE_MARKER:-TP-WEBPAGE-OK}"
  local file="${TP_E2E_WEBPAGE_FILE:-index.html}"
  [ -n "$REAL_E2E_DIR" ] || die "WEBPAGE E2E FAIL — REAL_E2E_DIR unset (real daemon not started?)"
  local cwd="$REAL_E2E_DIR/home/work"
  local db="$REAL_E2E_DIR/data/teleprompter/vault/sessions/$sid.sqlite"

  # Poll the DB for the 2-turn shape + the on-disk file before asserting, giving the
  # holder's coding turns their own settle window (M4 may fire after turn 1's Stop, before
  # turn 2 starts — same issue as assert_coding_e2e's settle window).
  [ -f "$db" ] || die "WEBPAGE E2E FAIL — session DB not found at $db"
  local deadline=$(( $(date +%s) + 240 )) ups=0 stops=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    ups="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='UserPromptSubmit';" 2>/dev/null || echo 0)"
    stops="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='Stop';" 2>/dev/null || echo 0)"
    { [ "${ups:-0}" -ge 2 ] && [ "${stops:-0}" -ge 2 ] && [ -f "$cwd/$file" ]; } && break
    sleep 2
  done

  # 1. the HTML5 file claude wrote — must exist and contain required HTML5 structure.
  [ -f "$cwd/$file" ] || die "WEBPAGE E2E FAIL — claude never created $cwd/$file (Write tool turn 1 did not land)"
  local body; body="$(cat "$cwd/$file" 2>/dev/null)"
  grep -qi "<!DOCTYPE html>" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing '<!DOCTYPE html>' (not a valid HTML5 document)"
  grep -qi "<html" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing '<html' element"
  grep -qi "<body" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing '<body' element"
  grep -qi "</html>" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing '</html>' closing tag"
  grep -q "$marker" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing marker '$marker' (Write tool did not include the recognizable marker)"
  grep -qi "<style" "$cwd/$file" \
    || die "WEBPAGE E2E FAIL — $file missing '<style' block (inline CSS not present)"
  # Log a short excerpt as evidence (first 5 lines).
  local excerpt; excerpt="$(head -5 "$cwd/$file" 2>/dev/null || true)"
  log "webpage E2E — file OK: $cwd/$file contains DOCTYPE+html+body+marker+style (Write tool ran). First 5 lines:"
  log "$excerpt"

  # 2. the 2-turn session-DB shape.
  [ "${ups:-0}" -ge 2 ] || die "WEBPAGE E2E FAIL — UserPromptSubmit=$ups (expected >=2; two webpage turns did not both land over the pipeline)"
  [ "${stops:-0}" -ge 2 ] || die "WEBPAGE E2E FAIL — Stop=$stops (expected >=2; claude did not finish both turns)"
  log "webpage E2E — DB OK: UserPromptSubmit=$ups, Stop=$stops (two real turns landed + completed)"

  # 3. Structured tool-use proof from the hook events. Same technique as assert_coding_e2e:
  #    LIKE for tool_name (constant, no metachars), instr() for filename (literal substring
  #    — NOT LIKE, because a filename can contain LIKE wildcards like '_').
  local write_hits bash_hits
  write_hits="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='PostToolUse' AND CAST(payload AS TEXT) LIKE '%\"tool_name\":\"Write\"%' AND instr(CAST(payload AS TEXT), '$file') > 0;" 2>/dev/null || echo 0)"
  [ "${write_hits:-0}" -ge 1 ] || die "WEBPAGE E2E FAIL — no PostToolUse(Write) referencing '$file' (claude did not use the Write tool on turn 1's instruction)"
  log "webpage E2E — Write tool OK: PostToolUse(Write) referencing '$file' ($write_hits)"
  bash_hits="$(sqlite3 "$db" "SELECT COUNT(*) FROM records WHERE kind='event' AND name='PostToolUse' AND CAST(payload AS TEXT) LIKE '%\"tool_name\":\"Bash\"%' AND instr(CAST(payload AS TEXT), '$file') > 0;" 2>/dev/null || echo 0)"
  [ "${bash_hits:-0}" -ge 1 ] || die "WEBPAGE E2E FAIL — no PostToolUse(Bash) referencing '$file' (claude did not run turn 2's validation command)"
  log "webpage E2E — Bash tool OK: PostToolUse(Bash) referencing '$file' ($bash_hits)"

  log "✅ WEBPAGE E2E PASS — the app→relay→daemon→PTY pipeline carried real turns to claude that built a valid HTML webpage (Write created $file, Bash validated it)"
}

# assert_push_e2e — the TP_E2E_PUSH assertion. After M0–M4 passed (real daemon + real
# claude print session + live app), the holder injected a synthetic `Notification` hook
# event over IPC; the daemon's PushNotifier dispatched it as a `relay.push`, and the
# relay — seeing the app live on the socket — delivered it in-band as `relay.notification`.
# The app's PRODUCTION receive code (RelayClient.onNotification) then emitted
# TP_PUSH_NOTIFY_RECEIVED to the unified log. We poll that log (NOT the session DB — the
# notification never lands in the DB; it is a transient push) for the marker bearing the
# driven sid. That marker is the load-bearing proof: it can only fire if the entire chain
# (PushNotifier detect → daemon sendPush → relay "ws" route → app decode) worked.
#
# Honest scope: this exercises the IN-BAND push path (frontend connected → no APNs). Real
# APNs delivery (the "push" DeliveryResult arm), device-token receipt, and tap→navigation
# remain Dave-gated (need aps-environment entitlement + a physical device + .p8 creds).
#
# Arg: $1 = udid (the booted simulator; ignored on the macOS-native path, which reads the
# already-running `log stream` file via macos_log_snapshot). Dies on timeout.
assert_push_e2e() {
  local udid="$1"
  local sid="${SMOKE_SESSION_ID:-real-smoke-sess}"
  # The holder re-sends the event 8×@3s (~24s) to absorb the app token-registration
  # race, and the app marker then lands shortly after. Give it a generous window.
  local deadline=$(( $(date +%s) + 120 )) hit=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local out
    case "$TP_PLATFORM" in
      macos) out="$(macos_log_snapshot)" ;;
      *) out="$(ios_log_snapshot "$udid" 120)" ;;
    esac
    hit="$(printf '%s\n' "$out" | grep -E "$PUSH_NOTIFY_RECEIVED_MARKER sid=$sid( |$)" | tail -n1 || true)"
    [ -n "$hit" ] && break
    sleep 2
  done
  [ -n "$hit" ] || die "PUSH E2E FAIL — never saw '$PUSH_NOTIFY_RECEIVED_MARKER sid=$sid' in the unified log (in-band relay.notification did not reach the app's onNotification)"
  log "push E2E — app receive OK: '$hit'"

  # Secondary (best-effort) proof: the holder logged that it injected the event. This
  # is diagnostic only — the app marker above already proves the full chain — so a miss
  # here warns but does not fail. (The holder's log() writes to stderr, which the harness
  # folds into $REAL_RP_OUT, so the line is normally present; keeping it non-fatal avoids
  # coupling the gate to that capture detail.)
  if [ -n "${REAL_RP_OUT:-}" ] && [ -f "$REAL_RP_OUT" ]; then
    if grep -q "push: injected synthetic Notification" "$REAL_RP_OUT" 2>/dev/null; then
      log "push E2E — holder OK: synthetic Notification injection logged by the holder"
    else
      log "push E2E — note: holder injection log not found in $REAL_RP_OUT (app marker already confirmed the chain)"
    fi
  fi

  log "✅ PUSH E2E PASS — a synthetic Notification event drove the real daemon's PushNotifier → daemon relay.push → relay in-band delivery → the app's production RelayClient.onNotification (sid=$sid), all over the genuine app→relay→daemon pipeline; real-APNs delivery + tap-nav remain device-gated"
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
REAL_RUN_CLAUDE=""
# "yes" → the spawned claude session is INTERACTIVE (TP_E2E_CLAUDE_M5), not print mode,
# so the input round-trip (M5) can be exercised. Implies REAL_RUN_CLAUDE.
REAL_RUN_CLAUDE_M5=""
# "yes" → the holder drives MULTIPLE coding turns (Write+Bash) over the pipeline
# (TP_E2E_CLAUDE_CODING) via --run-claude-coding. Implies REAL_RUN_CLAUDE. Takes
# precedence over M5 for the spawn flag (coding mode also accepts trust + keeps a live
# REPL, so it's a strict superset of the interactive spawn's setup).
REAL_RUN_CLAUDE_CODING=""
# "yes" → the holder drives TWO webpage-building turns (Write HTML5 file + Bash validate)
# via --run-claude-webpage. Implies REAL_RUN_CLAUDE. Takes HIGHEST precedence over
# coding/M5/print (webpage and coding are mutually exclusive siblings; parse_e2e_gates
# clears CODING when WEBPAGE is set, so only one multi-turn mode is ever active).
REAL_RUN_CLAUDE_WEBPAGE=""
# "yes" → the holder also injects a synthetic Notification event (TP_E2E_PUSH) via
# --emit-push-notification, additive to the print-mode --run-claude session (it
# needs that session's DB as the rec target). Implies REAL_RUN_CLAUDE.
REAL_SPAWN_PUSH=""
# Holder combined stdout+stderr log path (set in start_real_daemon_relay), read by
# assert_push_e2e for the secondary "push: injected …" diagnostic check.
REAL_RP_OUT=""
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

  # In claude mode, pass --run-claude so the holder spawns a real `claude -p`
  # session after pairing. The fixed sid lets the M4 assertion key on it; the cwd is
  # a scratch dir under the isolated HOME. CLAUDE_CODE_OAUTH_TOKEN was exported by
  # cmd_smoke_ios (from the keychain) and is inherited here.
  # --run-claude       → real `claude -p` PRINT session (M4).
  # --run-claude-interactive → real INTERACTIVE claude session (M5): the holder also
  #                        accepts the trust-folder prompt (one `\r` over IPC) so claude
  #                        sits idle at the REPL, ready for the app's relayed probe.
  # --run-claude-coding → holder drives multi-turn coding (Write+Bash); precedence
  #                         over M5 (it's a superset of the interactive spawn setup).
  # --run-claude-webpage → holder drives two webpage-building turns (Write HTML5 +
  #                          Bash validate); HIGHEST precedence (webpage > coding > m5 >
  #                          print). parse_e2e_gates already cleared CODING when WEBPAGE
  #                          is set, so this branch fires exclusively.
  local spawn_args=() claude_sid=""
  if [ -n "$REAL_RUN_CLAUDE_WEBPAGE" ]; then
    spawn_args+=("--run-claude-webpage")
    claude_sid="real-smoke-sess"
  elif [ -n "$REAL_RUN_CLAUDE_CODING" ]; then
    spawn_args+=("--run-claude-coding")
    claude_sid="real-smoke-sess"
  elif [ -n "$REAL_RUN_CLAUDE_M5" ]; then
    spawn_args+=("--run-claude-interactive")
    claude_sid="real-smoke-sess"
  elif [ -n "$REAL_RUN_CLAUDE" ]; then
    spawn_args+=("--run-claude")
    claude_sid="real-smoke-sess"
  fi
  # Push (TP_E2E_PUSH): additive to the print-mode --run-claude above — the holder
  # injects a synthetic Notification event into that session so the daemon pushes it
  # to the live app in-band. Needs the session DB the --run-claude print session
  # creates, so it composes with (does not replace) the spawn flag.
  if [ -n "$REAL_SPAWN_PUSH" ]; then
    spawn_args+=("--emit-push-notification")
  fi

  local rp_out; rp_out="$(mktemp -t tp-realpair.XXXXXX)"
  # Expose the holder's combined stdout+stderr log to assert_push_e2e (it greps the
  # "push: injected …" diagnostics as a secondary proof the holder did its part).
  REAL_RP_OUT="$rp_out"
  log "starting REAL daemon+relay (isolated under $REAL_E2E_DIR)${REAL_RUN_CLAUDE:+ + real claude session}"
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
  if [ -n "$REAL_RUN_CLAUDE" ]; then
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

# ── cmd_uitest_all — XCUITest UI-level E2E across every supported platform ───────
#
# Where `all` sweeps the marker `smoke` across all 5 platforms, THIS sweeps the
# XCUITest UI-E2E (cmd_uitest) across every platform that can host an
# XCUIApplication and prints a PASS / SKIP / FAIL matrix. This is the pragmatic
# best-achievable "5-platform UI E2E": research confirms XCUITest is the ONLY tool
# touching all of iOS/iPadOS/macOS/visionOS/watchOS, and even it can't drive
# watchOS (no XCUIApplication — Apple hard limit) or visionOS spatial gestures.
#
# Three-way result per platform:
#   PASS — UI assertions ran and passed through the real a11y tree.
#   SKIP — expected, not a failure: watchOS (always, no XCUIApplication) or macOS
#          when the TCC host-gate blocks the automation session (non-interactive /
#          unauthorised run). TP_UITEST_STRICT=1 turns the macOS SKIP into FAIL.
#   FAIL — a genuine assertion/build failure. Any FAIL makes the whole sweep exit
#          non-zero.
#
# Single-platform `TP_PLATFORM=watchos uitest` still `die`s (an explicit request
# for the impossible is an error); only the matrix skips watchOS gracefully.
#
# Mirrors cmd_all's fd/JSON-capture mechanics: `exec 3>&2` streams each subshell's
# live stderr (xcodebuild/xcbeautify) to the operator while `tail -n1` captures
# only the one-line JSON that tp_uitest_emit writes to stdout on the EXIT trap.
cmd_uitest_all() {
  exec 3>&2
  local platforms=("ios" "ipad" "macos" "visionos" "watchos")
  local -a results=()
  local p json rc

  for p in "${platforms[@]}"; do
    if [ "$p" = "watchos" ]; then
      # watchOS has no XCUIApplication (Apple hard limit) — synthesize a SKIP row
      # without spawning a subshell (single-platform `uitest` on watchOS still
      # dies; only the matrix skips it).
      log "──────── cmd_uitest_all: $p — auto-SKIP (no XCUIApplication on watchOS) ────────"
      results+=("{\"platform\":\"watchos\",\"result\":\"SKIP\",\"elapsed_s\":0}")
      continue
    fi

    log "──────── cmd_uitest_all: $p ────────"
    # Subshell: isolate TP_PLATFORM + this run's uitest trap state. Capture only
    # the final stdout line (JSON); human logs (stderr) pass through fd3.
    json="$( TP_PLATFORM="$p" TP_UITEST_JSON=1 bash "$0" uitest 2>&3 | tail -n1 )" \
      && rc=0 || rc=$?
    # Fallback: subshell died before emitting JSON (e.g. build failure before the
    # emit could run) — synthesize a FAIL row.
    case "$json" in
      '{"platform"'*) : ;;
      *) json="{\"platform\":\"$p\",\"result\":\"FAIL\",\"elapsed_s\":0}" ;;
    esac
    results+=("$json")
  done

  # Render the PASS / SKIP / FAIL matrix + compute overall pass/fail (SKIP is not
  # a failure).
  printf '\n'
  printf '%-10s  %-6s  %s\n' "PLATFORM" "RESULT" "ELAPSED"
  printf '%-10s  %-6s  %s\n' "--------" "------" "-------"
  local overall=0 row
  for row in "${results[@]}"; do
    printf '%s\n' "$row" | /usr/bin/python3 -c '
import json,sys
r=json.load(sys.stdin)
result=r.get("result","FAIL")
print("%-10s  %-6s  %ds" % (r.get("platform","?"), result, r.get("elapsed_s",0)))
# PASS and SKIP are both non-failures; only FAIL flips the overall exit.
sys.exit(0 if result in ("PASS","SKIP") else 1)
' || overall=1
  done
  printf '\n'
  if [ "$overall" -eq 0 ]; then
    log "✅ cmd_uitest_all: all platforms PASS or SKIP"
  else
    die "cmd_uitest_all: one or more platforms FAILED (see matrix above)"
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

  # Pessimistic default for the uitest-all matrix emit: any early exit (build
  # failure, `die`) leaves the result FAIL. The PASS / SKIP paths below flip it
  # explicitly before returning. Only armed under TP_UITEST_JSON so a normal
  # single-platform `uitest` run is unaffected.
  if [ "${TP_UITEST_JSON:-}" = "1" ]; then
    TP_UITEST_RESULT="FAIL"
    TP_UITEST_START="$(tp_now)"
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
    test 2>&1 | tee "$uit_log" | xcbeautify_or_cat >&2 || rc="${PIPESTATUS[0]}"

  if [ "$rc" -eq 0 ]; then
    log "✅ UITEST PASS — session render + pane switch asserted through the a11y tree on $TP_PLATFORM"
    TP_UITEST_RESULT="PASS"
    return 0
  fi

  # macOS-only host GATE, not a code failure: XCUITest's runner must initialize an
  # automation session, which native macOS guards behind a LocalAuthentication /
  # TCC (Accessibility + Automation) challenge. In a non-interactive or unauthorized
  # session that challenge can't complete ("Failed to initialize for UI testing …
  # System authentication is running" / LocalAuthentication Code=-4), so the run
  # can't even reach the assertions. The build+sign path is proven and the SAME
  # XCUITest code already passes on the iOS Simulator (no TCC gate there).
  #
  # By DEFAULT this is a non-fatal SKIP so a legitimately headless local run isn't
  # punished for an environment limitation. But the SKIP must NEVER be silently
  # conflated with a real PASS (a test that can't fail isn't a test). So:
  #   - emit a distinct, greppable `TP_UITEST_SKIP` marker (callers/CI assert on it),
  #   - and honor TP_UITEST_STRICT=1 to turn the host-gate SKIP into a hard failure —
  #     set it on any authorized GUI/CI runner where a SKIP would mask real breakage.
  if [ "$TP_PLATFORM" = "macos" ] \
     && grep -q "Failed to initialize for UI testing" "$uit_log" 2>/dev/null; then
    if [ "${TP_UITEST_STRICT:-}" = "1" ]; then
      die "UITEST FAIL (macOS, TP_UITEST_STRICT=1) — XCUITest runner could not initialize (LocalAuthentication/TCC). Grant Accessibility + Automation to the test runner and run in an unlocked, logged-in GUI session, or unset TP_UITEST_STRICT for a non-fatal SKIP."
    fi
    log "TP_UITEST_SKIP platform=macos reason=tcc-host-gate"
    log "⏭️  UITEST SKIP (macOS host gate) — XCUITest runner could not initialize:"
    log "    LocalAuthentication/TCC blocked the automation session (needs an"
    log "    interactively-authorized, unlocked session with Accessibility +"
    log "    Automation granted to the test runner). Build+sign succeeded; the"
    log "    identical UI assertions pass on the iOS Simulator. Grant access in"
    log "    System Settings → Privacy & Security → Accessibility/Automation and"
    log "    re-run in a logged-in GUI session (or set TP_UITEST_STRICT=1 to fail"
    log "    instead of skip) for full macOS UI E2E."
    TP_UITEST_RESULT="SKIP"
    return 0
  fi

  # FAIL path: TP_UITEST_RESULT is already "FAIL" (pessimistic default set at
  # entry under TP_UITEST_JSON), and the EXIT trap's tp_uitest_emit fires on die.
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

# ── TestFlight archive + export (cmd_archive) ───────────────────────────────────
#
# Produce an App-Store-Connect-ready signed .ipa from the iOS *device* slice.
# This is the build half of the TestFlight pipeline; the upload half lives in
# .github/workflows/testflight.yml (xcrun altool with an ASC API key), kept out
# of the harness because it needs Apple-issued secrets and makes a network call.
#
# Signing: this does NOT use $SIGN_FLAGS (ad-hoc "-"). A real Apple Distribution
# certificate + an App-Store provisioning profile for dev.tpmt.app must be
# in the keychain. In CI the workflow imports them into a throwaway keychain from
# base64 secrets; locally they come from your login keychain (Xcode-managed). The
# team is taken from $TP_DEVELOPMENT_TEAM (the Apple Developer Team ID) — required,
# since there is no hardcoded team in project.yml (Simulator builds need none).
#
# Version/build number: MARKETING_VERSION + CURRENT_PROJECT_VERSION come from
# project.yml, but TestFlight rejects a re-used build number, so CI overrides
# CURRENT_PROJECT_VERSION with a monotonic value (the workflow passes
# TP_BUILD_NUMBER=${{ github.run_number }}). Locally it defaults to project.yml's "1".
# Resolve the per-platform archive parameters into the named globals below.
# ADR-0004 Amendment 1 extends the iOS-only archive to the Apple platforms that
# distribute to App Store Connect → TestFlight. The DESTINATION, SCHEME, the
# ExportOptions plist, and the exported-artifact extension vary by platform; the
# keychain/team/build-number/export plumbing is shared.
#
#   ios / ipad → generic/platform=iOS, Teleprompter scheme, .ipa (iPadOS rides
#                the same binary via TARGETED_DEVICE_FAMILY "1,2"). The watch app
#                ships EMBEDDED inside this .ipa (Payload/Teleprompter.app/Watch/)
#                as a companion (#123, ADR-0004 Amdt 2), so the iOS archive carries
#                the watch slice — there is no separate watch archive.
#   macos      → generic/platform=macOS, Teleprompter scheme, .pkg (Mac App
#                Store export emits a signed installer package, not an .ipa)
#   visionos   → generic/platform=visionOS, Teleprompter scheme, .ipa
#
# watchOS is intentionally NOT a standalone archive target: the watch app is a
# companion embedded in the iOS app (#123, ADR-0004 Amendment 2), so it uploads on
# the single dev.tpmt.app record via the iOS .ipa. `TP_PLATFORM=watchos archive`
# therefore dies with a pointer to the iOS path. (The watchos Simulator SMOKE path
# — TeleprompterWatch built directly — is unchanged; that proves standalone runtime,
# which is separate from distribution.)
ARCHIVE_DEST=""
ARCHIVE_SCHEME=""
ARCHIVE_EXPORT_OPTIONS=""
ARCHIVE_ARTIFACT_EXT=""
# bundleId|profileName pairs injected into a temp ExportOptions at export time.
# Manual -exportArchive needs an explicit provisioningProfiles dict per app in the
# archive (the iOS .ipa carries TWO: the main app + the embedded companion watch);
# kept out of the checked-in plist so no profile name / team id lands in git.
# Parallel-array form (no `declare -A`) keeps this bash-3.2-safe like the rest of
# the script.
ARCHIVE_PROFILE_MAP=()
ARCHIVE_INSTALLER_CERT=""
resolve_archive_params() {
  case "$TP_PLATFORM" in
    ios|ipad)
      ARCHIVE_DEST="generic/platform=iOS"
      ARCHIVE_SCHEME="$SCHEME"
      ARCHIVE_EXPORT_OPTIONS="$IOS_DIR/ExportOptions.plist"
      ARCHIVE_ARTIFACT_EXT="ipa"
      # iOS .ipa carries BOTH the main app and the embedded companion watch — manual
      # export needs a profile mapping for each (the export failure named both apps).
      ARCHIVE_PROFILE_MAP=(
        "dev.tpmt.app|Teleprompter iOS App Store"
        "dev.tpmt.app.watchkitapp|Teleprompter watch app App Store"
      )
      ;;
    macos)
      ARCHIVE_DEST="generic/platform=macOS"
      ARCHIVE_SCHEME="$SCHEME"
      ARCHIVE_EXPORT_OPTIONS="$IOS_DIR/ExportOptions.macos.plist"
      ARCHIVE_ARTIFACT_EXT="pkg"
      # macOS slice carries only the main app (watch embed is destinationFilters:[iOS]).
      ARCHIVE_PROFILE_MAP=( "dev.tpmt.app|Teleprompter macOS App Store" )
      # macOS .pkg export needs a separate installer-signing identity. Setting
      # installerSigningCertificate tells xcodebuild to resolve the "3rd Party
      # Mac Developer Installer" identity directly from the keychain instead of
      # trying to validate it through the provisioning profile (which never lists
      # installer certs — that caused exit-70 "doesn't include signing certificate").
      ARCHIVE_INSTALLER_CERT="3rd Party Mac Developer Installer"
      ;;
    visionos)
      ARCHIVE_DEST="generic/platform=visionOS"
      ARCHIVE_SCHEME="$SCHEME"
      ARCHIVE_EXPORT_OPTIONS="$IOS_DIR/ExportOptions.visionos.plist"
      ARCHIVE_ARTIFACT_EXT="ipa"
      # visionOS slice carries only the main app (watch embed is destinationFilters:[iOS]).
      ARCHIVE_PROFILE_MAP=( "dev.tpmt.app|Teleprompter visionOS App Store" )
      ;;
    watchos)
      # #123 (ADR-0004 Amendment 2): the watch is a companion embedded in the iOS
      # app, not a separately-archived container. It ships inside the iOS .ipa, so
      # there is no watch-specific archive — run the iOS archive instead.
      die "cmd_archive: TP_PLATFORM=watchos has no standalone archive — the watch app is embedded in the iOS app (companion) and ships inside the iOS .ipa. Run 'TP_PLATFORM=ios scripts/ios.sh archive' (the watch slice rides along). See ADR-0004 §7.1 / docs/testflight-setup.md §4."
      ;;
    *)
      die "cmd_archive: unsupported TP_PLATFORM='$TP_PLATFORM' (expected ios|ipad|macos|visionos|watchos)."
      ;;
  esac
}

cmd_archive() {
  require xcodebuild
  [ -n "${TP_DEVELOPMENT_TEAM:-}" ] || die "TP_DEVELOPMENT_TEAM (Apple Developer Team ID) is required for a signed archive."
  resolve_archive_params
  [ -f "$ARCHIVE_EXPORT_OPTIONS" ] || die "missing $ARCHIVE_EXPORT_OPTIONS (App Store export options for $TP_PLATFORM)."
  ensure_xcframework
  ensure_project

  local build_number="${TP_BUILD_NUMBER:-}"
  local version_flags=()
  if [ -n "$build_number" ]; then
    version_flags+=("CURRENT_PROJECT_VERSION=$build_number")
    log "overriding build number → $build_number"
  fi

  rm -rf "$ARCHIVE_PATH" "$EXPORT_DIR"
  mkdir -p "$ARCHIVE_DIR" "$EXPORT_DIR"

  # The build/export logs MUST go to stderr, not stdout. When xcbeautify is absent
  # (the CI runner only installs xcodegen) xcbeautify_or_cat falls back to `cat`,
  # which would otherwise dump the multi-MB xcodebuild log to stdout — and CI
  # captures this function's stdout (`IPA="$(scripts/ios.sh archive)"`) expecting
  # ONLY the final artifact path. So redirect each pipeline to stderr (>&2); the
  # lone `printf` at the end is the only thing left on stdout. `set -o pipefail`
  # (top of file) keeps xcodebuild's exit status authoritative through the pipe.
  log "archiving $ARCHIVE_SCHEME for $TP_PLATFORM ($ARCHIVE_DEST, team $TP_DEVELOPMENT_TEAM)"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$ARCHIVE_SCHEME" \
    -configuration Release \
    -destination "$ARCHIVE_DEST" \
    -archivePath "$ARCHIVE_PATH" \
    -derivedDataPath "$DERIVED" \
    DEVELOPMENT_TEAM="$TP_DEVELOPMENT_TEAM" \
    CODE_SIGN_STYLE=Manual \
    "${version_flags[@]}" \
    archive | xcbeautify_or_cat >&2

  [ -d "$ARCHIVE_PATH" ] || die "archive failed — $ARCHIVE_PATH not produced"

  # A distributable .xcarchive has ApplicationProperties (bundle id, version, signing
  # id) in its Info.plist; a non-distributable "Generic Xcode Archive" / "Other items"
  # lacks it. Fail LOUDLY here rather than producing a silently-unuploadable artifact
  # downstream. (For iOS this archive also carries the embedded companion watch app
  # under Payload/Teleprompter.app/Watch/ — #123.)
  if ! /usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleIdentifier' \
        "$ARCHIVE_PATH/Info.plist" >/dev/null 2>&1; then
    die "archive is a non-distributable 'Generic Xcode Archive' (no ApplicationProperties in $ARCHIVE_PATH/Info.plist). The $ARCHIVE_SCHEME scheme for $TP_PLATFORM did not produce a distributable app archive — see ADR-0004 §7."
  fi

  # Build a temp ExportOptions with teamID + bundleId→profile mapping injected.
  # Manual -exportArchive does NOT auto-match keychain profiles by bundle id (that's
  # Automatic-signing behavior — and assuming it was the bug that made every export
  # fail with `exportArchive "…app" requires a provisioning profile`). It needs an
  # explicit provisioningProfiles dict for EVERY app in the archive (the iOS .ipa has
  # two: the main app + the embedded watch). teamID is required too — the export
  # invocation, unlike archive (DEVELOPMENT_TEAM=…), passes no team. Both come from
  # $TP_DEVELOPMENT_TEAM + ARCHIVE_PROFILE_MAP so nothing leaks into the checked-in
  # plist. The temp file lands in $EXPORT_DIR (rm -rf'd + recreated above — no leak;
  # the artifact search below matches only *.$ARCHIVE_ARTIFACT_EXT, never *.plist).
  local export_opts="$EXPORT_DIR/ExportOptions.resolved.plist"
  cp "$ARCHIVE_EXPORT_OPTIONS" "$export_opts"
  /usr/libexec/PlistBuddy -c "Add :teamID string $TP_DEVELOPMENT_TEAM" "$export_opts"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles dict" "$export_opts"
  local pair bid name
  for pair in "${ARCHIVE_PROFILE_MAP[@]}"; do
    bid="${pair%%|*}"
    name="${pair#*|}"
    /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$bid string $name" "$export_opts"
  done
  # macOS .pkg exports need an explicit installerSigningCertificate so xcodebuild
  # resolves the "3rd Party Mac Developer Installer" identity from the keychain
  # rather than trying (and failing) to validate it through the provisioning
  # profile. iOS/visionOS exports leave ARCHIVE_INSTALLER_CERT empty and skip this.
  if [ -n "${ARCHIVE_INSTALLER_CERT:-}" ]; then
    /usr/libexec/PlistBuddy -c "Add :installerSigningCertificate string $ARCHIVE_INSTALLER_CERT" "$export_opts"
  fi

  log "exporting App Store .$ARCHIVE_ARTIFACT_EXT → $EXPORT_DIR"
  xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$export_opts" | xcbeautify_or_cat >&2

  local artifact
  artifact="$(find "$EXPORT_DIR" -name "*.$ARCHIVE_ARTIFACT_EXT" -maxdepth 1 | head -1)"
  [ -n "$artifact" ] || die "export failed — no .$ARCHIVE_ARTIFACT_EXT in $EXPORT_DIR"
  log "✅ archived + exported: $artifact"
  # Emit the path on stdout so CI can capture it (everything else is on stderr).
  printf '%s\n' "$artifact"
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
    uitest-all) cmd_uitest_all ;;
    test)  cmd_test ;;
    archive) cmd_archive ;;
    fmt)   cmd_fmt ;;
    lint)  cmd_lint ;;
    *) die "unknown subcommand: $sub (use: gen|rust|boot|build|run|smoke|all|uitest|uitest-all|test|archive|fmt|lint)" ;;
  esac
}

main "$@"
