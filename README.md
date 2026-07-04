# Teleprompter

[![CI](https://github.com/DaveDev42/teleprompter/actions/workflows/ci.yml/badge.svg)](https://github.com/DaveDev42/teleprompter/actions/workflows/ci.yml)
[![Deploy Relay](https://github.com/DaveDev42/teleprompter/actions/workflows/deploy-relay.yml/badge.svg)](https://github.com/DaveDev42/teleprompter/actions/workflows/deploy-relay.yml)
[![License: BSD-2-Clause](https://img.shields.io/badge/License-BSD_2--Clause-blue.svg)](./LICENSE)

A self-hosted developer tool that lets you view and drive **your own** Claude Code sessions from **your own** phone — like VS Code Remote or `tmux` over SSH, scoped to a single operator. You run the daemon on your own machine and pair your own device (end-to-end encrypted); it gives you a dual Chat/Terminal UI plus voice input. **Full native rewrite in progress** (Swift app + Rust core — see [ADR-0001](./docs/adr/0001-full-native-rewrite-swift-rust.md)). The Expo/RN app stack has been removed; the backend (Bun daemon/relay/runner) is retained as reference while the rewrite progresses.

## Quick Start

### macOS (Homebrew)

```bash
brew install davedev42/tap/tp
```

### macOS / Linux (curl)

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

### Windows

Native Windows is not supported. Run `tp` inside [WSL](https://learn.microsoft.com/windows/wsl/) using the Linux installer:

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

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

Scan the QR code with the Teleprompter app. The app connects to your daemon **through the relay** with end-to-end encryption — no direct local connection.

> **Note:** The Expo/RN Web app and TestFlight/Android builds have been removed (full native rewrite in progress — ADR-0001). The Swift iOS app is currently a minimal Phase-0 shell; pairing UI and full feature parity are planned for Phase 3.

### Auto-start on Login

```bash
tp daemon install      # macOS launchd / Linux systemd
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
| `tp daemon install` | Register as OS service (launchd / systemd) |
| `tp daemon uninstall` | Remove OS service |
| `tp relay start [--port]` | Start a relay server (self-hosted) |
| `tp completions <bash\|zsh\|fish>` | Print shell completion script |
| `tp completions install [shell]` | Install completion into the current shell rc / profile |
| `tp completions uninstall [shell]` | Remove installed completion |
| `tp auth` / `mcp` / `install` / `update` / `agents` / `auto-mode` / `plugin` / `setup-token` | Forward to `claude` (daemon bypass) |

## Architecture

```
Runner ──IPC──→ Daemon ──WSS (E2EE)──→ Relay ──WSS (E2EE)──→ App
 (PTY)          (Store)                (forwarder)           (Swift)
```

- **Runner**: Spawns Claude Code in a PTY, collects io streams and hooks events, communicates with Daemon via IPC (Unix domain socket)
- **Daemon**: Manages sessions, stores records, encrypts with libsodium per-frontend keys, connects to Relay(s) as a client
- **Relay**: Stateless forwarder of already-encrypted frames (keeps only a 10-frame reconnect buffer per session). As an untrusted hosted hop it has no access to your plaintext — the same end-to-end-encryption privacy property Signal or WireGuard provide.
- **App**: Swift (SwiftUI) iOS app — full native rewrite in progress (ADR-0001). Currently Phase-0 boot-marker shell; Chat + Terminal + Voice UI planned for Phase 3. Connects to paired daemon(s) via Relay only.

**All frontend↔daemon traffic flows through the Relay with E2EE.** Daemon does not run a WebSocket server; the App does not connect directly to the Daemon. Pairing (QR/JSON) delivers the Daemon's public key and relay URL offline; frontend pubkey is exchanged in-band via `relay.kx`.

## Monorepo Structure

```
apps/
  cli/            # Unified `tp` binary
ios/              # Swift app (SwiftUI — full native rewrite, Phase 0 done)
  project.yml     # XcodeGen spec
  Sources/        # Swift source
  Tests/          # Swift tests
packages/
  daemon/         # Session management, Store, IPC server, Relay client
  runner/         # PTY management, hooks collection
  relay/          # WebSocket ciphertext relay
  protocol/       # Shared types, codec, crypto, pairing
  tsconfig/       # Shared TypeScript configs
scripts/
  build.ts        # Multi-platform bun build --compile (tp CLI)
  ios.sh          # iOS Simulator build/install/launch harness
  install.sh      # curl-pipe-sh installer (macOS/Linux; Windows users run under WSL)
```

## Development

```bash
pnpm install

# Run all bun:test suites across the workspace (unit + integration)
pnpm test

# Type check every workspace package
pnpm type-check:all

# Build CLI binary
pnpm build:cli:local    # current platform
pnpm build:cli          # every release target (see scripts/build.ts TARGETS)

# Swift app — iOS Simulator build + install + launch
bash scripts/ios.sh

# Environment diagnostics
pnpm doctor
```

## Key Technologies

- **TypeScript + Bun** — backend stack (Runner, Daemon, Relay, CLI)
- **Swift (SwiftUI)** — iOS app (full native rewrite — ADR-0001, Phase 0 done)
- **Rust (`tp-core`)** — shared crypto/codec core via UniFFI FFI (Phase 2, not yet built)
- **libsodium** — X25519 key exchange + XChaCha20-Poly1305 AEAD encryption
- **OpenAI Realtime API** — voice input/output with STT + TTS (planned Phase 3)

## Security

- End-to-end encrypted (E2EE) communication
- QR-based pairing with X25519 ECDH key exchange
- Per-session ephemeral key ratchet
- Relay forwards only already-encrypted frames — as an untrusted hop it has no access to your plaintext (standard E2EE, as in Signal/WireGuard)
- API keys stored in iOS Keychain (planned Phase 3)

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
