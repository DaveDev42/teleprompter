---
paths:
  - "**/*.test.ts"
  - "packages/**"
  - "apps/cli/**"
---

# Testing Inventory

Tier 1–3: `bun:test` 사용. Expo/RN Web/Playwright/Maestro/expo-mcp 기반 Tier 4는 제거됨 (앱이 Swift로 리라이트됨 — ADR-0001).

## 명령어
```bash
bun test ./packages/protocol ./packages/daemon ./packages/runner ./apps/cli ./packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner)
```

### macOS rooted paths (선행 `./` 필수)

> **macOS 로컬 실행은 반드시 rooted 경로(`./...`)를 사용한다.** `bun test packages/daemon` 처럼
> 선행 `./`(또는 `/`)가 없는 인자는 bun 이 **filter** 로 해석해 repo 전체(~22k 파일)를 스캔하고,
> 디렉토리 fd ~11.6k 개를 쥔 채로 테스트를 실행한다. 이후 테스트가 `spawnSync` 를 부르면 pipe fd 가
> Darwin `OPEN_MAX`(10240, `sys/syslimits.h` 커널 상수) 이상 번호를 받는데, macOS `posix_spawn` 은
> 그 fd 를 자식에 연결하지 못한다 — node 는 `EBADF` 를 던지지만 **bun 은 에러를 조용히 삼켜 자식
> stdout 이 빈 값**이 된다. 이는 un-rooted filter 모드 일반의 함정이다 (어떤 터미널에서든 재현,
> Claude Code 샌드박스와 무관). Linux 는 이 제한이 없어 CI 는 영향 없다.
> 회피책 (모두 검증됨): 선행 `./` 경로, 해당 패키지 디렉토리로 `cd` 후 실행, 또는 `--config /dev/null`.
> rooted/un-rooted 의 테스트 발견 범위는 동일하다 (311/311, 1460/1460, 294/294 parity 확인).
>
> **정정 (PR #796):** `worktree-manager.test.ts` 의 pre-push/worktree fail 은 위 fd 압박이
> *아니라* **상속된 `GIT_DIR` 이 원인**이었다. `git push` pre-push 훅 안에서 테스트가 돌면 git 이
> `GIT_DIR=<repo>/.git/worktrees/<name>` 를 export 하는데, export 된 `GIT_DIR` 은 `spawnSync` 의
> `cwd` 옵션과 `git -C` 플래그를 **둘 다 override** 한다 — 그래서 테스트의 `git config user.name Test`
> +`git commit -m init` 이 격리 tmp repo 가 아니라 호출자 worktree 를 건드려 그 HEAD 와 local config 를
> 오염시켰다 (author 가 `Test <test@test.com>` 로 바뀌고 stray `init` 커밋 발생). `ulimit -n` 은 훅
> 안팎이 동일하므로 fd 가설은 이 케이스에 맞지 않았다. 수정 = `worktree-manager.{ts,test.ts}` 양쪽에서
> 자식 env 의 `GIT_*` 제거 (`gitEnv()`/`gitTestEnv()`), `cwd` 를 authoritative 하게 만든다. 검증:
> `GIT_DIR` export 하에서도 15 pass / 0 fail + HEAD·config clean.

### Bun `terminal:` PTY 가 Linux 에서 프로세스를 안 죽이는 함정 (`runner-parity.test.ts`)

> **Bun 1.3.13 Linux 에서 `terminal:`(PTY) 로 spawn 한 자식이 종료해도 event-loop 핸들이 안 풀려
> 부모 Bun 프로세스가 자연 종료(loop-drain)로 절대 안 끝난다.** WSL Ubuntu(=CI 와 동일 OS)에서 Bun
> 1.3.13/1.3.14 양쪽으로 재현 검증: fake claude(`printf; exit 7`)를 `terminal:` PTY 로 띄우면 자식
> `.exited` 는 ~1ms 에 resolve 하지만, 그 뒤 부모가 IPC 소켓을 `.end()` 하고 `bye` 를 보낸 뒤에도
> **프로세스가 안 죽는다**(25s 풀 hang, rc=124). `proc.kill()`(=`Runner.stop()` 의 `pty.kill()`)·`unref()`
> 로도 핸들이 안 풀리고, **오직 명시적 `process.exit()`** 만 종료시킨다(16ms). macOS(로컬 1.3.14)는 핸들이
> 풀려 자연 종료 → 그래서 로컬은 통과, CI(Linux 1.3.13)만 hang. **프로덕션 무영향**: daemon 은 독립적
> `proc.exited` 모니터(`session-manager.ts:151`)로 세션을 강제 settle 하고, dogfood 는 macOS 전용.
>
> `runner-parity.test.ts` 의 `captureRunnerFrames` 는 이 때문에 **runner *프로세스* exit 을 기다리지
> 않는다** — 대신 runner 가 마지막에 보내는 **`bye` *프레임*이 캡처되면**(hello+io 다음, hang 전에 항상
> 도착) resolve 하고 `proc.kill()` 한다. 파리티 어서션(hello/io/bye)은 전부 유지되고 Bun-Linux 핸들
> 함정에 면역이다. 검증: 로컬 macOS 830ms pass, WSL Linux 1.3.13 에서 bye-대기 14ms resolve + clean exit.
> **runner 프로덕션 종료 로직에 `process.exit()` 를 테스트만을 위해 넣지 말 것** — `bye` flush 를 끊을 수
> 있고, SIGINT/SIGTERM 경로(`index.ts gracefulShutdown`)만 이미 신중한 `setImmediate` 로 다룬다.

## Tier 1: Unit Tests
외부 의존성 없이 빠르게 실행.
- `packages/protocol/src/codec.test.ts` — framed JSON encode/decode
- `packages/protocol/src/codec-edge.test.ts` — partial frames, unicode, 100KB payloads
- `packages/protocol/src/queued-writer.test.ts` — backpressure queue
- `packages/protocol/src/crypto.test.ts` — E2EE encrypt/decrypt, key exchange, ratchet, kxKey/registrationProof derivation
- `packages/protocol/src/crypto-edge.test.ts` — empty/large payloads, tampered ciphertext
- `packages/protocol/src/pairing.test.ts` — QR pairing bundle, encode/decode
- `packages/protocol/src/control.test.ts` — control.unpair/control.rename 타입 상수 및 discriminated union shape
- `packages/protocol/src/test-utils.test.ts` — `rmRetry` 디렉터리 삭제 헬퍼 (EBUSY 재시도)
- `packages/daemon/src/store/store.test.ts` — append-only Record 저장
- `packages/daemon/src/session/session-manager.test.ts` — register/unregister, spawn, kill, 단일-요소 Rust-runner baseCmd argv shape
- `packages/daemon/src/session/runner-parity.test.ts` — **Bun↔Rust `tp-runner` differential wire-parity 게이트** (같은 fake claude 로 두 runner 구동 → `FrameDecoder` 로 hello/io/bye 캡처 → pid/ts 제외 byte-equal + JSON 키순서 + io 사이드카 byte-stream equal; Rust 바이너리 미빌드 시 SKIP). `TP_RUNNER_BIN` dual-run seam 의 byte-exactness gate.
- `packages/daemon/src/ipc/server.test.ts` — connection lifecycle, framed messaging, findBySid
- `packages/daemon/src/index.test.ts` — daemon entry point이 legacy `--ws-port`/`startWs`를 import하지 않는지 소스 검증
- `packages/daemon/src/daemon-passthrough-helpers.test.ts` — `Daemon.onRecord` 콜백, passthrough 세션 helper 동작
- `packages/daemon/src/export-formatter.test.ts` — 세션 export markdown formatter (event/io records)
- `packages/daemon/src/pairing/pending-pairing.test.ts` — `PendingPairing.begin()` 키/QR 생성, relay open 흐름
- `packages/runner/src/hooks/settings-builder.test.ts` — settings merge
- `packages/runner/src/hooks/hook-receiver.test.ts` — unix socket event reception
- `packages/runner/src/hooks/capture-hook.test.ts` — hook command generation
- `packages/runner/src/collector.test.ts` — io/event/meta record creation
- `packages/daemon/src/store/session-db.test.ts` — append, cursor, payloads
- `packages/daemon/src/store/store-cleanup.test.ts` — deleteSession, pruneOldSessions
- `packages/daemon/src/store/store-rust-parity.test.ts` — **Bun `Store` ↔ Rust `tp-daemon` 양방향 shared-file 파리티 게이트** (ADR-0003 Phase 4 daemon inc1). 같은 on-disk vault dir 에 Bun 이 쓰고 Rust probe(`tp-daemon-probe`)가 읽기 + 역방향 → session/pairing/record 행·BLOB byte-identical + WAL sidecar unlink + WAL-mode PRAGMA parity 검증. probe 는 고정 line-oriented CLI(write-session/dump-sessions/write-pairing/dump-pairings/append-rec/dump-recs/delete-session — plan 문서 §"inc1 parity-gate probe contract")로 driving 하므로 Rust 내부 메서드명과 decouple. **Rust probe 바이너리 미빌드 시 SKIP** (`cd rust && cargo build --bin tp-daemon-probe`; `runner-parity.test.ts` SKIP 선례). Rust store 가 Bun daemon 이 쓰는 바로 그 `sessions.sqlite` 를 교환 가능하게 여닫는다는 불변식의 byte-exactness gate.
- `packages/daemon/src/auto-cleanup.test.ts` — daemon auto-cleanup on startup, periodic scheduler, TTL config
- `packages/daemon/src/push/push-notifier.test.ts` — hook event detection, token registration, push dispatch
- `packages/relay/src/push.test.ts` — Expo Push API client, rate limiting, dedup
- `packages/relay/src/push-seal.test.ts` — PushSealer round-trip, key rotation, legacy/tamper/truncated cases (Path X)
- `packages/protocol/src/socket-path.test.ts` — path format
- `packages/protocol/src/logger.test.ts` — level filtering, prefix formatting
- `packages/protocol/src/control-guard.test.ts` — control message guards
- `packages/protocol/src/crypto-init-race.test.ts` — concurrent sodium init race
- `packages/protocol/src/guard-primitives.test.ts` — base guard helpers
- `packages/protocol/src/hook-guard.test.ts` — hook event guards
- `packages/protocol/src/ipc-guard.test.ts` — IPC frame guards
- `packages/protocol/src/relay-client-guard.test.ts` — relay client message guards
- `packages/protocol/src/relay-guard.test.ts` — relay message guards
- `packages/protocol/src/relay-server-guard.test.ts` — relay server frame guards
- `packages/protocol/src/session-server-guard.test.ts` — session server guards
- `packages/protocol/src/session-state.test.ts` — session state machine
- `packages/protocol/src/types/label.test.ts` — Label tagged-union guards
- `packages/daemon/src/ipc/command-dispatcher.test.ts` — IPC command dispatch
- `packages/daemon/src/pairing/pairing-orchestrator.test.ts` — pairing lifecycle orchestration
- `packages/daemon/src/store/pairing-row-guard.test.ts` — store pairing row guards
- `packages/daemon/src/store/session-meta.test.ts` — session metadata
- `packages/daemon/src/transport/relay-manager.test.ts` — relay client lifecycle management
- `packages/relay/src/backpressure.test.ts` — slow consumer disconnect
- `packages/relay/src/relay-capacity.test.ts` — connection capacity invariants
- `packages/relay/src/relay-push-delivery.test.ts` — push delivery routing
- `packages/relay/src/resume-token.test.ts` — HMAC resume token
- `packages/runner/src/index.test.ts` — runner entry point
- `packages/runner/src/runner.test.ts` — runner lifecycle
- `apps/cli/src/router.test.ts` — subcommand routing
- `apps/cli/src/manifest-guards.test.ts` — react/react-dom version invariants
- `apps/cli/src/commands/help.test.ts` — `tp --help` subcommand coverage
- `apps/cli/src/commands/session-cleanup.test.ts` — non-TTY cleanup path
- `apps/cli/src/commands/logs.test.ts` — `resolveLogsSid` exact/prefix/ambiguous/none resolution (mirrors `tp session delete`'s `matchSessions` UX)
- `apps/cli/src/commands/relay.test.ts` — relay subcommand smoke
- `apps/cli/src/lib/daemon-op.test.ts` — `requestDaemonOp` shared IPC helper (resolve, timeout, early-close, always-closes)
- `apps/cli/src/lib/download.test.ts` — binary download + checksum
- `apps/cli/src/lib/osc52.test.ts` — OSC52 clipboard
- `apps/cli/src/lib/paths.test.ts` — `resolveTpBinary` path resolution
- `apps/cli/src/args.test.ts` — `--tp-*` 인자 분리
- `apps/cli/src/spawn.test.ts` — runner command resolution
- `apps/cli/src/install-script.test.ts` — `scripts/install.sh` syntax + `NO_COMPLETIONS` / TTY gate / PATH gate 검증
- `apps/cli/src/commands/run.test.ts` — `runCommand` graceful shutdown logic (SIGINT/SIGTERM calls runner.stop + double-signal guard) and NaN guard parity for cols/rows
- `apps/cli/src/commands/version.test.ts` — version output
- `apps/cli/src/commands/status.test.ts` — daemon status display
- `apps/cli/src/commands/pair.test.ts` — pairing data generation
- `apps/cli/src/commands/passthrough.test.ts` — arg splitting
- `apps/cli/src/commands/session.test.ts` — `tp session list/delete/prune` (parseDuration, matchSessions, daemon-less Store fallback integration)
- `apps/cli/src/commands/upgrade.test.ts` — checksum parsing, file hashing, backup/rollback
- `apps/cli/src/commands/completions.test.ts` — 각 쉘 completion 스크립트 출력에 tp/claude 서브커맨드 포함 여부
- `apps/cli/src/commands/completions-install.test.ts` — bash/zsh/fish rc 파일 marker 블록 install/uninstall
- `apps/cli/src/commands/daemon.test.ts` — daemon.ts 소스가 legacy `loadPairingData`/`pairing.json`을 참조하지 않는지 정적 검증
- `apps/cli/src/commands/daemon-status.test.ts` — `tp daemon status` 출력 배너/힌트 스모크
- `apps/cli/src/commands/forward-claude.test.ts` — `CLAUDE_UTILITY_SUBCOMMANDS` set 구성
- `apps/cli/src/commands/forward-claude.integration.test.ts` — `forwardToClaudeCommand` argv verbatim + exit-code propagation + "claude not found" error path (fake claude via env param)
- `apps/cli/src/commands/doctor.integration.test.ts` — `doctorCommand` tool probe (node/pnpm/claude/git present vs missing), daemon-down path, claude-doctor invocation; Bun.spawnSync/spawn mocked (un-rooted invocations push pipe fds past Darwin `OPEN_MAX` → 자식 stdout 소실 — 위 "macOS rooted paths" 참조)
- `apps/cli/src/lib/colors.test.ts` — ANSI color wrapper (NO_COLOR honor)
- `apps/cli/src/lib/e2ee-verify.test.ts` — `verifyE2EECrypto` 자가검증 (daemon↔frontend, relay isolation)
- `apps/cli/src/lib/ensure-daemon.test.ts` — `isDaemonRunning` / install prompt 결정 / yes-no 파싱
- `apps/cli/src/lib/format.test.ts` — `errorWithHints` 에러 메시지 포매터
- `apps/cli/src/lib/ipc-client.test.ts` — `connectIpcAsClient` framed JSON 송수신 (POSIX unix socket 경로)
- `apps/cli/src/lib/daemon-lock.test.ts` — `acquireDaemonLock`/`releaseDaemonLock`/`checkDaemonLockAlive` pid-file singleton (via `@teleprompter/daemon` re-export)
- `apps/cli/src/lib/pair-lock.test.ts` — `acquirePairLock`/`releasePairLock` 동시성 (proper-lockfile)
- `apps/cli/src/lib/shell-detect.test.ts` — `$SHELL` 기반 POSIX 쉘 감지
- `apps/cli/src/lib/spinner.test.ts` — spinner start/stop 라이프사이클
- `apps/cli/src/lib/service.test.ts` — OS service plist/unit generation
- `apps/cli/src/components/ink/yes-no-prompt.test.tsx` — YesNoPrompt rendering (question text, [Y/n]/[y/N] hints), key handling (y/Y/n/N/Enter/Escape), promptYesNo non-TTY + aborted signal short-circuit
- `apps/cli/src/components/ink/text-prompt.test.tsx` — TextPrompt rendering (question, placeholder), typing/submit/cancel, validation error + error-clears-on-keystroke, promptText non-TTY + aborted signal short-circuit
- `apps/cli/src/components/ink/spinner.test.tsx` — Spinner renders message, animates over time (multi-frame), hidden when non-TTY, accepts all frame types
- `apps/cli/src/components/ink/key-handler.test.tsx` — single binding fires, unbound key ignored, multiple bindings fire independently, ctrl+c binding, space binding, children rendered
- `packages/protocol/src/compat.test.ts` — protocol version compatibility
- `packages/runner/src/pty/pty-manager.test.ts` — PTY spawn, resize, lifecycle

## Tier 2: Integration Tests (stub runner)
Stub 프로세스로 전체 파이프라인 검증.
- `packages/daemon/src/integration.test.ts` — IPC 파이프라인 (mock Runner→Daemon→Store)
- `packages/daemon/src/daemon-pairing.test.ts` — `Daemon.beginPairing`/`completePairing` + fake RelayClient
- `packages/daemon/src/transport/relay-client.test.ts` — Daemon→Relay E2E with v2 self-registration + key exchange
- `packages/relay/src/relay-server.test.ts` — Relay auth, routing, caching, presence, relay.push handling
- `packages/relay/src/relay-edge.test.ts` — malformed JSON, multi-frontend, unsubscribe
- `packages/daemon/src/worktree/worktree-manager.test.ts` — git worktree add/remove/list
- `apps/cli/src/relay.test.ts` — relay CLI integration
- `packages/protocol/src/pairing-e2e.test.ts` — full QR pairing → ratchet → E2E encrypt
- `packages/runner/src/ipc/client.test.ts` — Runner↔Daemon IPC client connection
- `apps/cli/src/multi-frontend.test.ts` — N:N multi-frontend E2EE (2 frontends, independent keys, cross-decrypt rejection)
- `apps/cli/src/pair-blocking.test.ts` — `tp pair new`가 실제 daemon subprocess에서 frontend kx 완료까지 블록 (SIGINT 경로 포함)
- `apps/cli/src/rename-e2e.test.ts` — `control.rename` 라운드트립 (Daemon + 실제 RelayServer)
- `apps/cli/src/unpair-e2e.test.ts` — `control.unpair` 라운드트립 (Daemon + 실제 RelayServer)

## Tier 3: Real E2E Tests (requires claude CLI)
실제 claude PTY를 통한 전체 tp 파이프라인. `claude`가 PATH에 없으면 skip.
- 현재 비어있음.

## Benchmarks
- `packages/relay/src/bench.test.ts` — relay throughput benchmark
