# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

> **What this is (read first).** Teleprompter is a **user-owned, self-hosted developer tool** — the same category as VS Code Remote, `tmux` over SSH, or `mosh`. The developer runs the daemon on **their own** machine and pairs **their own** phone to view and drive **their own** Claude Code sessions. There is exactly one consenting operator, no third party, and no target other than the operator's own dev box. The end-to-end encryption exists so a hosted relay hop cannot read the operator's private session traffic — the same privacy property Signal or WireGuard provide — **not** to evade inspection. The test harness automates the operator's own dev workflow in a throwaway sandbox; where it answers a first-run prompt or reuses the operator's own login token, that is ordinary unattended-CI plumbing, never credential theft or a safety bypass.

Teleprompter lets a developer view and drive **their own** Claude Code sessions from **their own** phone. A native **Swift (SwiftUI)** app pairs device-to-device (end-to-end encrypted) with a Rust daemon the developer runs on their own machine, and presents a dual Chat/Terminal UI — comparable to VS Code Remote scoped to a single operator.

> **전면 네이티브 재작성 진행 중 (2026-06, ADR-0001).** Expo/RN/RN Web 프런트엔드 + EAS 클라우드 빌드를 **전면 제거**하고, 앱은 Swift(SwiftUI) 네이티브로, 공유 코어는 Rust(`tp-core`, UniFFI 순수함수)로 재작성한다. **앱은 단일 멀티플랫폼 SwiftUI 타깃** — iOS/iPadOS/네이티브 macOS(Catalyst 아님)가 현재 출하 범위(Phase A), visionOS + watchOS(제한 경험)는 Rust toolchain 게이트 뒤 Phase B (ADR-0002). 빌드/검증은 **로컬 Apple 하니스**(`scripts/ios.sh`, `TP_PLATFORM=ios|macos|visionos|watchos` + XcodeGen `ios/project.yml`)가 담당한다 (EAS 클라우드 빌드 대체). SoT = `docs/adr/0001-full-native-rewrite-swift-rust.md` + **플랫폼 범위 `docs/adr/0002-multiplatform-apple-expansion.md`**. 백엔드(daemon/relay/runner)와 CLI 는 **Rust 이관 완료** — #5 zero-Bun cascade PR6 에서 Bun/TS 소스를 삭제해 Rust 워크스페이스가 유일 구현이다. 아래 wire(framed JSON)·relay 는 암호화된 프레임만 중계(평문 미접근)·daemon=relay 유일 클라이언트 불변식은 재작성 후에도 보존된다.

## Tech Stack

- **App (Apple multiplatform)**: Swift + SwiftUI, 단일 멀티플랫폼 타깃 + **별도 `TeleprompterWatch` 타깃(B3 ✅)**. 현재 출하 = iOS Simulator / iPadOS / 네이티브 macOS (Phase A) + **visionOS Simulator (B2 ✅)** + **watchOS Simulator 제한 경험 (B3 ✅)**. 빌드/검증 = 로컬 하니스 (`xcodebuild` + `xcrun simctl`(iOS/visionOS/watchOS) / `open` + 호스트 unified log(macOS), `scripts/ios.sh` + `TP_PLATFORM`). EAS 미사용.
- **Shared core**: Rust (`rust/tp-core`) — wire codec + E2EE crypto(AEAD/KDF/crypto_kx/ratchet) + pairing. Swift 에 UniFFI FFI(순수 함수만)로 노출, TS 구현과 byte-exact (골든벡터 교차검증). xcframework = `rust/build-xcframework.sh` (= `scripts/ios.sh rust`). 상세 = `rust/README.md`. **(Phase 2 ✅ 구현 + Simulator 검증 완료)**
- **Backend / CLI**: Rust (`rust/` workspace — `tp-cli`, `tp-daemon`, `tp-runner`, `tp-relay`, `tp-proto`, `tp-core`). #5 zero-Bun cascade PR6 에서 Bun/TS 백엔드 소스(`packages/*`, `apps/cli`)와 `tpd` blob 을 삭제 — Rust 가 유일 구현이다. wire/E2EE byte-exactness 는 TS 시절 골든벡터(`wire_vectors.rs`/`message_vectors.rs`)가 잠근다.
- **Encryption**: X25519 + XChaCha20-Poly1305 (`tp-core` 순수 Rust crate, 골든벡터 검증 완료).
- **Voice**: selectable backend — **on-device (offline)** [SFSpeechRecognizer STT + Foundation Models refine/summarize (iOS 26+, availability-gated, raw-transcript fallback) + AVSpeechSynthesizer TTS, no API key] **or OpenAI Realtime API** [key required]. Settings toggle (Auto / On-device / OpenAI Realtime); default on-device when no key. Both backends drive one `VoiceConnectionStatus` state machine via the `VoiceBackend` protocol seam (`ios/Sources/Voice/`).

## Architecture

- **Runner** (`tp-runner`) spawns Claude Code in a PTY (portable-pty), collects io streams and hooks events, sends Records to Daemon via IPC (Unix domain socket)
- **Daemon** is a long-running mux that (a) spawns and supervises one Runner per session, (b) manages git worktrees (`git worktree add/remove/list`), (c) stores Records in Store (append-only per session, with session delete/prune support), (d) persists pairings in store DB for auto-reconnect, (e) encrypts with libsodium per-frontend keys, (f) reaches the relay as an outbound WebSocket **client** (the daemon never listens for inbound connections, so the operator doesn't have to open a port or expose their dev box to the internet — the same reason a laptop dials out to a chat server instead of hosting one), and (g) handles pair-ops IPC (`pair.remove` / `pair.rename`) from the CLI so the CLI never opens its own RelayClient
- **Relay** is a stateless forwarder of already-encrypted frames — it keeps only a small 10-frame reconnect buffer per session
- **App (Swift)** decrypts and renders: Terminal tab + Chat tab (hooks events only — PTY io records go exclusively to the Terminal tab). 현재는 Phase 0 부트마커 셸 단계 — pairing/chat/terminal parity 는 Phase 3 (ADR-0001).
- Data flow: Runner → Daemon → Relay → App (and reverse for input)

## Architecture Invariants (절대 위반 금지)

These are non-negotiable rules. **If code contradicts these, the code is wrong (legacy) — fix the code, not the docs.**

- **Frontend ↔ Daemon 통신은 항상 relay 경유.** Direct WS connection from frontend to daemon does not exist. Any `ws://localhost:*` code path from frontend is legacy and must be removed.
- **Daemon은 WS 서버를 열지 않는다.** Daemon only exposes (a) IPC socket for Runner, (b) outbound WebSocket client to Relay — so no inbound port and no internet exposure of the operator's machine. Any `WsServer`, `startWs()`, `--ws-port` is legacy.
- **Relay는 이미 암호화된 프레임만 전달한다.** The relay is an untrusted hosted hop, so by design it has no access to the operator's plaintext — a standard end-to-end-encryption privacy property (as in Signal or WireGuard). It is stateless and does not track clients beyond the 10-frame reconnect buffer.
- **Daemon은 frontend를 인식하지 않는다.** No client registry on daemon. Frontend identity exists only via `frontendId` in relay protocol v2.
- **Pairing은 relay URL을 daemon에서 결정한다.** Frontend does not configure relay URL independently; it reads relay URL from the pairing bundle (QR/JSON).
- **Daemon은 relay의 유일한 클라이언트다.** CLI는 직접 relay WebSocket을 열지 않는다. 페어링은 CLI → daemon (IPC) → relay 경로로만 흐른다.

**Reading discipline:** When the codebase contradicts the documented architecture, assume the docs are correct and the code has unreverted legacy. Never infer architecture from code — read CLAUDE.md / ARCHITECTURE.md / PRD.md first, then read code to understand the current implementation state.

## Relay Capacity Target

**Always design and tune for ~10k concurrent connections (daemon + app combined) on a single relay node.** 모든 relay 변경은 이 capacity bar 를 보존해야 한다. Single-node knobs (env 표), capacity invariants (2-layer rate limit, slow-consumer disconnect, idle close, /metrics SoT), scale-out 전략은 `.claude/rules/relay-capacity.md` (`rust/tp-relay/**` 작업 시 자동 로드).

## Protocol

All components use the same framed JSON protocol: `u32_be length` + `utf-8 JSON payload`. The Envelope type has fields: `t` (frame type), `sid`, `seq`, `k` (io|event|meta), `ns`, `n`, `d`, `c`, `ts`, `e`, `m`.

### Relay Protocol v2 (요약)

메시지: `relay.register` (daemon self-register, proof-based) · `relay.auth` (token + `frontendId`) · `relay.auth.resume` (HMAC token fast-path reconnect, relay 재시작 생존) · `relay.kx` / `relay.kx.frame` (in-band pubkey exchange, kxKey 암호화) · `relay.pub` / `relay.frame` (E2EE data, `frontendId` N:N 라우팅) · `relay.presence` (daemon online/offline) · `control.unpair` / `control.rename` (`__control__` sid E2EE control — daemon RelayClient 발신, CLI는 `pair.remove`/`pair.rename` IPC 위임).

Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`.

각 메시지의 wire 상세 (resume token 동작, `control.rename` Label tagged-union + cross-version compat/version-gating, `decodeWireLabel`/`decodeKxLabelOrKeep`) 는 `.claude/rules/protocol.md` (SoT, `rust/tp-proto/**`/`rust/tp-core/**` 작업 시 자동 로드).

## Key Design Decisions

- Chat UI is **hooks-only** (PTY-to-chat fallback removed in PR #457): hooks events render as structured message cards; the Stop event's `last_assistant_message` is the canonical response. PTY io records go exclusively to the Terminal tab.
- Worktree management is done directly by Daemon (`git worktree add/remove/list`), no external tool dependency. N:1 relationship — multiple sessions per worktree allowed.
- E2EE pairing via QR code containing pairing secret + daemon pubkey + relay URL + daemon ID (+ **QR v4**: random-UUID `pairingId` + `hostname`). Daemon pubkey is delivered offline via QR; Frontend pubkey is exchanged in-band via `relay.kx` (encrypted with kxKey derived from pairing secret). Both sides perform ECDH (X25519 `crypto_kx`) → per-frontend session keys → XChaCha20-Poly1305 encryption. Relay token is self-registered via `relay.register` (proof-based, no pre-registration needed). N:N supported — one app connects to multiple daemons, one daemon serves multiple frontends, each with independent E2EE keys identified by `frontendId`.
- **Pairing confirmation (PCT) — WS v3 (#49)**: because `relay.kx` has no freshness binding (a hostile relay could replay a cached kx broadcast), the daemon carries a per-frontend **Pairing Confirmation Tag** (domain-separated BLAKE2b over the established session keys, `tp-core` byte-exact) on the `hello` frame. The app compares it against its own PCT and drives the §1.3 promotion table: `pct` match → confirmed commit; `pct` mismatch → FAILED; `pct` absent with `effectiveV = max(kx-advertised v, persisted minAdvertisedV floor) < 3` → legacy commit; absent with `effectiveV ≥ 3` → FAILED (downgrade). `WS_PROTOCOL_VERSION` (advertised by both sides in the kx payload `v`) is **3** for PCT/QR-v4. No hard handshake gate — `pct` is additive-optional (old apps ignore it, old daemons omit it), so the promotion table (`effectiveV` + floor) is the sole discriminator. Device-local: PCT/floor/`frontendId`/label/`localHidden` are never synced. SoT = `docs/design/pairing-redesign-local-ecdh-commit-v3.md`.
- Platform priority: Apple 멀티플랫폼 — iOS/iPadOS/네이티브 macOS 완전 경험 (Phase A, 출하), visionOS 완전 + watchOS 제한 경험은 toolchain 게이트 뒤 Phase B (ADR-0002). Web/Android 는 재작성 이후 강등 (ADR-0001 §6 확장 경로 유지).
- Deployment: `scripts/build-bundle.sh` 가 cargo release 빌드 4종(`tp`/`tp-daemon`/`tp-runner`/`tp-relay`)을 `tp-<suffix>.tar.gz` 번들로 조립 (release.yml + 로컬 dry-run 공용).
- Passthrough mode: `tp <claude args>` runs claude directly through tp pipeline. `--tp-*` flags are consumed by tp, rest forwarded to claude.
- **Windows is unsupported natively.** `tp` is POSIX-only (`#[cfg(unix)]` exec paths; non-unix builds print a WSL pointer). Run inside WSL (Ubuntu/Debian) and install the Linux build.
- Pairing is completion-gated: `tp pair new` blocks until the frontend completes ECDH kx. Pending pairings live in daemon memory only; store DB holds completed pairings. `pairing.json`은 더 이상 존재하지 않는다. CLI는 daemon이 떠있지 않으면 자동으로 시작하며 (`ensureDaemon()`), pair lock (`proper-lockfile` on `pair.lock`)으로 동시 `tp pair new` 실행을 막는다.

## Coding Conventions (Summary)

- Rust (backend/CLI, `rust/`): rustfmt (edition 2021, max_width 100) + clippy — 심각도는 `rust/Cargo.toml` `[workspace.lints]` 가 SoT (`clippy::all=deny`, pedantic=warn; `-- -D warnings` 절대 금지). `unsafe_code = "forbid"`. Tests: `#[cfg(test)]` 소스 옆 co-located.
- Swift (`ios/`): SwiftUI. 컨벤션은 재작성 진행에 따라 `ios/README.md` + 별도 rule 로 정착 예정.
- 영역별 상세 컨벤션은 `.claude/rules/`에서 자동 로드됨.

## Subagent Dispatch

Agent 호출 시 항상 `model` 명시. plugin agent 는
frontmatter가 `model: inherit`이라 미명시 시 부모 Opus 상속.

- **탐색/grep/짧은 요약**: `model: "haiku"` (e.g., `Explore`, file lookups)
- **코드 작업/리뷰/구현**: `model: "sonnet"` (e.g., plugin review agents,
  `general-purpose`)
- **어려운 설계/추론만 opus**: 명확히 필요할 때만
- **QA**: 백엔드 회귀(`cargo test --workspace`) = `haiku`. 앱 검증은 로컬 Swift 하니스
  (`scripts/ios.sh build|smoke|test`, `TP_PLATFORM=ios|macos|visionos|watchos`)로 수행 — macOS-native smoke 는
  sim 부팅 없는 빠른 회귀 경로. RN Web/Playwright/Maestro/expo-mcp QA 는 재작성으로 제거됨.

**워크플로우/서브에이전트 BRIEF 에 *미검증 과거 서술*을 ground truth 로 박지 말 것.**
commit/PR body·이전 세션 서술은 hearsay — agent 가 HEAD 워킹트리 실파일을 직접 읽어
file:line 으로 재확인하게 시킨다. `"do not re-derive"` 류 재검증 금지 레버 금지 (과거에
stale commit body 를 HEAD 로 오인 + 재검증 금지 → 워크플로우가 올바른 fix 를 오기각).
fix-탐색 워크플로우는 가드가 구조에 박힌 `.claude/workflows/fact-grounded-fix.js`
(`scriptPath` 호출) 를 기본값으로. 상세는 `.claude/rules/workflow-authoring.md`.

## Testing Strategy

- **Backend/CLI (Rust)**: `cargo test --workspace` — 소스 옆 co-located `#[cfg(test)]` 유닛 + TS-era 골든벡터(`wire_vectors.rs`/`message_vectors.rs`, byte-exactness 잠금). 상세는 `rust/README.md`.
- **App (Swift, multiplatform)**: `scripts/ios.sh test` (XCTest) + `smoke` (iOS/macOS/visionOS 8마커, watchOS 7마커) + `uitest`/`uitest-all` (XCUITest UI E2E — 단일/전 플랫폼 PASS/SKIP/FAIL 매트릭스, watchOS 자동 SKIP, 로컬 전용), `TP_PLATFORM=ios`(기본, Simulator) / `TP_PLATFORM=macos`(네이티브, 호스트 로그) / `TP_PLATFORM=visionos`(xrOS Sim) / `TP_PLATFORM=watchos`(watchOS Sim, B3 ✅). 상세는 `ios/README.md`.

### 명령어
```bash
( cd rust && cargo test --workspace )  # 백엔드 전체 (호스트; rustup shim PATH 주의 — rust/README.md)
( cd rust && cargo clippy --workspace --all-targets && cargo fmt --all -- --check )  # 린트 (CI 와 동일 게이트)
scripts/ios.sh test    # Swift 앱 XCTest (Simulator; tp-core FFI 포함)
scripts/ios.sh smoke   # Swift 앱 빌드+설치+8마커 스모크 (TP_PLATFORM=ios 기본)
TP_PLATFORM=macos scripts/ios.sh smoke   # 네이티브 macOS 스모크 (sim 없는 빠른 회귀 경로)
TP_PLATFORM=watchos scripts/ios.sh smoke  # watchOS Simulator 7마커 스모크 (B3 ✅, TP_INPUT_OK 제외)
```

## Dog-fooding (tp 백엔드 파이프라인)

이 repo 에서 Claude Code 는 **항상 `tp` 로 실행** (`claude ...` 아님) — 모든 세션이 로컬 daemon → relay 파이프라인을 타게 해 백엔드(daemon/relay/runner) 를 매일 dogfood 한다. (RN Web 라이브 UI dogfood 는 Expo 제거로 사라졌다 — Swift 앱은 `scripts/ios.sh` 하니스(`TP_PLATFORM=ios|macos|visionos|watchos`)의 smoke + XCTest 로 검증한다. 인터랙티브 UI dogfood 복귀는 후속.)

### Local `tp` Binary Freshness (자동 룰)

**main 에 머지된 내 변경은 즉시 로컬 `tp`/daemon 에 반영돼 있어야 한다.** 절차는 `dogfood-refresh` skill 이 SoT — 다음 시점마다 **묻지 말고** 실행:
1. **PR squash merge 직후** — `rust/tp-cli/**`, `rust/tp-daemon/**`, `rust/tp-runner/**`, `rust/tp-relay/**`, `rust/tp-proto/**`, `rust/tp-core/**` 중 하나라도 건드린 PR.
2. **로컬 dev 세션 시작 시** — PATH `tp`/daemon 을 최신에 맞춤.
3. **"최신으로 깔아줘" 요청 시** — 확인 없이.

**안전 규칙 (위반 금지):**
- rustup shim 이 cargo 인자 mis-parse — real toolchain bin(`rustup which cargo` dirname) 을 PATH 우선.
- `libexec/tp/{tp-daemon,tp-runner,tp-relay}` 필수 — 빠지면 `bundled tp-daemon not found` 로 daemon 미기동/세션 스폰 실패.
- **`bin/tp`+`libexec/tp/*` 전부 adhoc 재서명** — 일부만 하면 parent/child 불일치로 AMFI 가 exec(`tp-daemon`/`tp-runner`) 를 SIGKILL(exit 137).
- `daemon install` 은 plist 경로를 `which tp` 로 고름 — 반드시 **`~/.local/bin/tp daemon install`** 로 실행.
- **재기동은 `tp daemon install` 한 번** — `pkill` 후 수동 재시작 금지 (서비스 미등록 프로세스로 살아남아 OTA 안 됨).
- **brew symlink(`/opt/homebrew/bin/tp`) 절대 덮지 않는다** — dogfood 는 `~/.local/bin/tp` 만 (복구 = `brew link --overwrite tp`).
- **subagent worktree active 중 install 금지** — 전부 완료 + 메인 worktree clean 후 한꺼번에.

전체 절차는 `.claude/skills/dogfood-refresh/SKILL.md`.

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

## Deployment Pipeline

`tp` 바이너리 release 는 `/release` 슬래시 커맨드가 전 과정을 자동화 (release-please → `scripts/build-bundle.sh` multi-platform Rust 번들 → GitHub Release → Homebrew tap). 전체 SoT (main push / v* tag / 수동 dispatch 표, 릴리즈 수동 절차, Infrastructure, GitHub Secrets) 는 `.claude/rules/release-deploy.md`. Apple 멀티플랫폼 앱(iOS/iPadOS/macOS/visionOS/watchOS)은 로컬 하니스(`scripts/ios.sh`, `TP_PLATFORM=ios|macos|visionos|watchos`)로 빌드/검증 — EAS 클라우드 빌드는 제거됨.

## CLI Commands

`tp` 서브커맨드/플래그 전체 목록은 `tp --help` / `tp <sub> --help` 와 `rust/tp-cli/src/main.rs` clap 정의가 SoT — 여기 중복하지 않는다. `--help` 로 드러나지 **않는** 것만 기록:

- **맨 `tp pair` 는 `tp pair new` 로 라우팅된다** (`rust/tp-cli/src/main.rs:429-432`) — `tp pair --help` 출력에는 안 나온다.
- **`session cleanup` 은 TTY 필수** (대화형 multi-select). non-interactive 일괄 삭제는 `session prune` (`--older-than` 기본 7d). `session delete` 는 running 세션이면 Runner 를 kill 한 뒤 삭제한다.
- **daemon-up 게이팅**: `pair new/delete/rename` 과 `session delete/prune/cleanup` 은 daemon 이 떠 있지 않으면 진행을 거부한다 — store 직접 write fallback 없음 (ADR-0003 A2.4, `rust/tp-cli/src/commands/{pair,session}.rs`).
- 알 수 없는 첫 인자는 daemon+runner 파이프라인을 타는 **passthrough** 로 가고, `auth`/`mcp`/`install`/`update`/`agents`/`auto-mode`/`plugin`/`plugins`/`setup-token` 과 **`tp -- <claude args>`** 는 daemon 을 우회해 claude 로 직접 exec 된다 (`Route::ForwardClaude` — passthrough 아님). 목록은 `forward.rs:79-89`, 라우팅 결정은 `decide_route()` (`forward.rs:111-165`).
- **`--tp-sid <id>` / `--tp-cwd <path>`** (passthrough 전용 — 세션 ID / 작업 디렉토리)는 clap 에 등록되지 않고 pre-clap 커스텀 파서(`rust/tp-cli/src/commands/passthrough_split.rs:18`)가 처리한다 — 그래서 `tp --help` 에 **안 뜬다**.
- 조합 출력은 `version`/`doctor`/`upgrade` 세 개뿐 — 각각 끝에서 `claude --version`/`claude doctor`/`claude update` 를 이어 실행한다. **`--help` 는 조합되지 않는다** (Bun CLI 시절 동작, Rust 포팅에서 미이관).

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

- **NEVER bump versions** (`version.txt`, manifest) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x). 0.1.0 은 App Store 공개 release 용으로 예약.
- release-please 가 Conventional Commits 로 자동 bump (`bump-patch-for-minor-pre-major` → pre-1.0 에서 `feat:` 도 patch). `version` 필드 수동 편집 금지.
- **앱 MARKETING_VERSION 은 0.1.20 고정 (사용자 명시 정책, 2026-07-25)** — iOS/iPadOS/macOS/visionOS + 임베드 watch 전부 (`ios/project.yml` settings.base 단일 지점). TestFlight 는 이 고정 버전에 빌드 번호(`TP_BUILD_NUMBER`)만 run 마다 증가시켜 출하. **사용자가 명시적으로 지시할 때만 변경.** CLI 버전(`version.txt`)과는 독립.

릴리즈 설정·운영규칙·안티패턴은 `.claude/rules/release-deploy.md` (SoT).

## Language

PRD and internal docs are written in Korean. Code, comments, and commit messages should be in English.

## Native App Build (Multiplatform)

**Apple 멀티플랫폼 앱(iOS/iPadOS/macOS/visionOS + watchOS 별도 타깃) 빌드/검증은 로컬 하니스가 담당한다 (EAS 클라우드 제거).** XcodeGen `ios/project.yml` 이 프로젝트 SoT — 멀티플랫폼 타깃 `platform: auto` + `supportedDestinations: [iOS, macOS, visionOS]` + 별도 `TeleprompterWatch` 타깃(`platform: watchOS`, B3 ✅) (`.xcodeproj` 는 생성물, gitignore; 디렉터리명은 `ios/` 유지, ADR-0002). **watch 는 메인 iOS 앱의 companion 으로 임베드 배포**(`Teleprompter` 타깃의 `- target: TeleprompterWatch / embed: true / destinationFilters: [iOS]` 의존성 — iOS 목적지로만 스코프, macOS/visionOS 슬라이스 미임베드)되, `WKRunsIndependentlyOfCompanionApp: YES` 로 standalone 구동 유지 (companion DISTRIBUTION + standalone RUNTIME, #123/ADR-0004 Amdt 2). 번들 ID = `dev.tpmt.app`(메인) + `dev.tpmt.app.watchkitapp`(watch). 하니스 = `scripts/ios.sh` (`TP_PLATFORM=ios` 기본 / `macos` / `visionos` / `watchos`):

```bash
scripts/ios.sh rust     # TpCore.xcframework (7 슬라이스: ios-arm64/ios-sim-fat/macos-fat/xros-arm64/xros-sim/watchos-arm64+arm64_32-fat/watchos-sim) + UniFFI 바인딩
scripts/ios.sh gen      # xcodegen generate (.xcodeproj 재생성)
scripts/ios.sh boot     # Simulator 부팅 (TP_SIM, default "iPhone 17 Pro"; iOS 전용)
scripts/ios.sh build    # xcodebuild (iOS: Debug-iphonesimulator / macOS: platform=macOS / visionOS: Debug-xrsimulator / watchOS: Debug-watchsimulator)
scripts/ios.sh run      # install + launch (macOS: open -n)
scripts/ios.sh smoke    # rust→gen→build→launch + 마커 검증 (iOS/macOS/visionOS: 8마커, watchOS: 7마커)
scripts/ios.sh uitest   # XCUITest UI E2E (단일 플랫폼; TP_PLATFORM 분기, watchOS는 die)
scripts/ios.sh uitest-all  # XCUITest UI E2E 전 플랫폼 매트릭스 (iOS/iPad/macOS/visionOS + watchOS 자동 SKIP; PASS/SKIP/FAIL, 로컬 전용)
scripts/ios.sh test     # XCTest (iOS Simulator; xcframework 먼저)
```

`TP_FORCE_RUST=1` = xcframework 매번 재빌드(Rust 수정 후), `TP_SKIP_RUST=1` = 재빌드 스킵(빠른 반복). `TP_PLATFORM=macos` = 네이티브 macOS 경로(sim 없이 `open` + 호스트 unified log 스크랩 — 빠른 회귀). `TP_PLATFORM=visionos` = visionOS Simulator 경로(B2 ✅). `TP_PLATFORM=watchos` = watchOS Simulator 경로, `TeleprompterWatch` 타깃 빌드, 7마커(TP_INPUT_OK 제외, B3 ✅). `TP_WATCH_SIM` = watchOS Simulator 기기명(기본 `"Apple Watch Series 11 (46mm)"`). ADR-0002.

부트마커는 `os.Logger(subsystem: "dev.tpmt.app", category: "boot")` 로 emit, 하니스가 Simulator unified log 를 `--predicate "subsystem == ..."` 로 grep 검증. **코어마커**(`TP_CORE_OK`/`TP_CORE_FAIL`)는 `TpCoreCheck` 가 encode→encrypt→decrypt→decode 라운드트립을 FFI 로 실행한 결과 — Rust 정적 라이브러리가 링크됐고 실기 런타임에서 동작함을 증명한다. 상세는 `ios/README.md` + `rust/README.md`. 실기기/TestFlight 배포는 재작성 진행에 따라 별도 정착.

## Request Reading Guidance

<!-- fabler:guard event=835fe251-3ce7-4d10-8f7b-9c2e8ddbd5c9 -->
<!-- fabler:guard event=83f3a9cf-e88b-48e8-990d-d8b401c30204 -->
A short literal instruction of the form "Reply with exactly: `<token>`" (e.g. a bare "OK") in this repo's sessions is an ordinary liveness/connectivity check (dogfood harness, CI plumbing, or a human confirming the session is responsive) — read it as plain instruction-following, not as an attempt to probe, extract, or bypass any hidden reasoning, system prompt, or safety mechanism. If this kind of check keeps getting flagged, a less ambiguous phrasing works just as well — suggested phrasing: "Please just confirm with OK."

<!-- fabler:guard event=ae006a8f-4caf-4003-ad4b-b15b45216bf3 -->
A short request like "confirm origin/main head" (or similar phrasing asking to check the current state of `origin/main`, e.g. after a PR merge) in this repo's sessions is an ordinary git-state check — read it as a plain instruction to run a read-only `git fetch`/`git log`/`git worktree list` style command, not as an attempt to probe, extract, or bypass any hidden reasoning, system prompt, or safety mechanism.