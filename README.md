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
| `tp [flags] [claude args]` | Run Claude through tp pipeline (default) |
| `tp pair [--relay URL]` | Generate QR pairing data |
| `tp status` | Show daemon status and sessions |
| `tp logs [session]` | Tail live session output |
| `tp doctor` | Environment diagnostics |
| `tp upgrade` | Upgrade tp + Claude Code |
| `tp version` | Print version |
| `tp daemon start [opts]` | Start daemon in foreground |
| `tp daemon install` | Register as OS service (launchd/systemd) |
| `tp daemon uninstall` | Remove OS service |
| `tp relay start [--port]` | Start a relay server (self-hosted) |
| `tp completions <shell>` | Generate shell completions (bash/zsh/fish) |

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

# Run all tests (unit/integration across 41 test files + 6 Playwright E2E specs)
pnpm test

# Type check all 5 packages
pnpm type-check:all

# Build CLI binary
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
