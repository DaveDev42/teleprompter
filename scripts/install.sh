#!/usr/bin/env bash
set -euo pipefail

# Teleprompter CLI installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/teleprompter/main/scripts/install.sh | bash
#   VERSION=v0.1.0 curl -fsSL ... | bash

REPO="DaveDev42/teleprompter"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="tp"

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

ASSET_NAME="${BIN_NAME}-${OS}_${ARCH}"

# Determine version
if [ -z "${VERSION:-}" ]; then
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"tag_name": "([^"]+)".*/\1/')
fi

echo "Installing ${BIN_NAME} ${VERSION} (${OS}/${ARCH})..."

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"

mkdir -p "${INSTALL_DIR}"

# Install tp CLI
curl -fsSL "${DOWNLOAD_URL}" -o "${INSTALL_DIR}/${BIN_NAME}"
chmod +x "${INSTALL_DIR}/${BIN_NAME}"
echo "Installed ${BIN_NAME} to ${INSTALL_DIR}/${BIN_NAME}"

# Check if INSTALL_DIR is in PATH
ON_PATH=0
if echo "$PATH" | tr ':' '\n' | grep -qx "${INSTALL_DIR}"; then
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
