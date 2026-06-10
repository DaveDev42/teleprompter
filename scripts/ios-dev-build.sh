#!/usr/bin/env bash
#
# ios-dev-build.sh — build a local iOS development build (.ipa) using
# EAS-managed credentials, runnable from anywhere (incl. a headless SSH session).
#
# ┌─ LOCAL DEV BUILD ──────────────────────────────────────────────────────┐
# │ Builds a signed dev .ipa locally (verified on the 64GB M1 Max machine — │
# │ see .claude/rules/native-build.md). Run it in the background and never  │
# │ send SIGTERM mid-build (CALCULATE phase abort, H2). TestFlight/Store    │
# │ builds stay on EAS cloud; this script is only for local dev .ipa builds │
# │ driven by docs/local-verification-queue.md.                             │
# └────────────────────────────────────────────────────────────────────────┘
#
# Why this script exists (the gotchas it handles, all verified on macOS 15 / Xcode 26):
#   1. Apple WWDR **G3** intermediate cert must be in the login keychain, or the
#      EAS distribution cert chains to nothing and `security find-identity`
#      reports CSSMERR_TP_NOT_TRUSTED → "certificate hasn't been imported".
#   2. `security find-identity -v` only reports the cert as *valid* inside a
#      GUI (Aqua) login session. Over plain SSH (Background session) trustd
#      can't evaluate the chain, so the build re-execs via
#      `launchctl asuser <uid> sudo -u <user>` to jump into the Aqua session.
#   3. `launchctl asuser` resets PATH/HOME and runs as root; CocoaPods refuses
#      to run as root and node/pod fall off PATH. So the inner invocation pins
#      PATH/HOME (home derived from directory services) and drops to the user.
#   4. A root-owned /tmp/eas-cli-nodejs from a prior root run blocks the git
#      shallow-clone (exit 128); the outer (root-capable) context auto-cleans it.
#
# Credentials are NEVER stored in the repo — `eas build --local` downloads the
# distribution cert + provisioning profile from EAS (the single source of
# truth) at build time. Run `eas login` once if you aren't authenticated.
#
# Usage:
#   scripts/ios-dev-build.sh [--profile <name>] [--output <path.ipa>]
#
# Defaults: --profile device  --output /tmp/teleprompter-dev.ipa
# Override eas binary with EAS_BIN=/path/to/eas.
#
set -euo pipefail

PROFILE="device"
OUTPUT="/tmp/teleprompter-dev.ipa"
INNER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --output)  OUTPUT="$2";  shift 2 ;;
    --inner)   INNER=1;      shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Absolute path to this script — the re-exec runs in the Aqua session with a
# reset cwd, so a relative BASH_SOURCE would not resolve.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/app"
WWDR_G3_URL="https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer"

log() { printf '\033[36m[ios-dev-build]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[ios-dev-build] %s\033[0m\n' "$*" >&2; }

# Home directory from directory services (correct for AD/relocated accounts,
# and not dependent on sudoers HOME handling).
user_home() {
  local u="${1:-$(whoami)}"
  dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null \
    | sed 's/^NFSHomeDirectory: //' || true
}

# Locate the eas-cli binary. The pnpm-global one breaks --local builds, so we
# probe the common node version managers + global bins, then PATH.
find_eas() {
  if [[ -n "${EAS_BIN:-}" && -x "${EAS_BIN}" ]]; then echo "$EAS_BIN"; return; fi
  local h; h="$(user_home)"
  local c
  for c in \
    "$h/.local/share/fnm/node-versions"/*/installation/bin/eas \
    "$h/.volta/bin/eas" \
    "$h/.nvm/versions/node"/*/bin/eas \
    "$h/.asdf/shims/eas" \
    /opt/homebrew/bin/eas \
    /usr/local/bin/eas \
    "$(command -v eas 2>/dev/null || true)"; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  echo ""
}

login_keychain() {
  # Source of truth for the user's login keychain (don't hardcode the path).
  security login-keychain -d user 2>/dev/null | sed 's/^[[:space:]]*"//; s/"$//' \
    || echo "$(user_home)/Library/Keychains/login.keychain-db"
}

ensure_wwdr_g3() {
  local kc; kc="$(login_keychain)"
  # crl2pkcs7|pkcs7 -print_certs iterates ALL certs in the keychain (plain
  # `openssl x509` only parses the first PEM block).
  if security find-certificate -a -c "Apple Worldwide Developer" -p "$kc" 2>/dev/null \
       | openssl crl2pkcs7 -nocrl -certfile /dev/stdin 2>/dev/null \
       | openssl pkcs7 -print_certs -noout 2>/dev/null \
       | grep -q "OU=G3"; then
    log "WWDR G3 intermediate already present."
    return
  fi
  log "Installing Apple WWDR G3 intermediate certificate…"
  local tmp; tmp="$(mktemp -t wwdrg3)"
  trap 'rm -f "$tmp"' RETURN
  curl -fsSL -o "$tmp" "$WWDR_G3_URL"
  # security import detects DER by content; the extension is cosmetic.
  if ! out="$(security import "$tmp" -k "$kc" 2>&1)"; then
    echo "$out" | grep -qi "already exists" || { err "WWDR G3 import failed: $out"; exit 1; }
  fi
}

# Aqua (GUI) session? `launchctl managername` prints "Aqua" in a GUI login
# session, "Background" over SSH.
in_aqua_session() {
  [[ "$(launchctl managername 2>/dev/null)" == "Aqua" ]]
}

run_build() {
  local EAS; EAS="$(find_eas)"
  [[ -z "$EAS" ]] && { err "eas-cli not found (install: npm i -g eas-cli, or set EAS_BIN)"; exit 1; }

  cd "$APP_DIR"
  log "Using eas: $EAS ($("$EAS" --version 2>/dev/null | head -1))"
  log "Codesigning identities in this session:"
  security find-identity -v -p codesigning 2>&1 | sed 's/^/    /' | tail -3

  # A root-owned /tmp/eas-cli-nodejs from a prior sudo run blocks the shallow
  # clone (exit 128). We may be root here (outer SSH path runs under sudo), so
  # auto-clean by ownership rather than aborting.
  for d in /tmp/eas-cli-nodejs /tmp/eas-build-local-nodejs; do
    if [[ -e "$d" && "$(stat -f %u "$d" 2>/dev/null)" != "$(id -u)" ]]; then
      log "Removing stale $d (owned by another user)…"
      rm -rf "$d" 2>/dev/null || sudo rm -rf "$d" 2>/dev/null || true
    fi
  done

  log "Building profile '$PROFILE' → $OUTPUT"
  "$EAS" build --platform ios --profile "$PROFILE" --local --non-interactive --output "$OUTPUT"
  log "Build complete: $OUTPUT"
  log "Install on a connected iPhone with:"
  log "    xcrun devicectl device install app --device <udid> \"$OUTPUT\""
}

if [[ "$INNER" == "1" ]]; then
  # Inner invocation: already inside the Aqua session as the target user.
  # Re-assert we really are in Aqua — converts a silent late codesign failure
  # into an early, actionable error.
  if ! in_aqua_session; then
    err "--inner expected an Aqua GUI session but found '$(launchctl managername 2>/dev/null)'."
    err "Codesigning trust cannot be evaluated outside a GUI login session."
    exit 1
  fi
  export HOME="$(user_home)"
  export LANG="${LANG:-en_US.UTF-8}"
  NODE_BIN_DIR="$(dirname "$(find_eas)")"
  export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  ensure_wwdr_g3
  run_build
  exit 0
fi

# Outer invocation.
if in_aqua_session; then
  log "Already in an Aqua (GUI) session."
  ensure_wwdr_g3
  run_build
else
  log "Headless/SSH session detected — re-executing inside the Aqua GUI session…"
  UID_NUM="$(id -u)"; USER_NAME="$(whoami)"
  # Verify a GUI login session actually exists for this user before asuser.
  if ! launchctl print "gui/$UID_NUM" >/dev/null 2>&1; then
    err "No active GUI login session for '$USER_NAME' (uid $UID_NUM)."
    err "Log into the Mac's console (or enable auto-login) — codesigning trust needs an Aqua session."
    exit 1
  fi
  # WWDR G3 install + build all happen inside the Aqua re-exec.
  exec sudo launchctl asuser "$UID_NUM" sudo -u "$USER_NAME" \
    "$SELF" --inner --profile "$PROFILE" --output "$OUTPUT"
fi
