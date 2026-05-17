---
paths:
  - "**/*.test.ts"
  - "e2e/**"
  - "packages/**"
  - "apps/**"
---

# Testing Inventory

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP Plugin + Playwright MCP).

## 명령어
```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
pnpm test:e2e          # Playwright E2E (local, 전체)
pnpm test:e2e:ci       # Playwright E2E (CI, daemon 불필요 테스트만)
```

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
- `packages/protocol/src/socket-path.test.ts` — path format
- `packages/protocol/src/logger.test.ts` — level filtering, prefix formatting
- `apps/cli/src/args.test.ts` — `--tp-*` 인자 분리
- `apps/cli/src/spawn.test.ts` — runner command resolution
- `apps/cli/src/install-script.test.ts` — `scripts/install.sh` syntax + `NO_COMPLETIONS` / TTY gate / PATH gate 검증
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
- 현재 비어있음 — UI 수준 claude PTY E2E는 Playwright(`e2e/app-real-e2e.spec.ts`)로 이관됨.

## Benchmarks
- `packages/relay/src/bench.test.ts` — relay throughput benchmark

## Tier 4: QA Agent Tests (Expo MCP Plugin + Playwright MCP)
`/qa` 커맨드로 QA agent에 위임:
- `expo-mcp:qa` — iOS Simulator / Android Emulator (Expo MCP Plugin `DaveDev42/expo-mcp` + Maestro)
- `app-web-qa` — React Native Web (Playwright MCP + Playwright Test)
- Playwright E2E: `pnpm test:e2e`
  - `e2e/app-web.spec.ts` — UI smoke tests (Sessions header, empty state, tabs, dark theme)
  - `e2e/app-settings.spec.ts` — settings tab (appearance, theme toggle, fonts, diagnostics, version)
  - `e2e/app-daemon.spec.ts` — daemon-connected session list
  - `e2e/app-session-switch.spec.ts` — session list and navigation
  - `e2e/app-resume.spec.ts` — daemon restart recovery
  - `e2e/app-keyboard-nav.spec.ts` — keyboard navigation (Tab focus, Enter activation, Escape modal dismiss, focus ring)
  - `e2e/app-modal-escape.spec.ts` — Escape key closes modal even when focus is inside a TextInput (RN Web stopPropagation regression)
  - `e2e/app-chat-enter.spec.ts` — chat input Enter-to-send / Shift+Enter-newline (RN Web multiline TextInput regression)
  - `e2e/app-daemons-empty.spec.ts` — daemons empty state on web routes to manual-entry, not the QR-scan dead-end
  - `e2e/app-session-disconnect-banner.spec.ts` — session view shows a "Disconnected — messages will send after reconnect" banner when relay isn't connected
  - `e2e/app-pairing-a11y.spec.ts` — manual pairing screen heading/button roles + textarea label + Connect button keyboard reachability
  - `e2e/app-pairing-scan-web.spec.ts` — /pairing/scan web fallback "Go Back" button has role=button + aria-label and is keyboard-reachable
  - `e2e/app-font-picker-a11y.spec.ts` — FontPickerModal items expose aria-selected on web (RN Web doesn't translate accessibilityState.selected)
  - `e2e/app-aria-disabled.spec.ts` — FontSizeModal boundary buttons expose aria-disabled on web (RN Web doesn't translate accessibilityState.disabled)
  - `e2e/app-sessions-bulk-delete.spec.ts` — Sessions bulk-delete functional flow (edit mode, checkboxes, confirm modal, delete removes rows)
  - `e2e/app-sessions-bulk-delete-a11y.spec.ts` — Sessions bulk-delete a11y (Edit/Cancel/Delete aria attributes, checkbox role, live region mount)
  - `e2e/app-relay-e2e.spec.ts` — full relay pipeline (pair → relay → daemon → E2EE) (local only)
  - `e2e/app-roundtrip.spec.ts` — input/output roundtrip (local only)
  - `e2e/app-real-e2e.spec.ts` — real Claude PTY E2E (local only)
  - `e2e/app-chat-roundtrip.spec.ts` — chat input/output roundtrip (local only)
