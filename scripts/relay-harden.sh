#!/usr/bin/env bash
# Hardens the teleprompter-relay host (Ubuntu 24.04 LTS).
#
# Idempotent. Designed for UFW-managed hosts: rate-limit / connlimit rules are
# injected into /etc/ufw/before.rules between BEGIN/END markers so UFW reloads
# preserve them. fail2ban guards SSH only (E2EE WSS payloads would false-positive).
#
# Run on the relay server:
#   ssh root@relay.tpmt.dev bash -s < scripts/relay-harden.sh
#
# Or:
#   scp scripts/relay-harden.sh root@relay.tpmt.dev:/root/
#   ssh root@relay.tpmt.dev bash /root/relay-harden.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

SSH_PORT="${SSH_PORT:-22}"
WSS_PORT="${WSS_PORT:-443}"
HTTP_PORT="${HTTP_PORT:-80}"
RELAY_INTERNAL_PORT="${RELAY_INTERNAL_PORT:-7090}"
RELAY_SERVICE="${RELAY_SERVICE:-tp-relay}"
RELAY_NOFILE="${RELAY_NOFILE:-200000}"
RELAY_NPROC="${RELAY_NPROC:-100000}"

BEGIN_MARK="# >>> tp-relay-harden BEGIN (managed by scripts/relay-harden.sh)"
END_MARK="# <<< tp-relay-harden END"

echo "==> installing fail2ban"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq fail2ban

# ---------------------------------------------------------------------------
# UFW application rules
# ---------------------------------------------------------------------------
echo "==> aligning UFW application rules"

# Drop unintended external exposure of the internal relay port (Caddy fronts WSS on 443).
ufw --force delete allow 7090/tcp 2>/dev/null || true
ufw --force delete allow "$RELAY_INTERNAL_PORT"/tcp 2>/dev/null || true
ufw deny "$RELAY_INTERNAL_PORT"/tcp comment "tp-relay internal: localhost only" || true

# UFW `limit` on SSH applies a 6-hits-in-30s rate limit at the firewall layer
# (in addition to fail2ban auth-level brute-force detection).
ufw --force delete allow "$SSH_PORT"/tcp 2>/dev/null || true
ufw limit "$SSH_PORT"/tcp comment "ssh rate-limited"

ufw allow "$HTTP_PORT"/tcp comment "Caddy ACME http-01 challenge"
ufw allow "$WSS_PORT"/tcp comment "WSS via Caddy"

# ---------------------------------------------------------------------------
# Inject connlimit / hashlimit rules into /etc/ufw/before.rules
# ---------------------------------------------------------------------------
echo "==> patching /etc/ufw/before.rules with WSS rate limits"

BEFORE=/etc/ufw/before.rules
cp -a "$BEFORE" "${BEFORE}.bak.$(date +%s)"

# Strip any prior managed block so this script stays idempotent.
python3 - "$BEFORE" "$BEGIN_MARK" "$END_MARK" <<'PY'
import sys, pathlib, re
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()
pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
pathlib.Path(path).write_text(pattern.sub("", text))
PY

# Append managed block before the trailing COMMIT of the *filter table*.
# /etc/ufw/before.rules contains *filter ... COMMIT and then *raw/*mangle blocks.
# We insert into the *filter section.
python3 - "$BEFORE" "$BEGIN_MARK" "$END_MARK" "$WSS_PORT" "$HTTP_PORT" <<'PY'
import sys, pathlib
path, begin, end, wss, http = sys.argv[1:]
text = pathlib.Path(path).read_text()

block = f"""{begin}
# NOTE: no per-IP concurrent-connection cap. CGNAT/carrier NAT routinely puts
# many legitimate users behind one public IP, so a connlimit would block real
# users; rate limits + daemon-side auth provide the abuse protection instead.
# Per-source-IP new-connection rate on WSS.
-A ufw-before-input -p tcp --dport {wss} --syn -m hashlimit --hashlimit-name tp_wss_new --hashlimit-mode srcip --hashlimit-above 30/min --hashlimit-burst 60 -j DROP
# HTTP (ACME challenge) rate limit.
-A ufw-before-input -p tcp --dport {http} --syn -m hashlimit --hashlimit-name tp_http_new --hashlimit-mode srcip --hashlimit-above 30/min --hashlimit-burst 60 -j DROP
# Global per-IP SYN flood mitigation.
-A ufw-before-input -p tcp --syn -m hashlimit --hashlimit-name tp_synflood --hashlimit-mode srcip --hashlimit-above 60/sec --hashlimit-burst 120 -j DROP
# Cap ICMP echo (still allow ping but rate-limit).
-A ufw-before-input -p icmp --icmp-type echo-request -m hashlimit --hashlimit-name tp_icmp --hashlimit-mode srcip --hashlimit-above 5/sec --hashlimit-burst 10 -j DROP
{end}
"""

# Insert just before the *filter section's COMMIT line.
# /etc/ufw/before.rules starts with *filter and ends that section with COMMIT.
# We insert before the FIRST COMMIT to land inside *filter.
idx = text.find("\nCOMMIT\n")
if idx == -1:
    raise SystemExit("could not find COMMIT line in before.rules")
new = text[:idx + 1] + block + text[idx + 1:]
pathlib.Path(path).write_text(new)
PY

# ---------------------------------------------------------------------------
# Reload UFW (rules.v4 written from before.rules + user.rules + after.rules)
# ---------------------------------------------------------------------------
echo "==> reloading UFW"
ufw --force reload

# ---------------------------------------------------------------------------
# systemd resource limits for the relay (10k concurrent connections target)
# ---------------------------------------------------------------------------
# Each WS connection consumes 1 fd. Default LimitNOFILE on Ubuntu is 1024,
# which caps the relay far below the 10k target. We write a drop-in override
# so package upgrades / unit replacements do not clobber it. Skip silently if
# the relay service is not yet installed on this host.
if systemctl list-unit-files --no-legend "$RELAY_SERVICE.service" 2>/dev/null \
    | grep -q "$RELAY_SERVICE.service"; then
  echo "==> writing systemd limits override for $RELAY_SERVICE"
  install -d -m 0755 "/etc/systemd/system/$RELAY_SERVICE.service.d"
  cat > "/etc/systemd/system/$RELAY_SERVICE.service.d/limits.conf" <<EOF
# Managed by scripts/relay-harden.sh — capacity target: ~10k concurrent
# WebSocket connections (daemon + app combined). One fd per connection plus
# headroom for accept(2) bursts and Caddy reverse-proxy peers.
[Service]
LimitNOFILE=$RELAY_NOFILE
LimitNPROC=$RELAY_NPROC
TasksMax=infinity
EOF

  systemctl daemon-reload
  if systemctl is-active --quiet "$RELAY_SERVICE.service"; then
    echo "==> restarting $RELAY_SERVICE to pick up new limits"
    systemctl restart "$RELAY_SERVICE.service"
  fi
else
  echo "==> $RELAY_SERVICE.service not installed; skipping systemd limits override"
fi

# ---------------------------------------------------------------------------
# fail2ban: SSH only.
# ---------------------------------------------------------------------------
echo "==> configuring fail2ban (sshd jail)"
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled  = true
port     = $SSH_PORT
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF

systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban

# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------
echo
echo "==> verification"
echo "--- ufw status ---"
ufw status verbose | head -25
echo
echo "--- managed rules in before.rules ---"
sed -n "/${BEGIN_MARK//\//\\/}/,/${END_MARK//\//\\/}/p" "$BEFORE" | head -30
echo
echo "--- live filter chain matches ---"
iptables -L ufw-before-input -n -v --line-numbers | grep -E "hashlimit|connlimit|reject|REJECT" | head -10
echo
echo "--- fail2ban status ---"
fail2ban-client status sshd 2>&1 | head -10
echo
echo "--- relay systemd limits ---"
if systemctl list-unit-files --no-legend "$RELAY_SERVICE.service" 2>/dev/null \
    | grep -q "$RELAY_SERVICE.service"; then
  systemctl show "$RELAY_SERVICE.service" -p LimitNOFILE -p LimitNPROC -p TasksMax 2>&1 | head -5
else
  echo "(service not installed)"
fi

echo
echo "✅ relay hardened."
echo "Rollback:"
echo "  - remove block between '$BEGIN_MARK' and '$END_MARK' from $BEFORE"
echo "  - ufw allow 22/tcp; ufw delete deny ${RELAY_INTERNAL_PORT}/tcp"
echo "  - apt remove --purge fail2ban"
echo "  - rm /etc/systemd/system/$RELAY_SERVICE.service.d/limits.conf"
echo "  - systemctl daemon-reload && systemctl restart $RELAY_SERVICE"
echo "  - ufw reload"
