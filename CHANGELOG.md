# Changelog

## v0.1.3

### PRD Alignment
- Elicitation cards with parsed choice options (indigo theme)
- Permission request cards with tool name and input preview (amber theme)
- Notification events rendered with message text
- Terminal fallback banner for complex interactions (Switch to Terminal / Dismiss)
- Claude version displayed in session list
- TP-namespace internal event system (Collector.tpEvent, Daemon.emitTpEvent)

### Enhanced Diagnostics (PRD Section 18)
- Relay/pairing status section
- Session summary (running/stopped/error counts, worktrees)
- Per-session cached frames count
- Relay attached frontend tracking per session

### Other
- Version compatibility checking (MIN_CLAUDE_VERSION, PROTOCOL_VERSION)
- Performance benchmarks: 10K rec/s pipeline, 476K codec, 62K crypto
- 203 tests across 41 files

---

## v0.1.2

### Improvements
- Configurable daemon URL in Settings (auto-detect or manual override)
- Frontend type checking added to CI (all 5 packages now checked)
- Turbo caching optimized with proper input definitions
- Root pnpm scripts for common workflows (test, type-check:all, build:web)

---

## v0.1.1

### New Commands
- `tp doctor` — environment diagnostics (Bun, Node, pnpm, Claude CLI, Git, daemon, vault)
- `tp init` — quick project setup guide with detected configuration

### UX Improvements
- Theme toggle (dark/light/system) in Settings
- Session search/filter by sid, cwd, worktree, state
- Chat message copy (long-press) and selectable text
- Terminal scrollback search via @xterm/addon-search

### Reliability
- Relay `/health` JSON endpoint and `/admin` HTML dashboard
- WebSocket heartbeat (30s interval) for stale connection detection
- Daemon `--watch` flag for auto-restart on uncaught exceptions
- Session state persistence across daemon restart (stale sessions marked stopped)
- MIT LICENSE file

---

## v0.1.0 — Initial Release

### Core Architecture
- **Runner**: PTY spawn via `Bun.spawn({ terminal })`, hooks collection, IPC client
- **Daemon**: Session manager, Vault (SQLite append-only), IPC server, WebSocket server, relay client, worktree manager, static web serving, graceful shutdown, session pruning
- **Relay**: Token-based auth, bidirectional ciphertext frame routing, session caching (recent 10), online/offline presence, rate limiting (100 msg/sec)
- **Protocol**: Framed JSON codec (u32_be + UTF-8), shared types (IPC/WS/Relay), level-based logger

### E2EE
- X25519 key exchange (ECDH)
- XChaCha20-Poly1305 AEAD encryption
- Per-session ephemeral key ratchet
- QR-based pairing with BLAKE2b-derived relay tokens
- Zero-trust: relay sees only ciphertext

### Frontend (Expo)
- **Chat tab**: Hook event cards (UserPromptSubmit, Stop, PreToolUse, PostToolUse, PermissionRequest, Elicitation), PTY streaming bubbles, chat input
- **Terminal tab**: xterm.js (web), WebView bridge (native), terminal resize forwarding
- **Sessions tab**: Worktree-grouped session list, session switching, stop button
- **Settings tab**: OpenAI API key (secure storage), relay endpoint management, diagnostics panel with RTT
- **Voice**: OpenAI Realtime API (STT + TTS + prompt refinement), terminal context injection
- **Responsive**: Mobile (tabs), tablet (split), desktop (sidebar + split)
- **QR pairing**: Camera scan (native) + manual paste (web)
- **Offline**: Recent 10 frame cache, connection badge with relative time

### CLI (`tp` binary)
- `tp <claude args>` — Passthrough mode (default)
- `tp daemon start` — Full-featured daemon with `--ws-port`, `--repo-root`, `--relay-url`, `--web-dir`, `--prune`, `--verbose`/`--quiet`
- `tp relay start` — Relay server
- `tp pair` — QR pairing data generation with terminal QR display
- `tp status` — Daemon status and session overview
- `tp logs` — Live session record tailing
- `tp version` — Version info

### Infrastructure
- Turborepo + pnpm monorepo
- GitHub Actions CI (type-check, test, build, web export)
- GitHub Actions release (4-platform binary: darwin arm64/x64, linux x64/arm64)
- Relay Dockerfile + docker-compose
- curl-pipe-sh installer (`install.sh`)
- EAS Build configuration (iOS/Android)

### Testing
- 193 tests across 38 files
- Full-stack E2E: Runner → IPC → Daemon → WS/Relay → Frontend
- Crypto E2E: QR pairing → key exchange → ratchet → encrypt/decrypt
- Edge cases: partial frames, unicode, 1MB payloads, tampered ciphertext, rate limiting
