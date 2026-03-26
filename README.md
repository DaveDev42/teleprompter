# Teleprompter

Remote Claude Code session controller with E2EE relay, dual Chat/Terminal UI, and voice input.

## Quick Start

```bash
# Install (macOS/Linux)
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash

# Or build from source
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
bun run build:cli:local    # → dist/tp
```

## Usage

### Passthrough Mode (simplest)

Run Claude Code through the teleprompter pipeline:

```bash
tp -p "explain this code"
tp --tp-sid my-session -p "fix the login bug"
```

`--tp-*` flags are consumed by tp; everything else is forwarded to claude.

### Full Setup

```bash
# 1. Build the frontend web app
cd apps/app && npx expo export --platform web --output-dir ../../dist/web && cd ../..

# 2. Start daemon with built-in frontend serving
tp daemon start --ws-port 7080 --repo-root /path/to/repo --web-dir dist/web

# 3. Open http://localhost:7080 in your browser — done!

# Optional: Start relay for remote access
tp relay start --port 7090

# Optional: Generate pairing data for E2EE
tp pair --relay ws://relay.example.com
```

### Development Mode

```bash
# Start daemon
tp daemon start --ws-port 7080

# Start frontend dev server (hot reload)
cd apps/app && npx expo start --web
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `tp <claude args>` | Run claude through tp pipeline (default) |
| `tp daemon start [opts]` | Start the daemon service |
| `tp relay start [--port]` | Start a relay server |
| `tp pair [--relay URL]` | Generate QR pairing data |
| `tp status` | Show daemon status and sessions |
| `tp logs` | Tail live session records |
| `tp doctor` | Environment diagnostics |
| `tp init` | Project setup guide |
| `tp upgrade` | Check and install latest release |
| `tp completions <shell>` | Generate shell completions (bash/zsh/fish) |
| `tp version` | Print version |

### Daemon Options

```
--ws-port 7080        WebSocket port for local frontends
--repo-root /path     Enable git worktree management
--relay-url URL       Connect to relay server
--relay-token TOKEN   Relay auth token (from tp pair)
--daemon-id ID        Daemon identifier
--web-dir /path       Serve frontend web build at WS port
--spawn --sid X       Auto-create a session on start
--cwd /path           Working directory for session
--prune               Prune old sessions on start
--verbose / --quiet   Log level control
--watch               Auto-restart on uncaught exceptions
```

## Architecture

```
Runner → Daemon → Relay → App
 (PTY)   (Vault)  (E2EE)  (Expo)
```

- **Runner**: Spawns Claude Code in a PTY, collects io streams and hooks events
- **Daemon**: Manages sessions, stores records in Vault, encrypts with libsodium
- **Relay**: Stateless ciphertext forwarder (zero-trust, recent 10 frames cache)
- **App**: Expo app (iOS/Web/Android) with Chat + Terminal + Voice UI

## Monorepo Structure

```
apps/
  cli/            # Unified `tp` binary
  app/            # Expo app (iOS + Web + Android)
packages/
  daemon/         # Session management, vault, WS server
  runner/         # PTY management, hooks collection
  relay/          # WebSocket ciphertext relay
  protocol/       # Shared types, codec, crypto, pairing
  tsconfig/       # Shared TypeScript configs
  eslint-config/  # Shared ESLint configuration
scripts/
  build.ts        # Multi-platform bun build --compile
  install.sh      # curl-pipe-sh installer
```

## Development

```bash
pnpm install

# Run all tests (unit/integration across 41 test files + 6 Playwright E2E specs)
pnpm test

# Type check all 5 packages
pnpm type-check:all

# Build CLI binaries (tp + tp-relay)
pnpm build:cli:local    # current platform
pnpm build:cli          # all 4 platforms

# Frontend dev server
pnpm dev:app

# Build frontend for production
pnpm build:web

# Environment diagnostics
pnpm doctor
```

## Key Technologies

- **TypeScript** — single stack across all components
- **Bun** — runtime for Runner, Daemon, Relay
- **Expo** — React Native + Web frontend
- **libsodium** — X25519 key exchange + XChaCha20-Poly1305 AEAD encryption
- **xterm.js** — terminal rendering (Web + native WebView bridge)
- **OpenAI Realtime API** — voice input/output with STT + TTS

## Security

- End-to-end encrypted (E2EE) communication
- QR-based pairing with X25519 ECDH key exchange
- Per-session ephemeral key ratchet
- Relay sees only ciphertext (zero-trust)
- API keys stored in OS Keychain/Keystore (native) or localStorage (web)

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

MIT
