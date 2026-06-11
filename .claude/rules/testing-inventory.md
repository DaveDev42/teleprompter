---
paths:
  - "**/*.test.ts"
  - "e2e/**"
  - "packages/**"
  - "apps/**"
---

# Testing Inventory

Tier 1–3: `bun:test` 사용. Tier 4 (Playwright E2E / Expo MCP QA): `npx playwright test` (`pnpm test:e2e` / `pnpm test:e2e:ci`) 또는 MCP 에이전트 위임 — `bun:test` 아님.

## 명령어
```bash
bun test ./packages/protocol ./packages/daemon ./packages/runner ./apps/cli ./packages/relay  # 전체 Tier 1-3
bun test ./apps/app    # RN 앱 단위 테스트 — 반드시 별도 invocation (아래 apps/app 섹션 참조)
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
pnpm test:e2e          # Playwright E2E (local, 전체)
pnpm test:e2e:ci       # Playwright E2E (CI, daemon 불필요 테스트만)
```

### macOS rooted paths (선행 `./` 필수)

> **macOS 로컬 실행은 반드시 rooted 경로(`./...`)를 사용한다.** `bun test packages/daemon` 처럼
> 선행 `./`(또는 `/`)가 없는 인자는 bun 이 **filter** 로 해석해 repo 전체(~22k 파일)를 스캔하고,
> 디렉토리 fd ~11.6k 개를 쥔 채로 테스트를 실행한다. 이후 테스트가 `spawnSync` 를 부르면 pipe fd 가
> Darwin `OPEN_MAX`(10240, `sys/syslimits.h` 커널 상수) 이상 번호를 받는데, macOS `posix_spawn` 은
> 그 fd 를 자식에 연결하지 못한다 — node 는 `EBADF` 를 던지지만 **bun 은 에러를 조용히 삼켜 자식
> stdout 이 빈 값**이 된다. `worktree-manager.test.ts` 6 fail 의 실제 원인이며, 어떤 터미널에서든
> 재현된다 (Claude Code 샌드박스와 무관). Linux 는 이 제한이 없어 CI 는 영향 없다.
> 회피책 (모두 검증됨): 선행 `./` 경로, 해당 패키지 디렉토리로 `cd` 후 실행, 또는 `--config /dev/null`.
> rooted/un-rooted 의 테스트 발견 범위는 동일하다 (311/311, 1460/1460, 294/294 parity 확인).

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
- `packages/daemon/src/session/session-manager.test.ts` — register/unregister, spawn, kill
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

### apps/app (RN 앱 단위 테스트 — 런타임 의존성 없음, CI 포함)
> **반드시 별도 `bun test apps/app` invocation 으로 실행.** `crypto-native.test.ts` 가
> `mock.module("@teleprompter/protocol/client", …)` 를, `crypto-provider-native.test.ts` 가
> `mock.module("react-native-quick-crypto", …)` 를, `audio-native.test.ts` 가
> `mock.module("react-native-audio-api", …)` 를 쓰는데 bun:test 의 module mock 은
> 프로세스 전역에 잔류한다 — 같은 invocation 에 다른 패키지를 섞으면 후속 crypto 의존
> 테스트 (PairingOrchestrator, RelayClient v2 등 ~38개) 가 스텁을 받아 깨진다.
- `apps/app/src/components/chat-card-md.test.ts` — chat card markdown rendering helpers
- `apps/app/src/hooks/push-toast.test.ts` — push toast hook
- `apps/app/src/lib/ansi-strip.test.ts` — ANSI escape stripping
- `apps/app/src/lib/copy-text.test.ts` — clipboard copy helper
- `apps/app/src/lib/crypto-native.test.ts` — crypto availability probe (ensureSodium 성공/실패 캐싱)
- `apps/app/src/lib/crypto-polyfill.test.ts` — crypto polyfill (boot marker 모듈, getRandomValues)
- `apps/app/src/lib/crypto-provider-native.test.ts` — RNQC native CryptoProvider cross-provider oracle (kx/KDF vs libsodium + BoringSSL X25519, AEAD 레이아웃, base64/hex/UTF-8)
- `apps/app/src/lib/gamepad-input-mapper.test.ts` — gamepad snapshot diff → semantic nav actions (edge-trigger, stick threshold, D-pad/stick 병합)
- `apps/app/src/lib/ghostty-native-html.test.ts` — GhosttyNative WebView HTML builder (UMD 인라인 escape, 브릿지 프로토콜 표면, 폰트/테마 interpolation)
- `apps/app/src/lib/ghostty-web-asset.test.ts` — assets/ghostty-web.umd.txt 신선도 oracle (설치 패키지와 SHA-256 동일) + inline 안전성 (`</script`/`<!--` 부재)
- `apps/app/src/lib/modal-open-registry.test.ts` — modal-open counter (global shortcut 억제용, nested/double-release)
- `apps/app/src/lib/relay-client.test.ts` — FrontendRelayClient (ping cadence, missed-pong force-close)
- `apps/app/src/lib/secure-storage.test.ts` — secureGet/secureSet platform split
- `apps/app/src/lib/session-ux.test.ts` — session UX helpers
- `apps/app/src/lib/shortcut-guards.test.ts` — global shortcut eligibility guards (editable target / modifier / repeat / `data-shortcuts-disabled`)
- `apps/app/src/lib/terminal-search.test.ts` — terminal search
- `apps/app/src/lib/utf8-base64.test.ts` — UTF-8 base64 round-trip + bytesToBase64 (write 브릿지 raw bytes, 청크 경계)
- `apps/app/src/stores/chat-store.test.ts` — chat store (hooks-only event processing)
- `apps/app/src/stores/offline-store.test.ts` — offline queue store
- `apps/app/src/stores/pairing-store.test.ts` — pairing store (Label tagged union)
- `apps/app/src/stores/session-store.test.ts` — session store (relayState discriminated union)
- `apps/app/src/stores/settings-store.test.ts` — settings store
- `apps/app/src/stores/voice-store.test.ts` — voice store
- `apps/app/src/voice/pcm.test.ts` — PCM16/base64/linear-resample pure helpers (web+native 공유)
- `apps/app/src/voice/audio-native.test.ts` — native AudioCapture/AudioPlayer (react-native-audio-api mocked: 권한 흐름, 24kHz 리샘플 캡처, 재생 스케줄링)

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
- 현재 비어있음 — UI 수준 claude PTY E2E는 Playwright(`e2e/app-real-e2e.spec.ts`)로 이관됨.

## Benchmarks
- `packages/relay/src/bench.test.ts` — relay throughput benchmark

## Tier 4: QA Agent Tests (Playwright MCP)
`/qa` 커맨드로 QA agent에 위임. **로컬 Tier 4 기본 경로는 `app-web-qa` (RN Web)이고, 이 64GB Mac에서는 `expo-mcp:qa`도 로컬 실행 가능:**
- `app-web-qa` — React Native Web (Playwright MCP + Playwright Test) — **기본 로컬 QA 경로** (가볍고 빠름)
- `expo-mcp:qa` — iOS Simulator / Android Emulator (Expo MCP Plugin `DaveDev42/expo-mcp` + Maestro). Maestro/JDK-26 불안정 주의 (JDK 17-21 필요). expo-mcp 활성화는 **머신별 결정** — 공유 `.claude/settings.json`은 enable 플래그를 들지 않고(marketplace + `app_dir` config만 유지), 각 머신의 gitignored `.claude/settings.local.json`이 켜고 끈다. **이 64GB M1 Max Mac = `true` (Q4 2026-06-05 PASS)**, 저사양 머신 = `false`. 일상 네이티브 iOS/Android 검증은 EAS 클라우드 빌드 → TestFlight/Internal → 사용자 실기기 디버깅, 큐 항목은 `/verify-native` 로 처리 (CLAUDE.md "iOS 빌드 & 검증 워크플로우" 참조).
- Playwright E2E: `pnpm test:e2e`
  - `e2e/` 에 현재 171개 spec 파일 존재. **CI 실행 목록의 canonical source 는 `playwright.config.ts` `ci` project `testMatch` 배열** (현재 160개) — 새 spec 추가 시 이 배열에 등록해야 CI 에서 실행된다 (`dogfooding.md` "디버그 중 발견한 UI 버그 처리" 참조).
  - 아래 11개 spec 은 **local-only** (daemon/relay 실제 연결 필요 — CI `testMatch` 제외):
    - `e2e/app-chat-resume-dedup.spec.ts` — chat resume deduplication (daemon 필요)
    - `e2e/app-chat-roundtrip.spec.ts` — chat input/output roundtrip (daemon 필요)
    - `e2e/app-daemon.spec.ts` — daemon-connected session list (daemon 필요)
    - `e2e/app-multi-daemon-2x2.spec.ts` — 2×2 multi-daemon/multi-frontend E2EE isolation (daemon 필요)
    - `e2e/app-multi-daemon-nxn.spec.ts` — N:N multi-daemon E2EE independence (daemon 필요)
    - `e2e/app-real-e2e.spec.ts` — real Claude PTY E2E (claude CLI 필요)
    - `e2e/app-relay-e2e.spec.ts` — full relay pipeline (pair → relay → daemon → E2EE)
    - `e2e/app-resume.spec.ts` — daemon restart recovery (daemon 필요)
    - `e2e/app-roundtrip.spec.ts` — input/output roundtrip (daemon 필요)
    - `e2e/app-session-switch.spec.ts` — session list and navigation (daemon 필요)
    - `e2e/app-sessions-refresh-live.spec.ts` — live session list refresh (daemon 필요)
