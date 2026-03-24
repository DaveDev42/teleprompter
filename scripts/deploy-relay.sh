#!/usr/bin/env bash
set -euo pipefail

# Deploy tp-relay to a remote server
#
# Usage:
#   ./scripts/deploy-relay.sh <host> [port]
#
# Prerequisites:
#   - SSH access to the host (ssh root@host)
#   - tp-relay binary built for linux (bun run build:cli)
#
# Example:
#   ./scripts/deploy-relay.sh relay.example.com 7090

HOST="${1:?Usage: deploy-relay.sh <host> [port]}"
PORT="${2:-7090}"
BINARY="dist/tp-relay-linux_arm64"
SERVICE_NAME="tp-relay"

# Detect architecture
ARCH=$(ssh "$HOST" "uname -m")
case "$ARCH" in
  aarch64|arm64) BINARY="dist/tp-relay-linux_arm64" ;;
  x86_64|amd64)  BINARY="dist/tp-relay-linux_x64" ;;
  *) echo "Unknown arch: $ARCH"; exit 1 ;;
esac

# Build if not exists
if [ ! -f "$BINARY" ]; then
  echo "Building relay binary..."
  bun run build:cli
fi

echo "Deploying $BINARY to $HOST..."

# Upload binary
scp "$BINARY" "$HOST:/usr/local/bin/tp-relay"
ssh "$HOST" "chmod +x /usr/local/bin/tp-relay"

# Create systemd service
ssh "$HOST" "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'UNIT'
[Unit]
Description=Teleprompter Relay Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/tp-relay
Environment=RELAY_PORT=${PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT"

# Enable and start
ssh "$HOST" "systemctl daemon-reload && systemctl enable ${SERVICE_NAME} && systemctl restart ${SERVICE_NAME}"

# Verify
sleep 2
ssh "$HOST" "systemctl status ${SERVICE_NAME} --no-pager | head -10"

echo ""
echo "✅ Relay deployed to ${HOST}:${PORT}"
echo "   Health: curl http://${HOST}:${PORT}/health"
echo "   Admin:  http://${HOST}:${PORT}/admin"
echo "   Logs:   ssh ${HOST} journalctl -u ${SERVICE_NAME} -f"
