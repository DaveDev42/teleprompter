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
- Caching: 최근 N frames per session (default 10, override via `TP_RELAY_CACHE_SIZE` env)

## CLI (`apps/cli/src`)
- Entry: `index.ts` — subcommand router wrapped in `async main()` (no top-level await; enables future `--bytecode` builds).
- Subcommands: `daemon`, `run`, `relay`, `pair`, `status`, `logs`, `doctor`, `upgrade`, `completions`, `version` (see `SUBCOMMANDS` set in `index.ts`).
- Claude utility forwards (daemon-bypass): `auth`, `mcp`, `install`, `update`, `agents`, `auto-mode`, `plugin`, `plugins`, `setup-token` — listed in `claude-subcommands.ts` (`CLAUDE_UTILITY_SUBCOMMANDS`).
- Passthrough: `tp <claude args>` (unrecognized first arg) → `--tp-*` flags 분리 후 나머지 claude에 전달.
- 인자 분리 테스트: `args.test.ts`, `passthrough.test.ts`.
- Background update check (`checkForUpdates`): 24h-cached, rate-limited even on network failure, `TP_NO_UPDATE_CHECK=1` opt-out. Skipped for passthrough, `run`, `version`, `--help`, `--`, claude utility forwards.
