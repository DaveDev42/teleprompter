# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. An Expo frontend (React Native + RN Web) connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

## Tech Stack

- **Language**: TypeScript (single stack across all components)
- **Runtime**: Bun v1.3.5+ (Runner, Daemon, Relay), Expo (Frontend)
- **Monorepo**: Turborepo + pnpm
- **Frontend**: Expo (React Native + RN Web), Zustand, NativeWind (Tailwind), xterm.js
- **Encryption**: libsodium (X25519 + XChaCha20-Poly1305)
- **Voice**: OpenAI Realtime API

## Monorepo Layout

```
apps/
  cli/         # @teleprompter/cli — unified `tp` binary (subcommand router)
  app/         # @teleprompter/app — Expo app (iOS > Web > Android)
packages/
  daemon/      # @teleprompter/daemon — Bun long-running service (session mgmt, vault, E2EE, worktree)
  runner/      # @teleprompter/runner — Bun per-session process (PTY via Bun.spawn terminal, hooks collection)
  relay/       # @teleprompter/relay — Bun WebSocket ciphertext-only relay server
  protocol/    # @teleprompter/protocol — shared types, framed JSON codec, envelope types
  tsconfig/    # Shared TS configs (base.json, bun.json)
  eslint-config/
scripts/
  build.ts     # Multi-platform `bun build --compile` script
  install.sh   # curl-pipe-sh installer for GitHub Releases
```

## Architecture

- **Runner** spawns Claude Code in a PTY (`Bun.spawn({ terminal })`), collects io streams and hooks events, sends Records to Daemon via Unix domain socket IPC
- **Daemon** manages sessions, stores Records in Vault (append-only per session, with session delete/prune support), encrypts with libsodium, connects to Relay(s)
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **Frontend** decrypts and renders: Terminal tab (xterm.js) + Chat tab (hooks events + PTY parsing hybrid)
- Data flow: Runner → Daemon → Relay → Frontend (and reverse for input)

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID. Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged via relay. Both sides perform ECDH (X25519 `crypto_kx`) → session keys → XChaCha20-Poly1305 encryption. Relay token is derived from pairing secret (BLAKE2b) for session routing access control only.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for `tp` binary (subcommands: daemon, run, relay) and separate `tp-relay` binary for standalone relay deployment.
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.

## Testing Strategy

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP).

### Tier 1: Unit Tests
외부 의존성 없이 빠르게 실행.
- `packages/protocol/src/codec.test.ts` — framed JSON encode/decode
- `packages/protocol/src/codec-edge.test.ts` — partial frames, unicode, 100KB payloads
- `packages/protocol/src/queued-writer.test.ts` — backpressure queue
- `packages/protocol/src/crypto.test.ts` — E2EE encrypt/decrypt, key exchange, ratchet
- `packages/protocol/src/crypto-edge.test.ts` — empty/large payloads, tampered ciphertext
- `packages/protocol/src/pairing.test.ts` — QR pairing bundle, encode/decode
- `packages/daemon/src/vault/vault.test.ts` — append-only Record 저장
- `packages/daemon/src/transport/client-registry.test.ts` — WS client 추적
- `packages/daemon/src/session/session-manager.test.ts` — register/unregister, spawn, kill
- `packages/daemon/src/ipc/server.test.ts` — connection lifecycle, framed messaging, findBySid
- `packages/runner/src/hooks/settings-builder.test.ts` — settings merge
- `packages/runner/src/hooks/hook-receiver.test.ts` — unix socket event reception
- `packages/runner/src/hooks/capture-hook.test.ts` — hook command generation
- `packages/runner/src/collector.test.ts` — io/event/meta record creation
- `packages/daemon/src/vault/session-db.test.ts` — append, cursor, payloads
- `packages/daemon/src/vault/vault-cleanup.test.ts` — deleteSession, pruneOldSessions
- `packages/protocol/src/socket-path.test.ts` — path format
- `packages/protocol/src/logger.test.ts` — level filtering, prefix formatting
- `apps/cli/src/args.test.ts` — `--tp-*` 인자 분리
- `apps/cli/src/spawn.test.ts` — runner command resolution
- `apps/cli/src/commands/version.test.ts` — version output
- `apps/cli/src/commands/status.test.ts` — daemon status display
- `apps/cli/src/commands/pair.test.ts` — pairing data generation
- `apps/cli/src/commands/passthrough.test.ts` — arg splitting
- `packages/protocol/src/compat.test.ts` — protocol version compatibility
- `packages/runner/src/pty/pty-manager.test.ts` — PTY spawn, resize, lifecycle

### Tier 2: Integration Tests (stub runner)
Stub 프로세스로 전체 파이프라인 검증.
- `packages/daemon/src/integration.test.ts` — IPC 파이프라인 (mock Runner→Daemon→Vault)
- `packages/daemon/src/e2e.test.ts` — 동시 세션, crash, resume, streaming, input relay
- `packages/daemon/src/transport/ws-server.test.ts` — WebSocket 서버 동작
- `packages/daemon/src/transport/relay-client.test.ts` — Daemon→Relay E2E with encryption
- `packages/relay/src/relay-server.test.ts` — Relay auth, routing, caching, presence
- `packages/relay/src/relay-edge.test.ts` — malformed JSON, multi-frontend, unsubscribe
- `packages/daemon/src/worktree/worktree-manager.test.ts` — git worktree add/remove/list
- `packages/daemon/src/worktree-ws.test.ts` — worktree/session WS protocol handlers
- `apps/cli/src/relay.test.ts` — relay CLI integration
- `packages/protocol/src/pairing-e2e.test.ts` — full QR pairing → ratchet → E2E encrypt
- `packages/runner/src/ipc/client.test.ts` — Runner↔Daemon IPC client connection
- `apps/cli/src/full-stack.test.ts` — Runner→Daemon→Relay→Frontend complete pipeline

### Tier 3: Real E2E Tests (requires claude CLI)
실제 claude PTY를 통한 전체 tp 파이프라인. `claude`가 PATH에 없으면 skip.
- `apps/cli/src/e2e.test.ts` — PTY ANSI output, hooks 이벤트, WS 스트리밍, resume

### Benchmarks
- `packages/daemon/src/bench.test.ts` — pipeline throughput benchmark
- `packages/relay/src/bench.test.ts` — relay throughput benchmark

### Tier 4: QA Agent Tests (Expo MCP)
`/qa` 커맨드로 QA agent에 위임:
- `app-ios-qa` — iOS Simulator (Expo MCP + Maestro)
- `app-web-qa` — React Native Web (Playwright)
- Playwright E2E: `pnpm test:e2e`
  - `e2e/app-web.spec.ts` — smoke tests
  - `e2e/app-roundtrip.spec.ts` — input/output roundtrip
  - `e2e/app-resume.spec.ts` — daemon restart recovery
  - `e2e/app-real-e2e.spec.ts` — real Claude PTY E2E
  - `e2e/app-daemon.spec.ts` — daemon-connected tests
  - `e2e/app-chat-roundtrip.spec.ts` — chat input/output roundtrip

### 명령어
```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
```

## Documentation Maintenance

CLAUDE.md, PRD.md, TODO.md, ARCHITECTURE.md must always be kept up to date.
When implementing features, fixing bugs, or making architectural changes,
update the relevant documentation files in the same commit.

## Commit Discipline

- 논리적 작업 단위(기능, 테스트 스위트, 버그 수정) 완료 후 커밋
- 다른 영역으로 컨텍스트 전환 전에 커밋
- 전체 테스트 통과 확인 후에만 커밋
- 깨진 코드나 미완성 코드를 커밋하지 않음
- 문서 업데이트(CLAUDE.md, TODO.md 등)는 해당 코드 변경과 같은 커밋에 포함

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.
