# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. An Expo frontend (React Native + RN Web) connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

## Tech Stack

- **Language**: TypeScript (single stack across all components)
- **Runtime**: Bun v1.3.12+ (Runner, Daemon, Relay), Expo (Frontend)
- **Monorepo**: Turborepo + pnpm
- **Frontend**: Expo (React Native + RN Web), Zustand, NativeWind (Tailwind), ghostty-web (terminal)
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
scripts/
  build.ts     # Multi-platform `bun build --compile` script
  install.sh   # curl-pipe-sh installer for GitHub Releases (macOS/Linux)
  install.ps1  # PowerShell installer for GitHub Releases (Windows)
e2e/           # Playwright E2E tests (.spec.ts)
```

## Architecture

- **Runner** spawns Claude Code in a PTY (macOS/Linux: `PtyBun` via `Bun.spawn({ terminal })`; Windows: `PtyWindows` via Node.js subprocess + `@aspect-build/node-pty` ConPTY), collects io streams and hooks events, sends Records to Daemon via IPC (macOS/Linux: Unix domain socket; Windows: Named Pipe)
- **Daemon** manages sessions, stores Records in Store (append-only per session, with session delete/prune support), persists pairings in store DB for auto-reconnect, encrypts with libsodium per-frontend keys, connects to Relay(s)
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **Frontend** decrypts and renders: Terminal tab (xterm.js) + Chat tab (hooks events + PTY parsing hybrid)
- Data flow: Runner → Daemon → Relay → Frontend (and reverse for input)

## Architecture Invariants (절대 위반 금지)

These are non-negotiable rules. **If code contradicts these, the code is wrong (legacy) — fix the code, not the docs.**

- **Frontend ↔ Daemon 통신은 항상 relay 경유.** Direct WS connection from frontend to daemon does not exist. Any `ws://localhost:*` code path from frontend is legacy and must be removed.
- **Daemon은 WS 서버를 열지 않는다.** Daemon only exposes (a) IPC socket for Runner, (b) outbound WebSocket client to Relay. Any `WsServer`, `startWs()`, `--ws-port` is legacy.
- **Relay는 ciphertext만 전달한다 (zero-trust).** Relay never sees plaintext data. Relay is stateless — it does not track clients beyond the 10-frame cache.
- **Daemon은 frontend를 인식하지 않는다.** No client registry on daemon. Frontend identity exists only via `frontendId` in relay protocol v2.
- **Pairing은 relay URL을 daemon에서 결정한다.** Frontend does not configure relay URL independently; it reads relay URL from the pairing bundle (QR/JSON).

**Reading discipline:** When the codebase contradicts the documented architecture, assume the docs are correct and the code has unreverted legacy. Never infer architecture from code — read CLAUDE.md / ARCHITECTURE.md / PRD.md first, then read code to understand the current implementation state.

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

### Relay Protocol v2
- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt.
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app.
- Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID. Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged in-band via `relay.kx` (encrypted with kxKey derived from pairing secret). Both sides perform ECDH (X25519 `crypto_kx`) → per-frontend session keys → XChaCha20-Poly1305 encryption. Relay token is self-registered via `relay.register` (proof-based, no pre-registration needed). N:N supported — one app connects to multiple daemons, one daemon serves multiple frontends, each with independent E2EE keys identified by `frontendId`.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for `tp` binary (subcommands: daemon, run, relay).
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.
- **Windows support**: PTY via Node.js subprocess + `@aspect-build/node-pty` (Bun PTY Windows unsupported). IPC via Named Pipes (`Bun.listen` native pipe attempt, `node:net` fallback). Service via Task Scheduler (`schtasks.exe`). Build target: `bun-windows-x64`.

## Coding Conventions (Summary)

- Files: kebab-case. Components: PascalCase. Types: PascalCase. No default exports.
- Frontend import: `@teleprompter/protocol/client`. Backend: `@teleprompter/protocol`.
- Type-only: `import type { ... }`. Import sort: Biome 위임.
- Zustand: `create<Interface>((set, get) => ({...}))`, 미들웨어 없음.
- Styling: `tp-*` semantic tokens only. Raw Tailwind colors 금지.
- Tests: `bun:test`, 소스 옆 co-located. Biome = lint + format (ESLint/Prettier 금지). Platform-guarded tests: `describe.skipIf(process.platform !== "win32")` / `describe.skipIf(process.platform === "win32")`.
- 영역별 상세 컨벤션은 `.claude/rules/`에서 자동 로드됨.

## Testing Strategy

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP Plugin + Playwright MCP).

### 명령어
```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
pnpm test:e2e          # Playwright E2E (local, 전체)
pnpm test:e2e:ci       # Playwright E2E (CI, daemon 불필요 테스트만)
```

### Tier 1: Unit Tests
외부 의존성 없이 빠르게 실행.
- `packages/protocol/src/codec.test.ts` — framed JSON encode/decode
- `packages/protocol/src/codec-edge.test.ts` — partial frames, unicode, 100KB payloads
- `packages/protocol/src/queued-writer.test.ts` — backpressure queue
- `packages/protocol/src/crypto.test.ts` — E2EE encrypt/decrypt, key exchange, ratchet, kxKey/registrationProof derivation
- `packages/protocol/src/crypto-edge.test.ts` — empty/large payloads, tampered ciphertext
- `packages/protocol/src/pairing.test.ts` — QR pairing bundle, encode/decode
- `packages/daemon/src/store/store.test.ts` — append-only Record 저장
- `packages/daemon/src/transport/client-registry.test.ts` — WS client 추적
- `packages/daemon/src/session/session-manager.test.ts` — register/unregister, spawn, kill
- `packages/daemon/src/ipc/server.test.ts` — connection lifecycle, framed messaging, findBySid
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
- `apps/cli/src/commands/version.test.ts` — version output
- `apps/cli/src/commands/status.test.ts` — daemon status display
- `apps/cli/src/commands/pair.test.ts` — pairing data generation
- `apps/cli/src/commands/passthrough.test.ts` — arg splitting
- `apps/cli/src/commands/upgrade.test.ts` — checksum parsing, file hashing, backup/rollback
- `packages/protocol/src/compat.test.ts` — protocol version compatibility
- `packages/runner/src/pty/pty-manager.test.ts` — PTY spawn, resize, lifecycle
- `apps/cli/src/lib/service.test.ts` — OS service plist/unit generation

### Tier 2: Integration Tests (stub runner)
Stub 프로세스로 전체 파이프라인 검증.
- `packages/daemon/src/integration.test.ts` — IPC 파이프라인 (mock Runner→Daemon→Store)
- `packages/daemon/src/e2e.test.ts` — 동시 세션, crash, resume, streaming, input relay
- `packages/daemon/src/transport/ws-server.test.ts` — WebSocket 서버 동작
- `packages/daemon/src/transport/relay-client.test.ts` — Daemon→Relay E2E with v2 self-registration + key exchange
- `packages/relay/src/relay-server.test.ts` — Relay auth, routing, caching, presence, relay.push handling
- `packages/relay/src/relay-edge.test.ts` — malformed JSON, multi-frontend, unsubscribe
- `packages/daemon/src/worktree/worktree-manager.test.ts` — git worktree add/remove/list
- `packages/daemon/src/worktree-ws.test.ts` — worktree/session WS protocol handlers
- `apps/cli/src/relay.test.ts` — relay CLI integration
- `packages/protocol/src/pairing-e2e.test.ts` — full QR pairing → ratchet → E2E encrypt
- `packages/runner/src/ipc/client.test.ts` — Runner↔Daemon IPC client connection
- `apps/cli/src/full-stack.test.ts` — Runner→Daemon→Relay→Frontend complete pipeline
- `apps/cli/src/multi-frontend.test.ts` — N:N multi-frontend E2EE (2 frontends, independent keys, cross-decrypt rejection)

### Tier 3: Real E2E Tests (requires claude CLI)
실제 claude PTY를 통한 전체 tp 파이프라인. `claude`가 PATH에 없으면 skip.
- `apps/cli/src/e2e.test.ts` — PTY ANSI output, hooks 이벤트, WS 스트리밍, resume

### Benchmarks
- `packages/daemon/src/bench.test.ts` — pipeline throughput benchmark
- `packages/relay/src/bench.test.ts` — relay throughput benchmark

### Tier 4: QA Agent Tests (Expo MCP Plugin + Playwright MCP)
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
  - `e2e/app-relay-e2e.spec.ts` — full relay pipeline (pair → relay → daemon → E2EE) (local only)
  - `e2e/app-roundtrip.spec.ts` — input/output roundtrip (local only)
  - `e2e/app-real-e2e.spec.ts` — real Claude PTY E2E (local only)
  - `e2e/app-chat-roundtrip.spec.ts` — chat input/output roundtrip (local only)

## Documentation Maintenance

CLAUDE.md, PRD.md, TODO.md, ARCHITECTURE.md must always be kept up to date.
When implementing features, fixing bugs, or making architectural changes,
update the relevant documentation files in the same commit.

## Branch Strategy

- **main**: 보호 브랜치 — PR merge로만 변경. 직접 push 금지.
- **Feature branches**: `feat/`, `fix/`, `chore/`, `refactor/` prefix. PR 생성 후 CI 통과 → merge.
- **Release tags**: `v*` — Release Please가 자동 생성.
- **Merge 방식**: rebase onto `origin/main` → merge commit (squash 아님).

### PR Merge 절차

```bash
# 1. rebase
git fetch origin main && git rebase origin/main

# 2. conflict 해결 후 force push
git push --force-with-lease

# 3. CI 통과 확인
gh pr checks <number>

# 4. merge (worktree 환경에서는 gh pr merge가 main checkout 실패할 수 있음 — API 사용)
gh api repos/DaveDev42/teleprompter/pulls/<number>/merge -X PUT -f merge_method=merge
```

> **주의**: `gh pr merge`는 로컬에서 main을 checkout하려 하므로, git worktree 환경에서는 실패한다.
> 항상 `gh api` PUT 방식을 사용할 것.

## Commit Discipline

- 논리적 작업 단위(기능, 테스트 스위트, 버그 수정) 완료 후 커밋
- 다른 영역으로 컨텍스트 전환 전에 커밋
- 전체 테스트 통과 확인 후에만 커밋
- 깨진 코드나 미완성 코드를 커밋하지 않음
- 문서 업데이트(CLAUDE.md, TODO.md 등)는 해당 코드 변경과 같은 커밋에 포함

## Commit & Release Convention

- **Default to patch version bumps.** Unless the user explicitly asks for a major or minor bump, every change (including API-breaking ones in 0.x) must ship as a patch release. release-please drives version bumps from conventional-commit prefixes.
- **Never use `feat!`, `fix!`, or a `BREAKING CHANGE:` footer** in PR titles, squash-merge messages, or commit messages. These escalate release-please to major bumps automatically (e.g. 0.x → 1.0.0). Use plain `feat:` / `fix:` / `refactor:` / `chore:` instead, and describe breaking changes in the PR body and migration notes rather than the commit prefix.
- **Manual major/minor bump**: when a major/minor release is explicitly requested, push a commit to `main` with a `Release-As: x.y.z` footer (release-please auto-detects it), or temporarily set `release-as` in `release-please-config.json` via a chore PR, then remove it in a follow-up chore PR after the release ships.
- Since this repo uses merge commits (not squash), every commit on the PR branch is visible to release-please; make sure no commit on the branch uses the banned prefixes.

## Git Merge Strategy

- **Squash merge is disabled** on this repository. Use `gh pr merge --merge` (merge commit).
- This repo often uses **git worktrees**. When merging from a worktree, the local `main` branch may belong to another worktree. Always merge via `gh pr merge` (GitHub API) instead of local git merge.
- After merge, clean up remote branch with `--delete-branch` flag.

## Deployment Pipeline

### main push
| Target | Workflow | Condition |
|--------|----------|-----------|
| CI | GitHub Actions `ci.yml` | 항상 (5 parallel jobs: lint, type-check, test, build-cli, e2e) |
| Relay | GitHub Actions `deploy-relay.yml` | packages/relay,protocol,daemon 변경 시 |
| Web | Vercel (자동) | 항상 → `tpmt.dev` |
| EAS Gate | GitHub Actions `ci.yml` eas-gate job | CI 5 jobs pass + apps/app,packages/protocol 변경 시 |
| iOS TestFlight | EAS Workflow `preview.yaml` via eas-gate | Fingerprint → 빌드/OTA → TestFlight 제출 |
| Android Internal | EAS Workflow `preview.yaml` via eas-gate | Fingerprint → 빌드/OTA → Internal track 제출 |

### v* 태그 (Release Please PR merge)
| Target | Workflow | 설명 |
|--------|----------|------|
| tp 바이너리 | GitHub Actions `release.yml` | 4 플랫폼 빌드 → GitHub Release |
| iOS App Store | EAS Workflow `production.yaml` (수동) | Fingerprint → 빌드/OTA → 제출 |
| Android Play Store | EAS Workflow `production.yaml` (수동) | Fingerprint → 빌드/OTA → 제출 |

### 수동
| Workflow | 역할 |
|----------|------|
| `release-please.yml` (dispatch) | Release PR 생성 (version bump + CHANGELOG) |
| `deploy-relay.yml` (dispatch) | 수동 relay 배포 |

### EAS 빌드 최적화
- **Fingerprint**: 네이티브 코드 해시로 기존 빌드 재사용 여부 판단
- **JS만 변경**: OTA 업데이트 발행 (~2분, 빌드 비용 $0)
- **네이티브 변경**: 풀빌드 + 스토어 제출
- **paths 필터**: `dorny/paths-filter`로 apps/app/, packages/protocol/ 변경 감지 → 변경 없으면 EAS skip
- **CI 게이트**: EAS Workflow는 git push로 자동 트리거되지 않음. CI eas-gate가 `eas workflow:run --ref` 로 트리거 (lint/test/type-check 통과 후)
- **EAS 게이트**: CI 5개 job 전부 pass → `expo doctor` → `eas build` (EXPO_TOKEN secret 필요)

### 릴리즈 절차
```bash
# 1. 개발: main에 Conventional Commits로 push (자동 배포)
# 2. 릴리즈 준비: GitHub Actions > Release Please > Run workflow
# 3. 릴리즈: Release PR merge → vX.Y.Z 태그 자동 생성
```

### Infrastructure
- **Relay**: Vultr Seoul `relay.tpmt.dev` (wss://, Caddy TLS + systemd: `tp-relay`)
- **Web**: Vercel → `tpmt.dev`
- **App**: EAS Build → TestFlight / Google Internal / App Store / Play Store
- **CLI**: GitHub Releases → `bun build --compile` (darwin/linux × arm64/x64, windows × x64)

### GitHub Secrets
| Secret | 용도 |
|--------|------|
| `RELAY_HOST` | Relay 서버 IP |
| `RELAY_USER` | Relay SSH 사용자 |
| `RELAY_SSH_KEY` | Relay SSH 키 |

### EAS Credentials (Expo 서버 저장)
- iOS: Distribution Certificate + App Store Connect API Key (ascAppId: 6761056150)
- Android: Keystore + Google Play Service Account Key

## CLI Commands

```bash
tp [flags] [claude args]   # Claude를 tp를 통해 실행 (기본 모드)
tp pair [--relay URL] [--label NAME]   # QR 페어링 데이터 생성 (모바일 앱 연결) — 기본적으로 `pair new` 실행
tp pair new [--relay URL] [--label NAME]  # 새 페어링 생성 (QR 출력, label 기본값 = hostname)
tp pair list               # 등록된 페어링 목록 (label + daemon ID 표시)
tp pair rename <id-prefix> <label...>  # 페어링 label 변경 (peer 알림)
tp pair delete <id> [-y]   # 페어링 삭제 (daemon-id prefix 허용)
tp status                  # 세션 & daemon 상태 확인 (자동 시작)
tp logs [session]          # 세션 라이브 출력 tail
tp doctor                  # 환경 진단 + relay 연결 + E2EE 검증
tp upgrade                 # tp + Claude Code 업그레이드
tp version                 # 버전 출력
tp -- <claude args>        # claude에 직접 포워딩 (daemon 없이)

# Claude 유틸리티 서브커맨드 (daemon 없이 직접 포워딩)
tp auth                    # claude auth
tp mcp                     # claude mcp
tp install                 # claude install
tp update                  # claude update
tp agents                  # claude agents
tp plugin                  # claude plugin
tp setup-token             # claude setup-token

# Daemon 관리
tp daemon start [options]  # Daemon 포그라운드 실행
tp daemon install          # OS 서비스 등록 (macOS: launchd, Linux: systemd)
tp daemon uninstall        # OS 서비스 해제

# 고급
tp relay start [--port]    # Relay 서버 실행
tp completions <shell>     # 셸 자동완성 생성

# Passthrough 플래그
--tp-sid <id>              # 세션 ID (기본: 자동 생성)
--tp-cwd <path>            # 작업 디렉토리 (기본: 현재)
```

Daemon은 자동 관리됨: passthrough/status/logs 실행 시 daemon이 없으면 자동 시작. OS 서비스 설치 시 서비스를 통해 kickstart. 최초 실행 시 `tp daemon install` 안내 한 번 표시.

## Version Management

- **NEVER bump versions** (package.json, app.json, manifest) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x). The first minor bump (0.1.0) is reserved for App Store public release.
- Release Please handles version bumps automatically via Conventional Commits — `bump-patch-for-minor-pre-major` is enabled so `feat:` commits stay patch-level while pre-1.0.
- Do not manually edit `version` fields in any package.json, app.json, or `.release-please-manifest.json`.

### 단일 버전 전략 (tp 바이너리 = Expo 앱 = OTA)

`tp` CLI 바이너리, Expo 앱(TestFlight/Play), OTA 업데이트는 **모두 동일한 `X.Y.Z`를 사용**한다. 단일 소스는 release-please가 관리하는 `package.json` + `apps/app/app.json` (`expo.version`).

버전은 두 축으로 나뉜다:
- **사람 버전** (`expo.version`, `CFBundleShortVersionString`, `versionName`) — release-please가 `app.json`에 기록. EAS는 `appVersionSource: remote`지만 사람 버전은 `app.json`을 그대로 존중한다 (EAS 문서: *"the user-facing version should be explicitly set and updated by you"*).
- **빌드 카운터** (`ios.buildNumber`, `android.versionCode`) — EAS가 remote에 저장하고 `autoIncrement: true`로 빌드 당 +1. Store의 단조증가 제약을 EAS가 책임진다. release-please는 이 값을 건드리지 않는다.

설정:
- `apps/app/eas.json`: `"appVersionSource": "remote"` — 빌드 카운터를 EAS 서버에서 관리.
- `apps/app/app.json`: `"runtimeVersion": { "policy": "appVersion" }` — OTA runtime 키가 `expo.version` 문자열과 일치. 같은 `0.1.x` 안에서는 OTA 가능, 버전 bump 시에만 네이티브 재빌드 필요.
- `eas.json` 각 profile의 `autoIncrement: true`가 `ios.buildNumber` / `android.versionCode`를 증분.

안티패턴:
- `appVersionSource: local` + `autoIncrement`: EAS가 `app.json`을 편집하려 하지만 CI에서 커밋이 안 되어 변경이 사라진다. 또는 buildNumber 카운터가 리셋되어 Store submit 거부.
- `runtimeVersion.policy: fingerprint` + release-please가 `app.json` 편집: 매 릴리즈마다 fingerprint가 바뀌어 OTA 매칭 실패, 항상 네이티브 풀빌드.

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.

## Native Build (Expo Go 드롭 예정)

향후 Apple Watch 앱, 네이티브 libghostty 터미널 등을 위해 Expo Go 호환성 제약을 해제할 예정.
현재는 WASM/asm.js 기반으로 동작하지만, development build 전환 후 네이티브 모듈 사용 가능:
- ✓ libsodium-wrappers-sumo (WASM on Web/Bun, asm.js fallback on Hermes)
- ✓ expo-crypto (Expo SDK 내장 — `getRandomValues` polyfill 제공)
- ✓ ghostty-web (libghostty WASM — Canvas 2D 터미널 렌더링)
- 🔜 react-native-quick-crypto (JSI — development build 전환 후)
- 🔜 libghostty 네이티브 RN 모듈 (Metal/OpenGL GPU 렌더링 — development build 전환 후)
