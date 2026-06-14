# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Teleprompter is a remote Claude Code session controller. A native **Swift (SwiftUI)** iOS app connects to a Bun-based Daemon via encrypted relay to control Claude Code sessions with a dual Chat/Terminal UI.

> **전면 네이티브 재작성 진행 중 (2026-06, ADR-0001).** Expo/RN/RN Web 프런트엔드 + EAS 클라우드 빌드를 **전면 제거**하고, 앱은 Swift(SwiftUI) 네이티브로, 공유 코어는 Rust(`tp-core`, UniFFI 순수함수)로 재작성한다. 빌드/검증은 **로컬 iOS Simulator 하니스**(`ios/scripts/ios.sh` + XcodeGen `ios/project.yml`)가 담당한다 (EAS 클라우드 빌드 대체). SoT = `docs/adr/0001-full-native-rewrite-swift-rust.md`. 백엔드(daemon/relay/runner)와 CLI 는 **현행 Bun/TypeScript 구현을 레퍼런스로 유지** (Rust 이관은 후순위 Phase). 아래 wire(framed JSON)·relay ciphertext-only·daemon=relay 유일 클라이언트 불변식은 재작성 후에도 보존된다.

## Tech Stack

- **App (iOS)**: Swift + SwiftUI. iOS Simulator 우선. 빌드/검증 = 로컬 하니스 (`xcodebuild` + `xcrun simctl`, `ios/scripts/ios.sh`). EAS 미사용.
- **Shared core**: Rust (`tp-core`) — wire codec + E2EE crypto + pairing + Envelope. Swift 에 UniFFI FFI(순수 함수만)로 노출. (Phase 2, 미구현)
- **Backend / CLI**: TypeScript on Bun v1.3.13+ (Runner, Daemon, Relay, CLI). 현행 구현 = 동작 레퍼런스 + dogfood 파이프라인. Turborepo + pnpm 모노레포.
- **Encryption**: X25519 + XChaCha20-Poly1305 (libsodium on Bun). 재작성 후 `tp-core` 가 byte-exact 재현.
- **Voice**: OpenAI Realtime API

## Monorepo Layout

```
ios/           # Swift (SwiftUI) iOS app — project.yml (XcodeGen SoT), Sources/, Tests/, scripts/ios.sh (local Simulator harness)
apps/
  cli/         # @teleprompter/cli — unified `tp` binary (subcommand router)
packages/
  daemon/      # @teleprompter/daemon — Bun long-running service (session mgmt, vault, E2EE, worktree)
  runner/      # @teleprompter/runner — Bun per-session process (PTY via Bun.spawn terminal, hooks collection)
  relay/       # @teleprompter/relay — Bun WebSocket ciphertext-only relay server
  protocol/    # @teleprompter/protocol — shared types, framed JSON codec, envelope types (Rust tp-core port reference)
  tsconfig/    # Shared TS configs (base.json, bun.json)
scripts/
  build.ts     # Multi-platform `bun build --compile` script (tp binary)
  install.sh   # curl-pipe-sh installer for GitHub Releases (macOS/Linux)
```

## Architecture

- **Runner** spawns Claude Code in a PTY (`PtyBun` via `Bun.spawn({ terminal })`), collects io streams and hooks events, sends Records to Daemon via IPC (Unix domain socket)
- **Daemon** is a long-running mux that (a) spawns and supervises one Runner per session, (b) manages git worktrees (`git worktree add/remove/list`), (c) stores Records in Store (append-only per session, with session delete/prune support), (d) persists pairings in store DB for auto-reconnect, (e) encrypts with libsodium per-frontend keys, (f) holds the **only** outbound WebSocket client to the Relay(s), and (g) handles pair-ops IPC (`pair.remove` / `pair.rename`) from the CLI so the CLI never opens its own RelayClient
- **Relay** is a stateless ciphertext forwarder — holds only recent 10 encrypted frames per session
- **App (Swift)** decrypts and renders: Terminal tab + Chat tab (hooks events only — PTY io records go exclusively to the Terminal tab). 현재는 Phase 0 부트마커 셸 단계 — pairing/chat/terminal parity 는 Phase 3 (ADR-0001).
- Data flow: Runner → Daemon → Relay → App (and reverse for input)

## Architecture Invariants (절대 위반 금지)

These are non-negotiable rules. **If code contradicts these, the code is wrong (legacy) — fix the code, not the docs.**

- **Frontend ↔ Daemon 통신은 항상 relay 경유.** Direct WS connection from frontend to daemon does not exist. Any `ws://localhost:*` code path from frontend is legacy and must be removed.
- **Daemon은 WS 서버를 열지 않는다.** Daemon only exposes (a) IPC socket for Runner, (b) outbound WebSocket client to Relay. Any `WsServer`, `startWs()`, `--ws-port` is legacy.
- **Relay는 ciphertext만 전달한다 (zero-trust).** Relay never sees plaintext data. Relay is stateless — it does not track clients beyond the 10-frame cache.
- **Daemon은 frontend를 인식하지 않는다.** No client registry on daemon. Frontend identity exists only via `frontendId` in relay protocol v2.
- **Pairing은 relay URL을 daemon에서 결정한다.** Frontend does not configure relay URL independently; it reads relay URL from the pairing bundle (QR/JSON).
- **Daemon은 relay의 유일한 클라이언트다.** CLI는 직접 relay WebSocket을 열지 않는다. 페어링은 CLI → daemon (IPC) → relay 경로로만 흐른다.

**Reading discipline:** When the codebase contradicts the documented architecture, assume the docs are correct and the code has unreverted legacy. Never infer architecture from code — read CLAUDE.md / ARCHITECTURE.md / PRD.md first, then read code to understand the current implementation state.

## Relay Capacity Target

**Always design and tune for ~10k concurrent connections (daemon + app combined) on a single relay node.** 모든 relay 변경은 이 capacity bar 를 보존해야 한다. Single-node knobs (env 표), capacity invariants (2-layer rate limit, slow-consumer disconnect, idle close, /metrics SoT), scale-out 전략은 `.claude/rules/relay-capacity.md` (`packages/relay/**` 작업 시 자동 로드).

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

### Relay Protocol v2 (요약)

메시지: `relay.register` (daemon self-register, proof-based) · `relay.auth` (token + `frontendId`) · `relay.auth.resume` (HMAC token fast-path reconnect, relay 재시작 생존) · `relay.kx` / `relay.kx.frame` (in-band pubkey exchange, kxKey 암호화) · `relay.pub` / `relay.frame` (E2EE data, `frontendId` N:N 라우팅) · `relay.presence` (daemon online/offline) · `control.unpair` / `control.rename` (`__control__` sid E2EE control — daemon RelayClient 발신, CLI는 `pair.remove`/`pair.rename` IPC 위임).

Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`.

각 메시지의 wire 상세 (resume token 동작, `control.rename` Label tagged-union + cross-version compat/version-gating, `decodeWireLabel`/`decodeKxLabelOrKeep`) 는 `.claude/rules/protocol.md` (SoT, `packages/protocol/**` 작업 시 자동 로드).

## Key Design Decisions

- Chat UI is **hooks-only** (PTY-to-chat fallback removed in PR #457): hooks events render as structured message cards; the Stop event's `last_assistant_message` is the canonical response. PTY io records go exclusively to the Terminal tab.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID. Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged in-band via `relay.kx` (encrypted with kxKey derived from pairing secret). Both sides perform ECDH (X25519 `crypto_kx`) → per-frontend session keys → XChaCha20-Poly1305 encryption. Relay token is self-registered via `relay.register` (proof-based, no pre-registration needed). N:N supported — one app connects to multiple daemons, one daemon serves multiple frontends, each with independent E2EE keys identified by `frontendId`.
- Platform priority: iOS (Simulator 우선). Web/Android 는 재작성 이후 강등 (ADR-0001).
- Deployment: `bun build --compile` for `tp` binary (subcommands: daemon, run, relay).
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.
- **Windows is unsupported natively.** `tp` exits at startup on `process.platform === "win32"` with a message pointing to WSL. Run inside WSL (Ubuntu/Debian) and install the Linux build.
- Pairing is completion-gated: `tp pair new` blocks until the frontend completes ECDH kx. Pending pairings live in daemon memory only; store DB holds completed pairings. `pairing.json`은 더 이상 존재하지 않는다. CLI는 daemon이 떠있지 않으면 자동으로 시작하며 (`ensureDaemon()`), pair lock (`proper-lockfile` on `pair.lock`)으로 동시 `tp pair new` 실행을 막는다.

## Coding Conventions (Summary)

- TypeScript (backend/CLI): Files kebab-case. Types: PascalCase. No default exports. Import: `@teleprompter/protocol`. Type-only: `import type { ... }`. Import sort: Biome 위임.
- Tests: `bun:test`, 소스 옆 co-located. Biome = lint + format (ESLint/Prettier 금지).
- Swift (`ios/`): SwiftUI. 컨벤션은 재작성 진행에 따라 `ios/README.md` + 별도 rule 로 정착 예정.
- 영역별 상세 컨벤션은 `.claude/rules/`에서 자동 로드됨.

## Subagent Dispatch

Agent 호출 시 항상 `model` 명시. plugin agent 는
frontmatter가 `model: inherit`이라 미명시 시 부모 Opus 상속.

- **탐색/grep/짧은 요약**: `model: "haiku"` (e.g., `Explore`, file lookups)
- **코드 작업/리뷰/구현**: `model: "sonnet"` (e.g., plugin review agents,
  `general-purpose`)
- **어려운 설계/추론만 opus**: 명확히 필요할 때만
- **QA**: 백엔드 회귀(`bun test`) = `haiku`. 앱 검증은 로컬 Swift Simulator 하니스
  (`ios/scripts/ios.sh build|smoke|test`)로 수행 — RN Web/Playwright/Maestro/expo-mcp QA 는
  재작성으로 제거됨.

**워크플로우/서브에이전트 BRIEF 에 *미검증 과거 서술*을 ground truth 로 박지 말 것.**
commit/PR body·이전 세션 서술은 hearsay — agent 가 HEAD 워킹트리 실파일을 직접 읽어
file:line 으로 재확인하게 시킨다. `"do not re-derive"` 류 재검증 금지 레버 금지 (과거에
stale commit body 를 HEAD 로 오인 + 재검증 금지 → 워크플로우가 올바른 fix 를 오기각).
fix-탐색 워크플로우는 가드가 구조에 박힌 `.claude/workflows/fact-grounded-fix.js`
(`scriptPath` 호출) 를 기본값으로. 상세는 `.claude/rules/workflow-authoring.md`.

## Testing Strategy

- **Backend/CLI (Bun, Tier 1–3)**: `bun:test`. 소스 옆 co-located 유닛/통합 테스트.
- **App (Swift)**: `ios/scripts/ios.sh test` (XCTest on Simulator) + `smoke` (부트마커 검증). 상세는 `ios/README.md`.

### 명령어
```bash
bun test ./packages/protocol ./packages/daemon ./packages/runner ./apps/cli ./packages/relay  # 백엔드 전체
pnpm type-check:all    # 전체 타입 체크 (daemon, cli, relay, runner)
ios/scripts/ios.sh test    # Swift 앱 XCTest (Simulator)
ios/scripts/ios.sh smoke   # Swift 앱 빌드+설치+부트마커 스모크
```

> **macOS 로컬에서는 경로에 반드시 선행 `./` 를 붙인다.** un-rooted 경로(`bun test packages/daemon`)는
> bun filter 모드로 repo 전체를 스캔하며 fd ~11.6k 를 쥐고, spawnSync pipe fd 가 Darwin
> `OPEN_MAX`(10240)를 넘으면 자식 stdout 이 조용히 빈 값이 된다 (worktree-manager 6 fail 의
> 실제 원인). 상세는 `.claude/rules/testing-inventory.md`.

또는 슬래시 커맨드 사용 — 변경 파일 기반 자동 dispatch:
- `/test [auto|protocol|daemon|runner|relay|cli|all]` — 변경 범위 감지 후 실행
- `/deploy-check` — CI와 동일한 로컬 사전 검증

백엔드 test 파일 인벤토리는 `.claude/rules/testing-inventory.md` 참조 — `*.test.ts` / `packages/**` / `apps/cli/**` 파일 작업 시 자동 로드됨.

## Dog-fooding (tp 백엔드 파이프라인)

이 repo 에서 Claude Code 는 **항상 `tp` 로 실행** (`claude ...` 아님) — 모든 세션이 로컬 daemon → relay 파이프라인을 타게 해 백엔드(daemon/relay/runner) 를 매일 dogfood 한다. (RN Web 라이브 UI dogfood 는 Expo 제거로 사라졌다 — Swift 앱이 Phase 3 parity 에 도달하면 Simulator dogfood 로 복귀한다. 그때까지 UI 검증은 `ios/scripts/ios.sh`.)

### Local `tp` Binary Freshness (자동 룰)

**main 에 머지된 내 변경은 즉시 사용자의 로컬 `tp`/daemon 에 반영되어 있어야 한다.** 다음 시점마다 **묻지 말고** 재빌드/재설치:

1. **PR squash merge 직후** — `apps/cli/**`, `packages/{daemon,runner,protocol,relay}/**` 중 하나라도 건드린 PR:
   ```bash
   pnpm build:cli:local                      # 현재 OS/arch 만 (--all 금지)
   install -m 0755 dist/tp ~/.local/bin/tp   # dogfood 경로 (sudo 불필요)
   ~/.local/bin/tp daemon install            # 서비스 재등록 (idempotent, launchd/systemd 자동 재기동)
   ```
2. **로컬 dev 세션 시작 시** — 위 시퀀스 한 번 돌려 PATH `tp` + daemon 을 `origin/main` 최신에 맞춤.
3. **"최신으로 깔아줘" 명시 요청 시** — 확인 없이 실행.

세부:
- **dogfood = `~/.local/bin/tp`, brew(릴리즈) = `/opt/homebrew/bin/tp` 로 분리.** `~/.zprofile` 이 `~/.local/bin` 을 앞에 둬 `tp` 는 dogfood 를 가리킴. **brew symlink 를 `install` 로 절대 덮지 않는다** (덮으면 `brew upgrade` 무력화 — 복구는 `brew link --overwrite tp`). dogfood 끄려면 `rm ~/.local/bin/tp`.
- `daemon install` 은 plist 바이너리 경로를 `which tp` 로 고르므로 **`~/.local/bin/tp` 로 직접 실행**. 새 로그인 셸 전이면 `PATH="$HOME/.local/bin:$PATH" ~/.local/bin/tp daemon install`.
- **재기동은 `tp daemon install` 한 번** (`pkill` 후 수동 재시작 금지 — 서비스 미등록 프로세스로 살아남아 OTA 안 됨). 재기동 후 `tp version` 으로 새 commit hash 확인.
- **Subagent worktree 가 active 인 동안 install 금지** — 모든 subagent 완료 알림 도착 + 메인 worktree `git status` clean 후 한꺼번에. 옛 `/usr/local/bin/tp` 잔재 발견 시 `rm`.

## Documentation Maintenance

CLAUDE.md, PRD.md, TODO.md, ARCHITECTURE.md must always be kept up to date.
When implementing features, fixing bugs, or making architectural changes,
update the relevant documentation files in the same commit. 영역별 상세 운영
규칙은 `.claude/rules/*.md` 에 분리돼 있다 (`paths:` frontmatter 로 해당 영역
파일 작업 시 자동 로드) — 그 영역을 바꾸면 같은 commit 에서 해당 rules 파일도 갱신.

> **CLAUDE.md 는 40k char 한도 아래로 유지.** 장황한 운영 디테일(relay capacity,
> deployment/release, testing inventory)은 CLAUDE.md 에 핵심+포인터만 두고 본문은
> `.claude/rules/` 에 둔다. 한도 근접 시 같은 패턴으로 분리.

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

`tp` 바이너리 release 는 `/release` 슬래시 커맨드가 전 과정을 자동화 (release-please → multi-platform `bun build --compile` → GitHub Release → Homebrew tap). 전체 SoT (main push / v* tag / 수동 dispatch 표, 릴리즈 수동 절차, Infrastructure, GitHub Secrets) 는 `.claude/rules/release-deploy.md`. iOS 앱은 로컬 Simulator 하니스(`ios/scripts/ios.sh`)로 빌드/검증 — EAS 클라우드 빌드는 제거됨.

## CLI Commands

```bash
tp                         # Claude REPL (인자 없이 실행하면 passthrough로 claude 인터랙티브 진입)
tp [flags] [claude args]   # Claude를 tp를 통해 실행 (기본 모드 — 알 수 없는 첫 인자는 passthrough)
tp --help, -h              # tp 자체 도움말 + claude --help 합쳐서 출력
tp --version, -v           # tp 버전 + claude 버전 합쳐서 출력 (= `tp version`)
tp pair [--relay URL] [--label NAME]   # QR 페어링 데이터 생성 (모바일 앱 연결) — 기본적으로 `pair new` 실행
tp pair new [--relay URL] [--label NAME]  # 새 페어링 생성 (QR 출력, label 기본값 = hostname)
tp pair list               # 등록된 페어링 목록 (label + daemon ID 표시)
tp pair rename <id-prefix> <label...>  # 페어링 label 변경 (peer 알림)
tp pair delete <id> [-y]   # 페어링 삭제 (daemon-id prefix 허용)
tp session list            # 저장된 세션 목록 (running + stopped, cwd/updated 컬럼)
tp session delete <sid> [-y]           # 세션 삭제 (sid prefix 허용, running 이면 Runner kill 후 삭제)
tp session cleanup [-y] [--all]        # 대화형 multi-select 일괄 삭제 (stopped 세션만, TTY 필수)
  --all                         # 모든 stopped 세션 미리 선택 (Enter로 확인)
  -y, --yes                     # 선택 후 confirmation 생략
tp session prune [options] # stopped 세션 일괄 삭제 (non-interactive)
  --older-than <Nd|Nh|Nm|Ns>   # 나이 컷오프 (기본 7d)
  --all                         # 모든 stopped 세션 (older-than 무시)
  --running                     # running 도 포함 (위험 — 2중 confirmation)
  --dry-run                     # 삭제 대상만 출력
  -y, --yes                     # confirmation 생략
tp status                  # 세션 & daemon 상태 확인 (자동 시작)
tp logs [session]          # 세션 라이브 출력 tail
tp doctor                  # 환경 진단 + relay 연결 + E2EE 검증, 끝에서 `claude doctor` 도 실행
tp upgrade                 # tp 바이너리 업그레이드 후 `claude update` 도 실행
tp version                 # tp + claude 버전 출력
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
tp daemon stop             # 실행 중인 daemon 정지
tp daemon status           # daemon 실행 상태 확인
tp daemon install          # OS 서비스 등록 (macOS: launchd, Linux: systemd)
tp daemon uninstall        # OS 서비스 해제

# 고급
tp relay start [--port]    # Relay 서버 실행
tp completions <bash|zsh|fish>              # 셸 자동완성 스크립트 출력
tp completions install [shell]              # 현재 쉘에 완성 자동 등록 (--force, --dry-run)
tp completions uninstall [shell]            # 설치된 완성 제거

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
| `NO_COMPLETIONS=1` | env | `install.sh`에서 completion 설치 건너뜀 |
| `--no-completions` | flag | `install.sh` 로컬 직접 실행 시 opt-out (`curl \| bash` 불가) |
| `TP_AUTO_COMPLETIONS=1` | env | `install.sh` non-TTY(`curl \| bash`) 환경에서 강제 설치 활성화 |

`install.sh`는 non-TTY 환경(`curl | bash`)에서 기본적으로 completion 설치를 건너뜀.

Fish는 완성 스크립트를 디스크에 기록하므로 `tp upgrade` 후 `tp completions install fish --force` 를 재실행해야 최신 상태로 갱신됨.

> **주의:** `tp completions install` 중에 rc/Profile 파일을 동시에 수정하면 동시 편집 내용이 덮어쓰일 수 있음 (TOCTOU). 완성 설치 중에는 해당 파일 편집 회피 권장.

## Version Management

- **NEVER bump versions** (package.json, manifest) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x). 0.1.0 은 App Store 공개 release 용으로 예약.
- release-please 가 Conventional Commits 로 자동 bump (`bump-patch-for-minor-pre-major` → pre-1.0 에서 `feat:` 도 patch). `version` 필드 수동 편집 금지.

릴리즈 설정·운영규칙·안티패턴은 `.claude/rules/release-deploy.md` (SoT).

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.

## iOS / Native Build

**iOS 앱 빌드/검증은 로컬 Simulator 하니스가 담당한다 (EAS 클라우드 제거).** XcodeGen `ios/project.yml` 이 프로젝트 SoT (`.xcodeproj` 는 생성물, gitignore). 하니스 = `ios/scripts/ios.sh`:

```bash
ios/scripts/ios.sh gen      # xcodegen generate (.xcodeproj 재생성)
ios/scripts/ios.sh boot     # Simulator 부팅 (TP_SIM, default "iPhone 17 Pro")
ios/scripts/ios.sh build    # xcodebuild (Debug-iphonesimulator)
ios/scripts/ios.sh run      # install + launch
ios/scripts/ios.sh smoke    # build + install + launch + 부트마커(TP_BOOT_OK) 검증
ios/scripts/ios.sh test     # XCTest on Simulator
```

부트마커는 `os.Logger(subsystem: "dev.tpmt.teleprompter", category: "boot")` 로 emit, 하니스가 Simulator unified log 를 `--predicate "subsystem == ..."` 로 grep 검증. 상세는 `ios/README.md`. 실기기/TestFlight 배포는 재작성 진행에 따라 별도 정착.