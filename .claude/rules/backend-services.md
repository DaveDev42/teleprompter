---
paths:
  - "packages/daemon/**"
  - "packages/runner/**"
  - "packages/relay/**"
  - "apps/cli/**"
---

# Backend Services Conventions

## 공통
- Runtime: Bun — `bun:test` 전용 (jest/vitest 금지)
- Import: `@teleprompter/protocol` (서버용 full export)
- Logger: `createLogger("<Module>")` — 모듈명 prefix
- Error handling: log with logger, expected failures는 throw 대신 error state 반환
- Tests: 소스 옆 co-located (`foo.test.ts`)

## Daemon
- Store: append-only Record 저장 (`sessions.sqlite`)
- Session: SessionManager가 Runner spawn/kill 관리
- IPC: Unix domain socket, framed JSON (Runner↔Daemon)
- Vault key storage: plaintext BLOBs in SQLite — filesystem 권한으로 보호
- Worktree: `git worktree add/remove/list` 직접 관리 (외부 도구 의존 없음)

## Runner
- PTY: `Bun.spawn({ terminal })` — ANSI 출력 수집
- Hooks: Claude Code hooks events 수집 → Record 생성 → IPC 전송
- Settings: 기존 Claude Code settings와 merge (`settings-builder`)

## Relay
- Stateless: ciphertext 전달만 — 복호화 불가 (zero-trust)
- Protocol v2: `relay.register` (self-registration), `relay.kx` (in-band key exchange)
- Caching: 최근 10 frames per session

## CLI
- Subcommand router: `tp daemon|relay|run|pair|status|logs`
- Passthrough: `tp <claude args>` → `--tp-*` flags 분리 후 나머지 claude에 전달
- 인자 분리: `args.test.ts`, `passthrough.test.ts`에서 커버
