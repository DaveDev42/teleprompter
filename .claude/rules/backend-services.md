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
- Session: SessionManager가 Runner spawn/kill 관리 (= mux: 세션당 1 Runner)
- IPC: Unix domain socket / Named Pipe, framed JSON. Runner↔Daemon io/event/meta + CLI↔Daemon 명령 (`pair.begin`, `pair.remove`, `pair.rename`, 등)
- Vault key storage: plaintext BLOBs in SQLite — filesystem 권한으로 보호
- Worktree: `git worktree add/remove/list` 직접 관리 (외부 도구 의존 없음)
- Relay outbound client: `RelayConnectionManager`가 pairing당 1 `RelayClient` 유지. **Daemon은 relay의 유일한 클라이언트** (invariant) — CLI는 직접 relay WS를 열지 않음.
- Pair ops handler (`IpcCommandDispatcher`): `pair.remove` → `RelayConnectionManager.removePairing` (peer에 `control.unpair` → client.dispose → store.deletePairing). `pair.rename` → `RelayConnectionManager.renamePairing` (store.updatePairingLabel → 연결된 peer에 `control.rename`). 양쪽 다 notified peer 수를 ok 응답에 반환.

## Runner
- PTY: `Bun.spawn({ terminal })` — ANSI 출력 수집
- Hooks: Claude Code hooks events 수집 → Record 생성 → IPC 전송
- Settings: 기존 Claude Code settings와 merge (`settings-builder`)

## Relay
- Stateless: ciphertext 전달만 — 복호화 불가 (zero-trust)
- Protocol v2: `relay.register` (self-registration), `relay.kx` (in-band key exchange)
- Caching: 최근 N frames per session (default 10, override via `TP_RELAY_CACHE_SIZE` env)

## Platform Gotchas (실제 반복된 함정)

- **Windows EBUSY on fs.rm / fs.rmdir**: 테스트에서 worktree/temp dir를 정리할 때 Windows는 파일 핸들이 아직 열려 있으면 `EBUSY`/`EPERM`을 던진다. `fs.rm(dir, { recursive, force })` 직접 호출 금지. `@teleprompter/protocol/test-utils`의 `rmRetry`를 쓴다 (retry with backoff, 핸들 해제 대기).
- **jsdom navigator mutation 격리**: jsdom 환경에서 전역 `navigator.*`를 건드리는 테스트는 **파일 단위로 격리**해야 한다. 같은 파일 안에서 `beforeEach`로 되돌리는 것은 다른 테스트 파일이 같은 vm context를 공유하면 오염된다. `bun:test` 기준: navigator 만지는 테스트는 별도 `*.test.ts` 파일로.
- **Unix socket path 길이**: macOS/Linux의 sockaddr_un은 path 길이가 104/108 bytes로 제한. `$TMPDIR`이 긴 CI 러너에서 socket path가 초과하면 `ENAMETOOLONG`. `packages/protocol/src/socket-path.ts`는 이미 hash 단축으로 회피 — 신규 IPC 엔드포인트 추가 시 이 헬퍼를 재사용할 것.
- **Windows Named Pipe vs POSIX socket**: IPC 클라이언트 (`apps/cli/src/lib/ipc-client*.ts`, `packages/runner/src/ipc/client.ts`)는 platform 분기 필요. `process.platform === "win32"` 로 `connectWindowsIpc`(node:net, `\\.\pipe\...`) vs `Bun.connect`(unix socket). 새 IPC 클라이언트 만들 때 분기 누락 방지.
- **`tp pair new` concurrency**: 동시 실행을 `proper-lockfile`로 막는다 (`pair.lock`). pair-related 변경 시 이 lock을 건너뛰는 코드경로를 만들지 말 것 — 동시에 두 개의 PendingPairing이 relay에 떠서 identity 꼬인다.
- **RelayClient reconnect/ping**: `packages/daemon/src/transport/relay-client.ts`의 `RECONNECT_MAX_MS` / `PING_INTERVAL_MS`를 줄이면 Windows에서 ConPTY 초기 비용이 겹칠 때 재연결 폭주가 날 수 있다. 수치를 바꾸기 전에 이 파일의 테스트(`relay-client.test.ts`)가 handshake/reconnect race를 재현하는 fake relay로 검증하는지 확인.

## CLI (`apps/cli/src`)
- Entry: `index.ts` — subcommand router wrapped in `async main()` (no top-level await; enables future `--bytecode` builds).
- Subcommands: `daemon`, `run`, `relay`, `pair`, `status`, `logs`, `doctor`, `upgrade`, `completions`, `version` (see `SUBCOMMANDS` set in `index.ts`).
- Claude utility forwards (daemon-bypass): `auth`, `mcp`, `install`, `update`, `agents`, `auto-mode`, `plugin`, `plugins`, `setup-token` — listed in `claude-subcommands.ts` (`CLAUDE_UTILITY_SUBCOMMANDS`).
- Passthrough: `tp <claude args>` (unrecognized first arg) → `--tp-*` flags 분리 후 나머지 claude에 전달.
- 인자 분리 테스트: `args.test.ts`, `passthrough.test.ts`.
- Background update check (`checkForUpdates`): 24h-cached, rate-limited even on network failure, `TP_NO_UPDATE_CHECK=1` opt-out. Skipped for passthrough, `run`, `version`, `--help`, `--`, claude utility forwards.
