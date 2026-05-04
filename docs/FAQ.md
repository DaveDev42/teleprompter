# Frequently Asked Questions

## Installation

### How do I install Teleprompter?

**macOS / Linux (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

This installs the `tp` binary to `~/.local/bin`. You can override the install location with `INSTALL_DIR`.

**From source (macOS / Linux; Windows users build inside WSL):**

```bash
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
pnpm build:cli:local    # builds for current platform → dist/tp
```

### What platforms are supported?

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS | arm64, x64 | Fully supported |
| Linux | arm64, x64 | Fully supported |
| Windows | — | Not supported natively. Run the Linux build inside [WSL](https://learn.microsoft.com/windows/wsl/). |

The mobile app (Expo) runs on iOS, Android, and Web. Platform priority: iOS > Web > Android.

### Do I need Claude Code installed?

Yes. Teleprompter wraps Claude Code — it spawns `claude` in a PTY and collects its output. Make sure `claude` is in your PATH. You can verify with:

```bash
which claude
# or
tp doctor
```

### What are the prerequisites?

**Runtime (required):**
- **Bun** v1.3.12+ (runtime for daemon, runner, relay)
- **Claude Code** CLI (`claude` in PATH)
- **Git** (for worktree features)

**Development only:**
- **Node.js** 22+ (build tooling)
- **pnpm** (monorepo package manager)

Run `tp doctor` to check all requirements at once.

---

## Connection & Pairing

### How do I connect my phone to Teleprompter?

1. Run `tp pair --relay wss://relay.tpmt.dev` on your computer
2. This generates a QR code and **blocks** waiting for the mobile app to complete the ECDH key exchange (press Ctrl+C to cancel)
3. Scan the QR code from the Teleprompter app on your phone
4. Once the app completes the key exchange, the pairing is persisted and `tp pair` exits

### Can I connect multiple devices?

Yes. Teleprompter supports N:N connectivity — one daemon can serve multiple frontends, and one app can connect to multiple daemons. Each device gets independent E2EE keys. Manage connections in the app's Settings screen under "Pair with Daemon."

### My phone won't connect. How do I troubleshoot?

Run `tp doctor` to diagnose issues. It checks:

1. **Pairing data** — Does `tp pair list` show a pairing? If not, run `tp pair new` first.
2. **Daemon status** — Is the daemon running? It auto-starts on `tp status` or `tp pair`.
3. **Relay connectivity** — Can the daemon reach the relay server? Doctor pings the relay and reports RTT.
4. **E2EE self-test** — Is the crypto stack (libsodium) working correctly?

On the app side, go to **Settings > Diagnostics** to check:
- Daemon WS connection status
- Relay WS status
- E2EE status (Active/Inactive)
- Run the **E2EE Self-Test** to verify crypto on-device (Sodium Init, Key Gen, Encrypt/Decrypt)

Common issues:
- **Relay unreachable**: Check network/firewall. The relay runs on `wss://relay.tpmt.dev` (port 443).
- **E2EE Inactive**: Key exchange may not have completed. Try re-pairing.
- **Stale connection**: The relay detects dead daemons after 90 seconds of no heartbeat.

### Is the connection encrypted?

Yes. All communication is end-to-end encrypted (E2EE):

- **Key exchange**: X25519 ECDH via QR-based pairing
- **Encryption**: XChaCha20-Poly1305 AEAD per message
- **Per-session key ratchet**: Keys rotate for forward secrecy
- **Zero-trust relay**: The relay server sees only ciphertext and cannot decrypt anything

---

## Sessions

### Where are sessions stored?

Sessions are stored in an append-only SQLite database at:

```
$XDG_DATA_HOME/teleprompter/vault/sessions.sqlite
# typically: ~/.local/share/teleprompter/vault/sessions.sqlite
```

On macOS, `XDG_DATA_HOME` is not set by default — the path resolves to `~/.local/share`. The vault is created automatically on first daemon run.

### Can I export a session?

Yes. In the app, open a session and tap the **Export** button in the session drawer. Exports are available in Markdown or JSON format.

- Hooks events are formatted as structured cards (UserPromptSubmit, ToolUse, etc.)
- PTY output is included with ANSI escapes stripped
- Default limit: 50,000 records per export (configurable)

### Are old sessions cleaned up automatically?

Yes. The daemon runs auto-cleanup:

- **On startup**: Prunes sessions older than the TTL
- **Periodically**: Every 24 hours
- **Default TTL**: 7 days

Configure via:
- `--prune-ttl <days>` CLI option
- `TP_PRUNE_TTL_DAYS` environment variable
- `--no-prune` to disable

### What happens when the daemon restarts?

Sessions are persisted in the store. On restart:

1. The daemon reloads all session records
2. Relay connections are re-established from saved pairings (`reconnectSavedRelays()`)
3. The app reconnects automatically with "Reconnecting... (attempt N)" indicator
4. Terminal and chat content is replayed from the backlog

---

## Daemon

### The daemon won't start. What do I check?

1. Run `tp doctor` to verify all dependencies
2. Check if the socket file exists: look for `$XDG_RUNTIME_DIR/daemon.sock` or `/tmp/teleprompter-<uid>/daemon.sock`
3. Check logs: `tp logs`
4. Check for port conflicts: The daemon's WebSocket server defaults to port 7080. If it's in use, passthrough mode auto-falls back to a random port.

### Does the daemon auto-start?

Yes. Running `tp status`, `tp logs`, `tp pair`, or any passthrough command will auto-start the daemon if it's not running.

For persistent auto-start, install as an OS service:

```bash
tp daemon install     # macOS: launchd plist, Linux: systemd unit
tp daemon uninstall   # remove the service
```

### How do I view daemon logs?

```bash
tp logs              # tail live session output
tp logs <session-id> # tail a specific session
```

For additional diagnostics, run `tp doctor` — it now runs Claude Code's own doctor right after tp's checks. You can also check the system service logs directly:

```bash
# macOS (launchd)
log show --predicate 'process == "tp"' --last 1h

# Linux (systemd)
journalctl --user -u teleprompter-daemon --since "1 hour ago"
```

---

## Voice

### How does voice input work?

Voice input uses the **OpenAI Realtime API** for speech-to-text and text-to-speech. It requires an OpenAI API key configured in **Settings > OpenAI API Key**.

### Is voice available on mobile?

Not currently. Voice input is **Web-only**. On iOS and Android, the VoiceButton is hidden because native audio capture (via `expo-av` or similar) is not yet implemented. This is a known limitation.

---

## Upgrading

### How do I upgrade Teleprompter?

```bash
tp upgrade
```

This will:
1. Check the latest GitHub release
2. Download and verify the binary (SHA-256 checksum)
3. Replace the current binary (with automatic `.bak` backup for rollback)
4. Upgrade Claude Code (`claude update`)
5. Restart the daemon service if installed

### How do I upgrade only Claude Code?

```bash
tp update
```

This forwards directly to `claude update` and skips the tp upgrade path.

### What if an upgrade fails?

The upgrade process creates a `.bak` backup of the current binary before replacing it. If the new binary fails, the old one is automatically restored.

---

## Development

### How do I set up the dev environment?

```bash
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
```

### How do I run tests?

```bash
# All unit + integration tests
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay

# Type checking
pnpm type-check:all

# Playwright E2E tests
pnpm test:e2e       # local (full suite)
pnpm test:e2e:ci    # CI-safe subset (no daemon required)

# Lint + format (Biome)
pnpm lint
```

Tests use `bun:test` exclusively — no Jest or Vitest. Test files are co-located next to source files.

### How do I build the CLI?

```bash
pnpm build:cli:local    # current platform only
pnpm build:cli          # every release target (see scripts/build.ts TARGETS)
```

Builds use `bun build --compile` to produce standalone binaries.

### How do I run the frontend locally?

```bash
# Development mode (hot reload)
pnpm dev:app
# or: cd apps/app && npx expo start --web

# Production build
pnpm build:web
```

### How do I run a relay server locally?

```bash
tp relay start --port 7090
```

The relay is stateless and only forwards encrypted frames. Configure frame limits with:
- `TP_RELAY_CACHE_SIZE` — recent frames per session (default: 10)
- `TP_RELAY_MAX_FRAME_SIZE` — max frame size (default: 1MB)

### How do I enable shell autocompletion?

```bash
tp completions bash >> ~/.bashrc
tp completions zsh >> ~/.zshrc
tp completions fish >> ~/.config/fish/completions/tp.fish
```

---

## Troubleshooting

### `tp doctor` reports issues. What do the checks mean?

| Check | What it verifies | Fix |
|-------|-----------------|-----|
| Bun | Bun runtime installed | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| Node.js | Node.js available (dev only) | Install Node.js 22+ |
| pnpm | pnpm package manager (dev only) | `npm i -g pnpm` |
| Claude CLI | `claude` in PATH | Install Claude Code |
| Git | Git available | Install Git |
| Daemon socket | Daemon is running | Run `tp daemon start` or any tp command (auto-starts) |
| Pairing data | Pairing configured | Run `tp pair --relay <url>` |
| Vault | Store directory exists | Starts on first daemon run (auto-created) |
| Relay ping | Network to relay | Check firewall, DNS, relay URL |
| E2EE self-test | Crypto stack works | Re-pair; check libsodium compatibility |

### WebSocket keeps disconnecting

- The daemon sends heartbeat pings every 30 seconds
- The relay marks daemons as offline after 90 seconds of no response
- Check network stability and relay RTT with `tp doctor`
- The app shows reconnection attempt count — if it keeps climbing, the daemon may have crashed

### "No frontend peers for decryption" in logs

This means the key exchange between daemon and frontend didn't complete. The daemon received a frame but has no matching E2EE keys for that frontend. Fix: re-pair by scanning a new QR code.

---

## Known Limitations

- **Voice input**: Web-only; not available on iOS/Android
- **Windows**: native Windows is not supported. Windows users run the Linux build inside WSL.
- **Pre-1.0**: Expect breaking changes. Version scheme: `0.0.x` patches only until App Store public release
- **Session export**: 50,000 record limit per export
- **Relay presence**: 90-second window where a dead daemon may appear online
