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
- **Daemon** is a long-running mux that (a) spawns and supervises one Runner per session, (b) manages git worktrees (`git worktree add/remove/list`), (c) stores Records in Store (append-only per session, with session delete/prune support), (d) persists pairings in store DB for auto-reconnect, (e) encrypts with libsodium per-frontend keys, (f) holds the **only** outbound WebSocket client to the Relay(s), and (g) handles pair-ops IPC (`pair.remove` / `pair.rename`) from the CLI so the CLI never opens its own RelayClient
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
- **Daemon은 relay의 유일한 클라이언트다.** CLI는 직접 relay WebSocket을 열지 않는다. 페어링은 CLI → daemon (IPC) → relay 경로로만 흐른다.

**Reading discipline:** When the codebase contradicts the documented architecture, assume the docs are correct and the code has unreverted legacy. Never infer architecture from code — read CLAUDE.md / ARCHITECTURE.md / PRD.md first, then read code to understand the current implementation state.

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

### Relay Protocol v2
- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.remove` IPC (fallback when daemon is stopped: direct `Store` write, peer learns on next reconnect).
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.rename` IPC (fallback when daemon is stopped: direct `Store` write, peer syncs on next reconnect).
- Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`

## Key Design Decisions

- Chat UI uses **hybrid** data: hooks events for structured cards (primary) + PTY output parsing for streaming text (secondary). hooks Stop event finalizes responses.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID. Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged in-band via `relay.kx` (encrypted with kxKey derived from pairing secret). Both sides perform ECDH (X25519 `crypto_kx`) → per-frontend session keys → XChaCha20-Poly1305 encryption. Relay token is self-registered via `relay.register` (proof-based, no pre-registration needed). N:N supported — one app connects to multiple daemons, one daemon serves multiple frontends, each with independent E2EE keys identified by `frontendId`.
- Platform priority: iOS > Web > Android. Responsive layout required for mobile/tablet/desktop.
- Deployment: `bun build --compile` for `tp` binary (subcommands: daemon, run, relay).
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.
- **Windows support**: PTY via Node.js subprocess + `@aspect-build/node-pty` (Bun PTY Windows unsupported). IPC via Named Pipes (`Bun.listen` native pipe attempt, `node:net` fallback). Service via Task Scheduler (`schtasks.exe`). Build target: `bun-windows-x64`.
- Pairing is completion-gated: `tp pair new` blocks until the frontend completes ECDH kx. Pending pairings live in daemon memory only; store DB holds completed pairings. `pairing.json`은 더 이상 존재하지 않는다. CLI는 daemon이 떠있지 않으면 자동으로 시작하며 (`ensureDaemon()`), pair lock (`proper-lockfile` on `pair.lock`)으로 동시 `tp pair new` 실행을 막는다.

## Coding Conventions (Summary)

- Files: kebab-case. Components: PascalCase. Types: PascalCase. No default exports.
- Frontend import: `@teleprompter/protocol/client`. Backend: `@teleprompter/protocol`.
- Type-only: `import type { ... }`. Import sort: Biome 위임.
- Zustand: `create<Interface>((set, get) => ({...}))`, 미들웨어 없음.
- Styling: `tp-*` semantic tokens only. Raw Tailwind colors 금지.
- Tests: `bun:test`, 소스 옆 co-located. Biome = lint + format (ESLint/Prettier 금지). Platform-guarded tests: `describe.skipIf(process.platform !== "win32")` / `describe.skipIf(process.platform === "win32")`.
- 영역별 상세 컨벤션은 `.claude/rules/`에서 자동 로드됨.

## Subagent Dispatch

Agent 호출 시 항상 `model` 명시. plugin agent (e.g., `superpowers:code-reviewer`)는
frontmatter가 `model: inherit`이라 미명시 시 부모 Opus 상속.

- **탐색/grep/짧은 요약**: `model: "haiku"` (e.g., `Explore`, file lookups)
- **코드 작업/리뷰/구현**: `model: "sonnet"` (e.g., `superpowers:code-reviewer`,
  `general-purpose`)
- **어려운 설계/추론만 opus**: 명확히 필요할 때만
- **QA**: 회귀(`.spec.ts` 실행, Maestro flow 재생) = `haiku`,
  탐색적 QA (버그 hunt, 새 시나리오, 페어링/세팅 우회 추론 필요) = `sonnet`
  (`app-web-qa` / `expo-mcp:qa` 모두 동일 룰)

## Testing Strategy

4계층 테스트, 모두 `bun:test` 사용 (Tier 4는 Expo MCP Plugin + Playwright MCP).

### 명령어
```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay  # 전체 Tier 1-3
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner, app)
pnpm test:e2e          # Playwright E2E (local, 전체)
pnpm test:e2e:ci       # Playwright E2E (CI, daemon 불필요 테스트만)
```

또는 슬래시 커맨드 사용 — 변경 파일 기반 자동 dispatch:
- `/test [auto|protocol|daemon|runner|relay|cli|app|e2e|unit|all]` — 변경 범위 감지 후 실행
- `/qa [web|mobile]` — Tier 4 QA agent에 위임 (Playwright/Expo MCP)
- `/deploy-check` — CI와 동일한 로컬 사전 검증

Tier 1-4 분류 및 전체 test 파일 인벤토리는 `.claude/rules/testing-inventory.md` 참조 — `*.test.ts` / `e2e/**` / `packages/**` / `apps/**` 파일 작업 시 자동 로드됨.

## Documentation Maintenance

CLAUDE.md, PRD.md, TODO.md, ARCHITECTURE.md must always be kept up to date.
When implementing features, fixing bugs, or making architectural changes,
update the relevant documentation files in the same commit.

## Branch Strategy

- **main**: 보호 브랜치 — PR merge로만 변경. 직접 push 금지.
- **Feature branches**: `feat/`, `fix/`, `chore/`, `refactor/` prefix. PR 생성 후 CI 통과 → merge.
- **Release tags**: `v*` — Release Please가 자동 생성.
- **Merge 방식**: **squash merge only**. PR 하나가 main 위에 단일 commit으로 떨어진다.

### PR Merge 절차

```bash
# 1. (선택) main 변경이 충돌할 가능성이 있으면 rebase
git fetch origin main && git rebase origin/main && git push --force-with-lease

# 2. CI 통과 확인
gh pr checks <number>

# 3. squash merge (worktree 환경에서는 gh pr merge가 main checkout 실패할 수 있음 — API 사용)
gh api repos/DaveDev42/teleprompter/pulls/<number>/merge -X PUT -f merge_method=squash
```

> **주의**: `gh pr merge`는 로컬에서 main을 checkout하려 하므로, git worktree 환경에서는 실패한다.
> 항상 `gh api` PUT 방식을 사용할 것.
>
> **GitHub repo 설정**: `allow_squash_merge=true`, `allow_merge_commit=false`, `allow_rebase_merge=false`,
> `squash_merge_commit_title=PR_TITLE`, `squash_merge_commit_message=PR_BODY`, `delete_branch_on_merge=true`.
> squash commit subject는 **PR title이 그대로 들어간다** — 그래서 PR title이 conventional-commit
> prefix를 꼭 따라야 한다 (`feat:` / `fix:` / `chore:` / `refactor:` / `perf:` / `revert:`).
> PR 브랜치 위 개별 commit message는 자유 형식이어도 무방 (squash 시 main 히스토리에서 사라짐).

## Commit Discipline

- 논리적 작업 단위(기능, 테스트 스위트, 버그 수정) 완료 후 커밋
- 다른 영역으로 컨텍스트 전환 전에 커밋
- 전체 테스트 통과 확인 후에만 커밋
- 깨진 코드나 미완성 코드를 커밋하지 않음
- 문서 업데이트(CLAUDE.md, TODO.md 등)는 해당 코드 변경과 같은 커밋에 포함

## Commit & Release Convention

- **Default to patch version bumps.** Unless the user explicitly asks for a major or minor bump, every change (including API-breaking ones in 0.x) must ship as a patch release. release-please drives version bumps from conventional-commit prefixes.
- **PR title is the conventional-commit input** for release-please (squash merge → PR title becomes the commit subject on main). 모든 PR title은 `feat:` / `fix:` / `chore:` / `refactor:` / `perf:` / `revert:` / `docs:` / `test:` 중 하나로 시작해야 한다.
- **Never use `feat!`, `fix!`, or a `BREAKING CHANGE:` footer** in PR titles. These escalate release-please to major bumps automatically (e.g. 0.x → 1.0.0). Use plain `feat:` / `fix:` / `refactor:` / `chore:` instead, and describe breaking changes in the PR body and migration notes rather than the title prefix.
- **Manual major/minor bump**: when a major/minor release is explicitly requested, push a commit to `main` with a `Release-As: x.y.z` footer (release-please auto-detects it), or temporarily set `release-as` in `release-please-config.json` via a chore PR, then remove it in a follow-up chore PR after the release ships.
- PR 브랜치 위 개별 commit messages는 conventional-commit 규칙을 따르지 않아도 된다 — squash merge가 합쳐서 PR title 하나로 main에 들어가므로 release-please는 PR title만 본다. 단, 커밋 본문에 `BREAKING CHANGE:` footer는 squash 시에도 main까지 따라가서 release-please가 잡으므로 절대 쓰지 말 것.

## Git Merge Strategy

- **Squash merge only.** PR 하나당 main 위에 단일 commit. GitHub repo 설정에서 squash 외 모든 merge 방식이 비활성화되어 있다.
- **PR title = main commit subject**: squash 시 GitHub이 PR title을 그대로 commit subject로, PR body를 commit body로 쓴다. PR title을 작성/수정할 때 release-please / changelog 입력으로서의 무게를 의식할 것.
- This repo often uses **git worktrees**. 로컬 `main`이 다른 worktree에 체크아웃되어 있을 수 있으므로 `gh pr merge` 대신 `gh api repos/DaveDev42/teleprompter/pulls/<n>/merge -X PUT -f merge_method=squash` 사용.
- After merge, GitHub이 자동으로 remote branch를 삭제 (`delete_branch_on_merge=true`).

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
tp session list            # 저장된 세션 목록 (running + stopped, cwd/updated 컬럼)
tp session delete <sid> [-y]           # 세션 삭제 (sid prefix 허용, running 이면 Runner kill 후 삭제)
tp session prune [options] # stopped 세션 일괄 삭제
  --older-than <Nd|Nh|Nm|Ns>   # 나이 컷오프 (기본 7d)
  --all                         # 모든 stopped 세션 (older-than 무시)
  --running                     # running 도 포함 (위험 — 2중 confirmation)
  --dry-run                     # 삭제 대상만 출력
  -y, --yes                     # confirmation 생략
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
tp auto-mode               # claude auto-mode
tp plugin                  # claude plugin
tp plugins                 # claude plugins (plural alias)
tp setup-token             # claude setup-token

# Daemon 관리
tp daemon start [options]  # Daemon 포그라운드 실행
tp daemon install          # OS 서비스 등록 (macOS: launchd, Linux: systemd)
tp daemon uninstall        # OS 서비스 해제

# 고급
tp relay start [--port]    # Relay 서버 실행
tp completions <bash|zsh|fish|powershell>   # 셸 자동완성 스크립트 출력
tp completions install [shell]              # 현재 쉘에 완성 자동 등록 (--force, --dry-run)
tp completions install powershell --profile-dir <path>  # pwsh 프로필 경로 override (install.ps1이 $PROFILE.CurrentUserAllHosts의 디렉터리를 전달)
tp completions uninstall [shell]           # 설치된 완성 제거

# Passthrough 플래그
--tp-sid <id>              # 세션 ID (기본: 자동 생성)
--tp-cwd <path>            # 작업 디렉토리 (기본: 현재)
```

Daemon은 자동 관리됨: passthrough/status/logs 실행 시 daemon이 없으면 자동 시작. OS 서비스 설치 시 서비스를 통해 kickstart. 최초 실행 시 TTY에서는 `Install daemon as an OS service ... [Y/n]` 프롬프트가 뜨고, 비-TTY(CI/파이프)에서는 한 번짜리 힌트만 표시.

### Environment Variables

| Var | Effect |
|-----|--------|
| `TP_NO_UPDATE_CHECK=1` | Suppress the background "new version available" check on startup |
| `TP_NO_AUTO_INSTALL=1` | Force first-run to skip the interactive "install daemon service?" prompt, even on a TTY; falls back to the dim hint line |

## Shell Completions

`tp completions install [shell]` 실행 시 shell 미지정이면 `$SHELL` (또는 `$ZSH_VERSION`/`$BASH_VERSION`/`$FISH_VERSION`) 을 기반으로 자동 감지.

### Installer Opt-out Knobs

| Knob | Scope | 설명 |
|------|-------|------|
| `NO_COMPLETIONS=1` | env | `install.sh` 및 `install.ps1` 모두에서 completion 설치 건너뜀 |
| `--no-completions` | flag | `install.sh` 로컬 직접 실행 시 opt-out (`curl \| bash` 불가) |
| `-NoCompletions` | flag | `install.ps1` PowerShell param 스위치 opt-out |
| `TP_AUTO_COMPLETIONS=1` | env | `install.sh` non-TTY(`curl \| bash`) 환경에서 강제 설치 활성화 |

`install.sh`는 non-TTY 환경(`curl | bash`)에서 기본적으로 completion 설치를 건너뜀.

`install.ps1`은 `$InstallDir`이 `$PATH`에 없으면 completion 설치를 건너뜀 (PATH 추가 후 `tp completions install` 수동 실행 안내).

Fish와 PowerShell은 완성 스크립트를 디스크에 기록하므로 `tp upgrade` 후 `tp completions install <shell> --force` 를 재실행해야 최신 상태로 갱신됨.

> **주의:** `tp completions install` 중에 rc/Profile 파일을 동시에 수정하면 동시 편집 내용이 덮어쓰일 수 있음 (TOCTOU). 완성 설치 중에는 해당 파일 편집 회피 권장.

## Version Management

- **NEVER bump versions** (package.json, app.json, manifest) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x). The first minor bump (0.1.0) is reserved for App Store public release.
- Release Please handles version bumps automatically via Conventional Commits — `bump-patch-for-minor-pre-major` is enabled so `feat:` commits stay patch-level while pre-1.0.
- Do not manually edit `version` fields in any package.json, app.json, or `.release-please-manifest.json`.

### 단일 버전 전략 (tp 바이너리 = Expo 앱 = OTA)

`tp` CLI 바이너리, Expo 앱(TestFlight/Play), OTA 업데이트는 **모두 동일한 `X.Y.Z`를 사용**한다. 단일 소스는 release-please가 관리하는 `package.json` + `apps/app/app.json` (`expo.version`).

버전은 두 축으로 나뉜다:
- **사람 버전** (`expo.version`, `CFBundleShortVersionString`, `versionName`) — release-please가 `app.json`에 기록. `"appVersionSource": "remote"`는 빌드 카운터만 EAS 서버에서 관리할 뿐 사람 버전에는 관여하지 않는다 ([EAS 문서](https://docs.expo.dev/build-reference/app-versions/): 사람 버전은 새 릴리즈 때마다 개발자가 직접 설정/갱신해야 한다고 안내).
- **빌드 카운터** (`ios.buildNumber`, `android.versionCode`) — EAS가 remote에 저장하고 `autoIncrement: true`로 빌드당 +1. Store의 단조증가 제약을 EAS가 책임진다. release-please는 이 값을 건드리지 않는다. iOS와 Android는 독립 카운터이므로 두 플랫폼 사이 숫자가 달라도 정상.

#### 설정

- `apps/app/eas.json`: `"appVersionSource": "remote"` — 빌드 카운터를 EAS 서버에서 관리.
- `apps/app/app.json`: `"runtimeVersion": { "policy": "appVersion" }` — OTA runtime 키가 `expo.version` 문자열과 일치. 같은 `0.1.x` 안에서는 OTA 가능, 버전 bump 시에만 네이티브 재빌드 필요.
- `eas.json`의 store 제출용 profile (`preview`, `production`)에서 `"autoIncrement": true`가 `ios.buildNumber` / `android.versionCode`를 증분 (`development` profile은 해당 없음).
- **연동 메커니즘**: `release-please-config.json`의 `extra-files` 항목 (`path: apps/app/app.json`, `jsonpath: $.expo.version`)이 `app.json`의 `expo.version`을 `package.json`과 동일 버전으로 bump한다. 이 항목을 제거하면 tp 바이너리와 앱 사이 버전 정렬이 깨진다.

#### 안티패턴

- `"appVersionSource": "local"` + `autoIncrement`: EAS가 빌드 시점에 `app.json`의 `buildNumber`/`versionCode`를 편집하지만 CI에서는 이 변경이 커밋되지 않는다. 결과적으로 다음 빌드가 낮은 카운터로 시작해 Store submit 단계에서 기존 카운터와 충돌해 거부된다. (PR #108 merge 직후 iOS `buildNumber 2`가 실제로 생성되었고 App Store Connect에는 이미 `44`가 존재. 해당 Expo workflow run은 submit 단계 이전에 `CANCELED` 상태로 종료(Android 빌드 포함)되어 Apple 측에는 도달하지 않음.)
- `"runtimeVersion": { "policy": "fingerprint" }` + release-please `extra-files`로 `app.json` 편집: release-please가 매 릴리즈마다 `app.json`을 수정하면 fingerprint 해시가 그 편집을 따라 매번 달라지고, 기존 TestFlight 설치본과 OTA 매칭 실패 — 매 릴리즈가 네이티브 풀빌드를 강제함. fingerprint policy를 유지하려면 `extra-files`에서 `app.json`을 제거해야 하는데, 그러면 단일 버전 전략이 깨진다. `policy: appVersion`이 올바른 선택.

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.

## Native Build (Expo Go 드롭 예정)

향후 Apple Watch 앱, 네이티브 libghostty 터미널 등을 위해 Expo Go 호환성 제약을 해제할 예정.
현재는 WASM/asm.js 기반으로 동작하지만, development build 전환 후 네이티브 모듈 사용 가능:
- ✓ libsodium-wrappers (WASM on Web/Bun, asm.js fallback on Hermes)
- ✓ expo-crypto (Expo SDK 내장 — `getRandomValues` polyfill 제공)
- ✓ ghostty-web (libghostty WASM — Canvas 2D 터미널 렌더링)
- 🔜 react-native-quick-crypto (JSI — development build 전환 후)
- 🔜 libghostty 네이티브 RN 모듈 (Metal/OpenGL GPU 렌더링 — development build 전환 후)
