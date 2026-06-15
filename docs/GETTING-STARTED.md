# Getting Started with Teleprompter

Teleprompter (`tp`) lets you control Claude Code sessions remotely from your phone or browser,
with end-to-end encryption, a dual Chat/Terminal UI, and voice input.

This guide walks you through installation, your first session, and connecting the mobile app.

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| **OS** | macOS or Linux (Windows: run under WSL) | `uname -s` |
| **Claude Code CLI** | Latest | `claude --version` |
| **pnpm** (build from source only) | Latest | `pnpm --version` |
| **Bun** (build from source only) | 1.3.13+ | `bun --version` |

> **Windows users:** native Windows is not supported. Install WSL (`wsl --install` in PowerShell as Administrator), then follow the Linux instructions below from inside your WSL distro.

## Quick Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

This downloads the latest `tp` binary to `~/.local/bin/tp`. If `~/.local/bin` is not in your
`PATH`, the installer will print the command to add it.

### Windows

Native Windows is not supported. Inside WSL, run the macOS/Linux installer above.

To verify the installation:

```bash
tp version
```

### Build from Source

```bash
git clone https://github.com/DaveDev42/teleprompter.git
cd teleprompter
pnpm install
pnpm build:cli:local    # outputs dist/tp for your platform
```

## Step 1: Run Your First Session

Use passthrough mode to run Claude Code through the tp pipeline:

```bash
tp -p "explain this codebase"
```

This spawns a Runner (PTY process), starts a Daemon in the background, and streams Claude's
output through the teleprompter pipeline. All `--tp-*` flags are consumed by tp; everything
else is forwarded to Claude.

You can also specify a session ID and working directory:

```bash
tp --tp-sid my-feature --tp-cwd ~/projects/my-app -p "add error handling to the API routes"
```

## Step 2: Check Status

See what's running:

```bash
tp status
```

This shows the daemon status, active sessions, and connection info. If the daemon isn’t
running, start it with `tp daemon start` or install it as an OS service with `tp daemon install`.

## Step 3: Connect Your Phone

Generate pairing data to connect the mobile app via the encrypted relay:

```bash
tp pair --relay wss://relay.tpmt.dev
```

Each pairing has a human-readable **label** (auto-seeded from the device hostname,
override with `--label NAME`) plus a cryptographic **daemon ID**. The label is what
you see in `tp pair list` and in the app; the ID is the internal identifier tied to
E2EE keys. Rename later with `tp pair rename <id-prefix> <new label>` — the peer is
notified automatically.

This outputs a QR code and **blocks** until the mobile app completes the ECDH key exchange (press Ctrl+C to cancel).

> **Note:** The iOS app (Swift/SwiftUI, in `ios/`) is currently at Phase 0 of the native rewrite (ADR-0001) — a boot-marker shell. Full pairing UI is not yet implemented. The pairing flow described above will be wired up in a later phase.

The connection is end-to-end encrypted (X25519 + XChaCha20-Poly1305). The relay server
never sees your plaintext data.

## Step 4: Auto-start the Daemon

Install the daemon as an OS service so it starts automatically on login:

```bash
tp daemon install
```

This creates a launchd plist (macOS) or a systemd user unit (Linux). To uninstall later:

```bash
tp daemon uninstall
```

## Step 5: Run Diagnostics

Verify your environment, relay connectivity, and E2EE:

```bash
tp doctor
```

This checks:
- Claude Code CLI availability and version
- Daemon health
- Relay connectivity
- E2EE key exchange and encryption round-trip

## Using the App

> **Rewrite in progress:** The iOS app has been rewritten in Swift/SwiftUI (see `ios/` and [ADR-0001](../docs/adr/0001-full-native-rewrite-swift-rust.md)). The app is currently at Phase 0 — a boot-marker shell. The full Chat/Terminal/Daemons/Settings UI described below is the target design and will be implemented in subsequent phases. This section will be updated as each phase ships.

## CLI Reference

| Command | Description |
|---------|-------------|
| `tp [flags] [claude args]` | Run Claude through tp pipeline (default) |
| `tp pair [--relay URL] [--label NAME]` | Generate QR and block until the mobile app scans it (Ctrl+C to cancel) |
| `tp pair list` | List registered pairings (shows label + daemon ID) |
| `tp pair rename <id-prefix> <label...>` | Rename a pairing and notify the peer |
| `tp pair delete <id> [-y]` | Delete a pairing (notifies the peer app/daemon so it also removes the pairing) |
| `tp session list` | List sessions (running + stopped, shows cwd and last-updated) |
| `tp session delete <sid> [-y]` | Delete a session by ID (prefix match; kills runner first if running) |
| `tp session prune [--older-than <Nd>] [--all] [--dry-run] [-y]` | Bulk-delete stopped sessions non-interactively |
| `tp session cleanup [-y] [--all]` | Interactive multi-select bulk-delete for stopped sessions (requires TTY) |
| `tp status` | Show daemon status and sessions |
| `tp logs [session]` | Tail live session output |
| `tp doctor` | Environment diagnostics |
| `tp upgrade` | Upgrade tp + Claude Code |
| `tp version` | Print version |
| `tp daemon start [opts]` | Start daemon in foreground |
| `tp daemon install` | Register as OS service (launchd/systemd) |
| `tp daemon uninstall` | Remove OS service |
| `tp relay start [--port]` | Start a relay server |
| `tp completions <shell>` | Generate shell completions (bash/zsh/fish) |

### Passthrough Flags

| Flag | Description |
|------|-------------|
| `--tp-sid <id>` | Session ID (default: auto-generated) |
| `--tp-cwd <path>` | Working directory (default: current) |

All other flags are forwarded directly to `claude`.

> **Tip:** Use `tp -- <claude args>` to forward arguments directly to Claude without the
> daemon pipeline. tp also forwards subcommands like `auth`, `mcp`, and `update` directly
> to Claude — run `tp <subcommand> --help` for details.

## Troubleshooting

**tp: command not found**
- macOS / Linux: ensure `~/.local/bin` is in your `PATH`:
  ```bash
  export PATH="$HOME/.local/bin:$PATH"
  ```
  Add this to your `~/.zshrc` or `~/.bashrc` to make it permanent.

**Daemon won't start**
- Check if another daemon is already running: `tp status`
- Check logs: `tp logs`
- Run diagnostics: `tp doctor`

**Can't connect from the app**
- Ensure the relay URL is reachable: `tp doctor` tests relay connectivity
- Re-pair if keys have changed: generate a new QR with `tp pair`
- Check that your phone has internet access

**Sessions not appearing in the app**
- Verify the daemon is running: `tp status`
- Check the Diagnostics panel in the app for connection status
- Ensure pairing is active (Diagnostics > Relay / Pairing)

## Windows users

Native Windows is not supported. Run `tp` inside [WSL](https://learn.microsoft.com/windows/wsl/) (Windows Subsystem for Linux) using the Linux build:

1. Install WSL: open PowerShell as Administrator and run `wsl --install`. Reboot when prompted.
2. Launch your WSL distro (Ubuntu by default), then follow the macOS / Linux installer above from inside WSL.
3. The app on your phone connects through the relay just like on a native Linux box — no extra Windows-side setup needed.

For more help, search [existing issues](https://github.com/DaveDev42/teleprompter/issues)
or open a new one on GitHub.
