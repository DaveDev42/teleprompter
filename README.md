# Teleprompter

[![CI](https://github.com/DaveDev42/teleprompter/actions/workflows/ci.yml/badge.svg)](https://github.com/DaveDev42/teleprompter/actions/workflows/ci.yml)
[![Deploy Relay](https://github.com/DaveDev42/teleprompter/actions/workflows/deploy-relay.yml/badge.svg)](https://github.com/DaveDev42/teleprompter/actions/workflows/deploy-relay.yml)
[![License: BSD-2-Clause](https://img.shields.io/badge/License-BSD_2--Clause-blue.svg)](./LICENSE)

Remote Claude Code session controller with E2EE relay, dual Chat/Terminal UI, and voice input.

## Quick Start

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

### Windows

```powershell
irm https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.ps1 | iex
```

Installs `tp.exe` to `$env:LOCALAPPDATA\Programs\teleprompter`. Add that directory to `PATH` per the installer's final message.

### Build from source

```bash
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
pnpm build:cli:local    # → dist/tp
```

## Usage

### Passthrough Mode (simplest)

Run Claude Code through the teleprompter pipeline:

```bash
tp -p "explain this code"
tp --tp-sid my-session -p "fix the login bug"
```

`--tp-*` flags are consumed by tp; everything else is forwarded to claude.

### Connect Your Phone

```bash
# Generate pairing data (QR code) — default relay: wss://relay.tpmt.dev
tp pair

# Or use a custom relay
tp pair --relay wss://relay.example.com
```

Scan the QR code with the Teleprompter app (iOS TestFlight / Android Internal / [tpmt.dev](https://tpmt.dev)). The app connects to your daemon **through the relay** with end-to-end encryption — no direct local connection.

### Auto-start on Login

```bash
tp daemon install      # macOS launchd / Linux systemd / Windows Task Scheduler
tp daemon uninstall    # Remove
```

### CLI Commands

| Command | Description |
|---------|-------------|
| `tp` | Run Claude through tp pipeline (default — bare invocation drops you into Claude) |
| `tp [flags] [claude args]` | Run Claude with passthrough args (e.g. `tp -p "..."`, `tp --model sonnet`) |
| `tp -- <claude args>` | Forward args directly to claude, bypassing the daemon |
| `tp --help` / `-h` | Print tp's banner, then `claude --help` underneath |
| `tp --version` / `-v` | Print tp + claude versions (same as `tp version`) |
| `tp pair [--relay URL] [--label NAME]` | Generate QR pairing data (alias for `tp pair new`) |
| `tp pair list` | List registered pairings (label + daemon ID) |
| `tp pair rename <id-prefix> <label...>` | Rename a pairing (notifies peer) |
| `tp pair delete <id> [-y]` | Delete a pairing (daemon-id prefix accepted) |
| `tp session list` | List stored sessions (running + stopped) |
| `tp session delete <sid> [-y]` | Delete a session (sid prefix accepted) |
| `tp session prune [--older-than 7d] [--all] [--dry-run] [-y]` | Bulk-delete stopped sessions |
| `tp status` | Show daemon status and sessions |
| `tp logs [session]` | Tail live session output |
| `tp doctor` | Environment diagnostics + relay E2EE check, then runs `claude doctor` |
| `tp upgrade` | Upgrade tp binary, then runs `claude update` |
| `tp version` | Print tp + claude versions |
| `tp daemon start [opts]` | Start daemon in foreground |
| `tp daemon install` | Register as OS service (launchd / systemd / Task Scheduler) |
| `tp daemon uninstall` | Remove OS service |
| `tp relay start [--port]` | Start a relay server (self-hosted) |
| `tp completions <bash\|zsh\|fish\|powershell>` | Print shell completion script |
| `tp completions install [shell]` | Install completion into the current shell rc / profile |
| `tp completions uninstall [shell]` | Remove installed completion |
| `tp auth` / `mcp` / `install` / `update` / `agents` / `auto-mode` / `plugin` / `setup-token` | Forward to `claude` (daemon bypass) |

## Architecture

```
Runner ──IPC──→ Daemon ──WSS (E2EE)──→ Relay ──WSS (E2EE)──→ App
 (PTY)          (Store)                (forwarder)           (Expo)
```

- **Runner**: Spawns Claude Code in a PTY, collects io streams and hooks events, communicates with Daemon via IPC (Unix domain socket / Named Pipe on Windows)
- **Daemon**: Manages sessions, stores records, encrypts with libsodium per-frontend keys, connects to Relay(s) as a client
- **Relay**: Stateless ciphertext forwarder (zero-trust, 10 encrypted frames cached per session). Never sees plaintext.
- **App**: Expo app (iOS/Web/Android) with Chat + Terminal + Voice UI. Connects to paired daemon(s) via Relay only.

**All frontend↔daemon traffic flows through the Relay with E2EE.** Daemon does not run a WebSocket server; the App does not connect directly to the Daemon. Pairing (QR/JSON) delivers the Daemon's public key and relay URL offline; frontend pubkey is exchanged in-band via `relay.kx`.

## Monorepo Structure

```
apps/
  cli/            # Unified `tp` binary
  app/            # Expo app (iOS + Web + Android)
packages/
  daemon/         # Session management, Store, IPC server, Relay client
  runner/         # PTY management, hooks collection
  relay/          # WebSocket ciphertext relay
  protocol/       # Shared types, codec, crypto, pairing
  tsconfig/       # Shared TypeScript configs
scripts/
  build.ts        # Multi-platform bun build --compile
  install.sh      # curl-pipe-sh installer (macOS/Linux)
  install.ps1     # PowerShell installer (Windows)
```

## Development

```bash
pnpm install

# Run all bun:test suites across the workspace (unit + integration)
pnpm test

# Run Playwright E2E specs (CI subset — daemon-free)
pnpm test:e2e:ci

# Run Playwright E2E specs (local — full, includes real-daemon flows)
pnpm test:e2e

# Type check every workspace package
pnpm type-check:all

# Build CLI binary
pnpm build:cli:local    # current platform
pnpm build:cli          # every release target (see scripts/build.ts TARGETS)

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
- **ghostty-web** — terminal rendering (libghostty WASM, Canvas 2D)
- **OpenAI Realtime API** — voice input/output with STT + TTS

## Security

- End-to-end encrypted (E2EE) communication
- QR-based pairing with X25519 ECDH key exchange
- Per-session ephemeral key ratchet
- Relay sees only ciphertext (zero-trust)
- API keys stored in OS Keychain/Keystore (native) or localStorage (web)

## Documentation

- [Getting Started](./docs/GETTING-STARTED.md) — installation, first session, phone pairing, and app walkthrough
- [FAQ](./docs/FAQ.md) — Installation, connection, sessions, daemon, voice, upgrading, and development

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Verifying downloads

All release binaries are built in GitHub Actions from tagged commits. You can verify three layers of integrity:

### 1. Checksum (basic)

```bash
# Download the binary and checksums
curl -fsSL -O https://github.com/DaveDev42/teleprompter/releases/download/vX.Y.Z/tp-linux_x64
curl -fsSL -O https://github.com/DaveDev42/teleprompter/releases/download/vX.Y.Z/checksums.txt

# Verify (Linux)
sha256sum --check --ignore-missing checksums.txt
# Verify (macOS)
shasum -a 256 --check --ignore-missing checksums.txt
```

### 2. Cosign keyless signature (recommended)

Verifies that `checksums.txt` was signed by this repo's CI workflow. Protects against a compromised GitHub account re-uploading a doctored `checksums.txt`.

Install [cosign](https://docs.sigstore.dev/cosign/installation/), then:

```bash
curl -fsSL -O https://github.com/DaveDev42/teleprompter/releases/download/vX.Y.Z/checksums.txt
curl -fsSL -O https://github.com/DaveDev42/teleprompter/releases/download/vX.Y.Z/checksums.txt.sig
curl -fsSL -O https://github.com/DaveDev42/teleprompter/releases/download/vX.Y.Z/checksums.txt.pem

cosign verify-blob \
  --certificate checksums.txt.pem \
  --signature checksums.txt.sig \
  --certificate-identity-regexp 'https://github.com/DaveDev42/teleprompter/\.github/workflows/release\.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
```

Expected: `Verified OK`. Then run the checksum check from step 1.

### 3. SLSA build provenance (advanced)

Every binary has a GitHub-native attestation linking it to the exact commit and workflow run that built it. Requires [GitHub CLI](https://cli.github.com/).

```bash
gh attestation verify tp-linux_x64 --owner DaveDev42
```

## License

[BSD 2-Clause](./LICENSE)
