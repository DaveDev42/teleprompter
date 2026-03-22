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
# 1. Start daemon (manages sessions, vault, worktrees)
tp daemon start --ws-port 7080 --repo-root /path/to/repo

# 2. Start relay (optional, for remote access)
tp relay start --port 7090

# 3. Generate pairing data (for E2EE remote connection)
tp pair --relay ws://relay.example.com

# 4. Start frontend
cd apps/frontend && npx expo start --web
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `tp <claude args>` | Run claude through tp pipeline (default) |
| `tp daemon start [opts]` | Start the daemon service |
| `tp relay start [--port]` | Start a relay server |
| `tp pair [--relay URL]` | Generate QR pairing data |
| `tp version` | Print version |

### Daemon Options

```
--ws-port 7080        WebSocket port for local frontends
--repo-root /path     Enable git worktree management
--relay-url URL       Connect to relay server
--relay-token TOKEN   Relay auth token (from tp pair)
--daemon-id ID        Daemon identifier
--spawn --sid X       Auto-create a session on start
--cwd /path           Working directory for session
```

## Architecture

```
Runner → Daemon → Relay → Frontend
 (PTY)   (Vault)  (E2EE)  (Expo)
```

- **Runner**: Spawns Claude Code in a PTY, collects io streams and hooks events
- **Daemon**: Manages sessions, stores records in Vault, encrypts with libsodium
- **Relay**: Stateless ciphertext forwarder (zero-trust, recent 10 frames cache)
- **Frontend**: Expo app (iOS/Web/Android) with Chat + Terminal + Voice UI

## Monorepo Structure

```
apps/
  cli/         # Unified `tp` binary
  daemon/      # Session management, vault, E2EE
  runner/      # PTY management, hooks collection
  relay/       # WebSocket ciphertext relay
  frontend/    # Expo app (React Native + Web)
packages/
  protocol/    # Shared types, codec, crypto, pairing
  tsconfig/    # Shared TypeScript configs
```

## Development

```bash
pnpm install

# Run tests (109 tests)
bun test packages/protocol apps/daemon apps/runner apps/cli apps/relay

# Type check
npx tsc --noEmit -p apps/daemon/tsconfig.json
npx tsc --noEmit -p apps/cli/tsconfig.json

# Build CLI
bun run build:cli:local    # current platform
bun run build:cli          # all platforms

# Frontend dev
cd apps/frontend && npx expo start --web
```

## Key Technologies

- **TypeScript** — single stack across all components
- **Bun** — runtime for Runner, Daemon, Relay
- **Expo** — React Native + Web frontend
- **libsodium** — X25519 key exchange + XChaCha20-Poly1305 encryption
- **xterm.js** — terminal rendering (Web + native WebView bridge)
- **OpenAI Realtime API** — voice input/output with STT + TTS

## Security

- End-to-end encrypted (E2EE) communication
- QR-based pairing with X25519 ECDH key exchange
- Per-session ephemeral key ratchet
- Relay sees only ciphertext (zero-trust)
- API keys stored in OS Keychain/Keystore (native) or localStorage (web)

## License

MIT
