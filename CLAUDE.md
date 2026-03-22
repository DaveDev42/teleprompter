# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. An Expo frontend (React Native + RN Web) connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

## Tech Stack

- **Language**: TypeScript (single stack across all components)
- **Runtime**: Bun v1.3.5+ (Runner, Daemon, Relay), Expo (Frontend)
- **Monorepo**: Turborepo + pnpm
- **Frontend**: Expo (React Native + RN Web), Zustand, NativeWind (Tailwind), xterm.js
- **Encryption**: libsodium (X25519 + AES-256-GCM)
- **Voice**: OpenAI Realtime API

## Monorepo Layout

```
apps/
  cli/         # @teleprompter/cli — unified `tp` binary (subcommand router)
  frontend/    # Expo app (iOS > Web > Android)
  daemon/      # Bun long-running service (session mgmt, vault, E2EE, worktree)
  runner/      # Bun per-session process (PTY via Bun.spawn terminal, hooks collection)
  relay/       # Bun WebSocket ciphertext-only relay server
packages/
  protocol/    # @teleprompter/protocol — shared types, framed JSON codec, envelope types
  tsconfig/    # Shared TS configs (base.json, bun.json, expo.json)
  eslint-config/
scripts/
  build.ts     # Multi-platform `bun build --compile` script
  install.sh   # curl-pipe-sh installer for GitHub Releases
```

## Architecture

- **Runner** spawns Claude Code in a PTY (`Bun.spawn({ terminal })`), collects io streams and hooks events, sends Records to Daemon via Unix domain socket IPC
- **Daemon** manages sessions, stores Records in Vault (append-only), encrypts with libsodium, connects to Relay(s)
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **Frontend** decrypts and renders: Terminal tab (xterm.js) + Chat tab (hooks events + PTY parsing hybrid)
- Data flow: Runner → Daemon → Relay → Frontend (and reverse for input)

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL. ECDH → HKDF → AES-256-GCM.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for single `tp` binary with subcommands (daemon, run, relay).
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.

## Testing Strategy

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP).

### Tier 1: Unit Tests
외부 의존성 없이 빠르게 실행.
- `packages/protocol/src/codec.test.ts` — framed JSON encode/decode
- `packages/protocol/src/queued-writer.test.ts` — backpressure queue
- `packages/protocol/src/crypto.test.ts` — E2EE encrypt/decrypt, key exchange
- `packages/protocol/src/pairing.test.ts` — QR pairing bundle, encode/decode
- `apps/daemon/src/vault/vault.test.ts` — append-only Record 저장
- `apps/daemon/src/transport/client-registry.test.ts` — WS client 추적
- `apps/runner/src/hooks/settings-builder.test.ts` — settings merge
- `apps/cli/src/args.test.ts` — `--tp-*` 인자 분리

### Tier 2: Integration Tests (stub runner)
Stub 프로세스로 전체 파이프라인 검증.
- `apps/daemon/src/integration.test.ts` — IPC 파이프라인 (mock Runner→Daemon→Vault)
- `apps/daemon/src/e2e.test.ts` — 동시 세션, crash, resume, streaming, input relay
- `apps/daemon/src/transport/ws-server.test.ts` — WebSocket 서버 동작
- `apps/daemon/src/transport/relay-client.test.ts` — Daemon→Relay E2E with encryption
- `apps/relay/src/relay-server.test.ts` — Relay auth, routing, caching, presence
- `apps/daemon/src/worktree/worktree-manager.test.ts` — git worktree add/remove/list
- `packages/protocol/src/pairing-e2e.test.ts` — full QR pairing → ratchet → E2E encrypt

### Tier 3: Real E2E Tests (requires claude CLI)
실제 claude PTY를 통한 전체 tp 파이프라인. `claude`가 PATH에 없으면 skip.
- `apps/cli/src/e2e.test.ts` — PTY ANSI output, hooks 이벤트, WS 스트리밍, resume

### Tier 4: QA Agent Tests (Expo MCP)
`/qa` 커맨드로 `frontend-qa` agent에 위임. 실제 iOS Simulator에서 앱 구동 + UI 인터랙션.

### 명령어
```bash
bun test packages/protocol apps/daemon apps/runner apps/cli apps/relay  # 전체 Tier 1-3
npx tsc --noEmit -p apps/daemon/tsconfig.json                # 타입 체크
npx tsc --noEmit -p apps/cli/tsconfig.json
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
