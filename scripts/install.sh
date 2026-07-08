#!/usr/bin/env bash
set -euo pipefail

# Teleprompter CLI installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/teleprompter/main/scripts/install.sh | bash
#   VERSION=v0.1.0 curl -fsSL ... | bash
#
# Packaging modes (auto-detected by asset name suffix):
#
#   Legacy (Bun single-binary, current releases):
#     Asset: tp-darwin_arm64       (no .tar.gz)
#     Installs: INSTALL_DIR/tp     (single executable, chmod +x)
#
#   Bundle (tranche 4d / #5, future releases):
#     Asset: tp-darwin_arm64.tar.gz
#     Tree:  bin/tp + libexec/tp/tpd
#     Installs:
#       PREFIX/bin/tp                ← Rust CLI binary
#       PREFIX/libexec/tp/tpd        ← Bun SEA (tpd)
#       INSTALL_DIR/tp               ← symlink → PREFIX/bin/tp
#     PREFIX = $TP_PREFIX or $HOME/.local/share/tp
#
#   Compatibility: If the tarball asset is not found (404), falls back to the
#   legacy single-binary asset. This allows the same install.sh to work against
#   both release shapes during the #5 transition period.

REPO="DaveDev42/teleprompter"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
# Normalize: drop any trailing slash so PATH comparison matches $PATH entries.
INSTALL_DIR="${INSTALL_DIR%/}"
BIN_NAME="tp"
# Prefix for tarball installs. The symlink INSTALL_DIR/tp points here.
TP_PREFIX="${TP_PREFIX:-$HOME/.local/share/tp}"

# Detect OS
case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *)
    echo "Error: unsupported OS $(uname -s)"
    exit 1
    ;;
esac

# Detect architecture
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)
    echo "Error: unsupported architecture $(uname -m)"
    exit 1
    ;;
esac

ASSET_SUFFIX="${OS}_${ARCH}"
ASSET_NAME="${BIN_NAME}-${ASSET_SUFFIX}"
TARBALL_NAME="${ASSET_NAME}.tar.gz"

# Determine version
if [ -z "${VERSION:-}" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": "([^"]+)".*/\1/')
fi

echo "Installing ${BIN_NAME} ${VERSION} (${OS}/${ARCH})..."

BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
TARBALL_URL="${BASE_URL}/${TARBALL_NAME}"
BINARY_URL="${BASE_URL}/${ASSET_NAME}"

mkdir -p "${INSTALL_DIR}"

# ─── Bundle tarball install (tranche 4d / #5 — activates when a .tar.gz asset exists) ───
BUNDLE_INSTALLED=0

# Try the tarball first (HEAD check to avoid 404 download noise).
if curl -fsSL --head "${TARBALL_URL}" -o /dev/null 2>/dev/null; then
  echo "Bundle tarball detected — installing prefix tree to ${TP_PREFIX}"
  TMPDIR_EXTRACT=$(mktemp -d)
  curl -fsSL "${TARBALL_URL}" | tar -xz -C "${TMPDIR_EXTRACT}"

  # The tarball unpacks to tp-${ASSET_SUFFIX}/bin/tp + tp-${ASSET_SUFFIX}/libexec/tp/{tpd,tp-daemon,tp-relay}
  EXTRACTED_DIR="${TMPDIR_EXTRACT}/${ASSET_NAME}"
  if [ ! -d "${EXTRACTED_DIR}" ]; then
    # Fallback: some tar layouts omit the outer dir
    EXTRACTED_DIR="${TMPDIR_EXTRACT}"
  fi

  mkdir -p "${TP_PREFIX}/bin" "${TP_PREFIX}/libexec/tp"
  cp "${EXTRACTED_DIR}/bin/tp"          "${TP_PREFIX}/bin/tp"
  cp "${EXTRACTED_DIR}/libexec/tp/tpd"  "${TP_PREFIX}/libexec/tp/tpd"
  chmod +x "${TP_PREFIX}/bin/tp" "${TP_PREFIX}/libexec/tp/tpd"
  # tp-daemon (ADR-0003 Phase 4 A1): shipped alongside tpd. Guarded so a NEW
  # install.sh fetched at curl-time against an OLD (pre-A1) tarball that lacks
  # this member does not `set -e`-abort the whole install — every future tarball
  # contains it, so this is transitional insurance only.
  if [ -f "${EXTRACTED_DIR}/libexec/tp/tp-daemon" ]; then
    cp "${EXTRACTED_DIR}/libexec/tp/tp-daemon" "${TP_PREFIX}/libexec/tp/tp-daemon"
    chmod +x "${TP_PREFIX}/libexec/tp/tp-daemon"
  fi
  # tp-relay (task #17 #25): shipped alongside tpd/tp-daemon so a locally-run
  # `tp relay start` execs the native binary (locate_tp_relay). Same guard as
  # tp-daemon — a NEW install.sh against an OLD tarball lacking this member must
  # not `set -e`-abort; every future tarball contains it (transitional insurance).
  if [ -f "${EXTRACTED_DIR}/libexec/tp/tp-relay" ]; then
    cp "${EXTRACTED_DIR}/libexec/tp/tp-relay" "${TP_PREFIX}/libexec/tp/tp-relay"
    chmod +x "${TP_PREFIX}/libexec/tp/tp-relay"
  fi
  rm -rf "${TMPDIR_EXTRACT}"

  # Symlink INSTALL_DIR/tp → TP_PREFIX/bin/tp
  # (removes any stale single-binary first)
  if [ -e "${INSTALL_DIR}/${BIN_NAME}" ] && [ ! -L "${INSTALL_DIR}/${BIN_NAME}" ]; then
    # Existing non-symlink binary: back it up
    mv "${INSTALL_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}.bun-bak"
    echo "Backed up old binary to ${INSTALL_DIR}/${BIN_NAME}.bun-bak"
  fi
  ln -sf "${TP_PREFIX}/bin/tp" "${INSTALL_DIR}/${BIN_NAME}"
  echo "Installed ${BIN_NAME} to ${INSTALL_DIR}/${BIN_NAME} (→ ${TP_PREFIX}/bin/tp)"
  echo "         tpd at ${TP_PREFIX}/libexec/tp/tpd"
  if [ -f "${TP_PREFIX}/libexec/tp/tp-daemon" ]; then
    echo "         tp-daemon at ${TP_PREFIX}/libexec/tp/tp-daemon"
  fi
  if [ -f "${TP_PREFIX}/libexec/tp/tp-relay" ]; then
    echo "         tp-relay at ${TP_PREFIX}/libexec/tp/tp-relay"
  fi
  BUNDLE_INSTALLED=1
fi

# ─── Legacy single-binary install (current releases, pre-#5) ─────────────────
if [ "$BUNDLE_INSTALLED" = "0" ]; then
  DOWNLOAD_URL="${BINARY_URL}"
  curl -fsSL "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/${BIN_NAME}"
  chmod +x "${INSTALL_DIR}/${BIN_NAME}"
  echo "Installed ${BIN_NAME} to ${INSTALL_DIR}/${BIN_NAME}"
fi

# Check if INSTALL_DIR is in PATH
ON_PATH=0
if echo "$PATH" | tr ':' '\n' | sed 's:/*$::' | grep -qx "${INSTALL_DIR}"; then
  ON_PATH=1
else
  echo ""
  echo "Add ${INSTALL_DIR} to your PATH:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

# Install shell completions (idempotent, failure is non-fatal).
# Skip on non-TTY (e.g. `curl ... | bash`) unless TP_AUTO_COMPLETIONS=1.
# Opt-out:
#   NO_COMPLETIONS=1             works everywhere (env)
#   --no-completions             works only for local invocations
#                                (bash install.sh --no-completions)
SKIP_COMPLETIONS=0
for arg in "$@"; do
  if [ "$arg" = "--no-completions" ]; then
    SKIP_COMPLETIONS=1
    break
  fi
done
if [ "${NO_COMPLETIONS:-0}" = "1" ]; then
  SKIP_COMPLETIONS=1
fi
if [ ! -t 0 ] && [ "${TP_AUTO_COMPLETIONS:-0}" != "1" ]; then
  SKIP_COMPLETIONS=1
  echo ""
  echo "Shell completions not installed (non-interactive shell detected)."
  echo "To install: '${BIN_NAME} completions install'"
  echo "To force auto-install on pipe: TP_AUTO_COMPLETIONS=1"
  echo "To disable completely:         NO_COMPLETIONS=1"
fi
if [ "$ON_PATH" != "1" ]; then
  SKIP_COMPLETIONS=1
  echo ""
  echo "Shell completions not installed (${INSTALL_DIR} not on PATH)."
  echo "Add it to PATH (see message above) then run: ${BIN_NAME} completions install"
fi

if [ "$SKIP_COMPLETIONS" = "0" ]; then
  "${INSTALL_DIR}/${BIN_NAME}" completions install || {
    echo ""
    echo "Note: shell completions were not installed automatically."
    echo "Run '${BIN_NAME} completions install' manually to enable them."
  }
fi
