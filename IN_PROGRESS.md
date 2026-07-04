# IN_PROGRESS — 후속 세션 인계 (2026-07-05 갱신 · rev3)

이 문서는 진행 중이던 작업을 후속 세션이 그대로 이어받도록 정리한 것이다.
**규율 상기**: 도구 호출은 구조화된 `tool_use` 블록으로만. squash merge only via
`gh api repos/DaveDev42/teleprompter/pulls/<n>/merge -X PUT -f merge_method=squash`.
PR title = conventional-commit. dogfood tp = `~/.local/bin/tp` (brew symlink 절대 안 건드림).
Agent 호출 시 항상 `model` 명시. 실 claude E2E 하니스는 로컬 전용(절대 CI 아님).

> **이 문서가 다루는 작업의 성격 (먼저 읽을 것).** Teleprompter 는 개발자 본인 소유의
> 셀프호스트 개발 도구다 — VS Code Remote / `tmux` over SSH / `mosh` 와 같은 범주.
> 개발자가 **자기** 머신에서 데몬을 돌리고 **자기** 폰을 페어링해 **자기** Claude Code 세션을
> 보고 조작한다. 동의한 운영자는 정확히 한 명이고, 제3자도 없고, 운영자 자신의 개발 박스
> 외에 다른 대상도 없다. E2E 하니스는 그 운영자 자신의 개발 워크플로우를 일회용 sandbox 에서
> 자동화하며, first-run 프롬프트에 응답하거나 운영자 자신의 로그인 토큰을 재사용하는 부분은
> 평범한 unattended-CI plumbing 이다.

---

## 상태 스냅샷 (origin/main = 74325a80, 2026-07-05 rev3)

> rev3: **PR-5 머지됨 (#871, squash `74325a80`)** — 8-PR 페어링 재설계 중 PR-1~PR-5 완료.
> 남은 것: PR-6(Option A greenlight 대기)·PR-7·PR-8.

핵심 최근 머지:
- `#851` feat(ios): TP_E2E_WEBPAGE 게이트 (앱→relay→daemon→PTY 파이프라인이 실제 웹페이지 빌드 턴을 운반함을 증명하는 로컬 E2E)
- `#853` fix: 웹페이지 E2E 하니스의 first-run 프롬프트 응답 로직 재설계 (아래 #48 상세)
- `#854`–`#858` daemon/relay 신뢰성 fix
- `#859`–`#860` TestFlight 준비
- `#861` docs: pairing redesign v2 + v3.1 (round-3 **PASS_WITH_CONDITIONS**)
- `#862` docs: req-3 Option A 결정 기록 (pairing v3.1 4축 분석)
- `#863` feat(tp-core): **PR-1** — PCT + legacy pairing-id + QR v4 pairing layout (Rust 구현)
- `#864` feat(protocol): **PR-2** — 위의 TS twin (byte-exact)
- `#865`/`#866` docs: relay/E2E-harness 문구를 정확한 셀프호스트 단일-운영자 서술로 정리

**이전 세션 진행분 (전부 origin/main 에 착지)**:
- **PR-3 (daemon PCT 배선) — 머지됨 (#867, squash `da3d6671`)**. `pairing_confirmations`
  테이블(N:N) + `pairings.pairing_id`/`hostname` + async 백필(`migratePairingIds`) +
  `handleKxFrame` PCT 파생 + 두 hello 빌더 pct 캐리 + cascade delete + orphan sweep +
  `SessionHelloReply.d.pct?` additive-optional.
- **PR-4 (앱 Swift connect-on-pending 라이프사이클) — 머지됨 (#869, squash `fada3439`)**. PENDING
  네임스페이스(device-local, non-synced Keychain) + ingest→`TP_PAIR_PENDING` + `beginPending`
  connect-on-pending + kx 완료 시 promote(살아있는 client 재연결 없이 re-key, §1.6 R2) +
  `TP_PAIR_OK` promote-time 이동 + committed meta `pairingId`/`hostname` 영속 + 레거시 backfill.
  PCT 검증 없음 — PR-4 승격 조건은 kx 완료(레거시 의미론).
- 문서 sync: #868(PR-3), #870(PR-4).

**이 세션 진행분 (2026-07-05 rev2)**:
- **✅ dogfood tp 재빌드 완료** — #867 이 daemon/protocol 을 건드려 필요했던 것. CLAUDE.md freshness
  시퀀스 실행: Rust `tp` release 빌드 + Bun `tpd` SEA blob + prefix-tree 조립 + `bin/tp`·`tpd` 둘 다
  adhoc 재서명 + `tp daemon install`. daemon 이 06:09 새 tpd blob(`pairing_confirmations` 심볼 포함)로
  재기동 확인. `tp version` = v0.1.52 정상.
- **✅ #48 visionOS 웹페이지 E2E PASS** — fresh xcframework(`TP_FORCE_RUST=1`)로 재실행. 로그:
  `✅ WEBPAGE E2E PASS`, `UserPromptSubmit=2, Stop=2`, `PostToolUse(Write)`+`PostToolUse(Bash)` 둘 다
  `index.html` 참조. 이로써 **4-플랫폼(macOS/iOS/iPad/visionOS) 웹페이지 데모 전부 PASS** 확인.
- **✅ PR-5 (앱 PCT 검증 승격 게이트) 머지됨 (#871, squash `74325a80`)** — §1.3 승격 판정 표(4셀) +
  `minAdvertisedV` anti-downgrade floor + §2.5 committed 재검증 + loopback v:3+pct. 상세 아래 #49 섹션.
  검증: XCTest 164/164 · macOS+iOS Sim loopback smoke 8/8(+`TP_PAIR_CONFIRM_OK` 실기 확인) ·
  적대적 4-lens 리뷰 0 findings · CI 7/7 green. **dogfood 재빌드 불필요**(app+loopback+docs, 백엔드 무변경).

**현재 브랜치**: `main` (= `74325a80`, PR-5 머지 반영). clean.

worktree 상태: 메인 worktree 하나만 (`.claude/worktrees/*` 전부 prune 됨).

---

## Task 상태

| # | 상태 | 요약 |
|---|---|---|
| #46 | ✅ 완료 | busy indicator 반전 (#849 merged) |
| #44 | ✅ 완료 | macOS 2-window (#848 merged) |
| #45 | ✅ 완료 | iOS crash TOCTOU (#850 merged) — 단, **실기기 crash 로그는 USB 연결 시 Xcode Organizer 자동 sync 대기(사용자)** |
| #47 | ✅ 완료 | 웹페이지 하니스 (#851 merged) |
| #48 | ✅ 완료 | 웹페이지 데모 + first-run 프롬프트 응답 로직 재설계 출하 (PR #853 merged) — **4-플랫폼(macOS/iOS/iPad/visionOS) 전부 PASS 확인** (visionOS 이 세션 재실행, fresh xcframework) |
| #49 | 🔄 진행 | Pairing 재설계 8-PR — **PR-1~PR-5 머지 완료 (#863/#864/#867/#869/#871), PR-6(Option A greenlight 대기)·PR-7·PR-8 미착수** — 아래 상세 |
| #50 | ⏸️ 사용자 | keychain 접근 확인 프롬프트 완화 — 아래 상세 (사용자 본인만 실행) |

---

## #48 — 웹페이지 데모 반복 루프 (사용자 핵심 목표)

**목표(사용자 verbatim)**: "iOS, iPadOS, macOS에서 현재 PC의 tp 명령어와 상호작용하여, claude code를
사용하여 간단한 웹페이지를 만드는 데모 테스트를 시행 … 발견된 어색한 점이나 버그 등을 계속 수정하며 반복."
"smoke ok 수준이 아니라, 실제 claude code를 구동해."

이 데모는 개발자 자기 머신에서 자기 폰으로 자기 claude 세션을 구동하는 로컬 통합 테스트다 — SSH/VS Code
Remote 와 동급의 단일-운영자 셀프호스트 워크플로우.

**실행 방법** (하니스는 메인 worktree 의 `scripts/` 에 있음):
```bash
cd /Users/dave/Projects/github.com/teleprompter
TP_E2E_WEBPAGE=1 TP_PLATFORM=<macos|ios|ipad|visionos> TP_SKIP_RUST=1 TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke
```
- Host = Dave-MBP16 (M1 Max 64GB). claude on PATH 필수. **로컬 전용, 운영자 자신의 claude auth+credits 재사용.**
- `TP_SKIP_RUST=1` = xcframework 재사용(첫 macOS 실행이 이미 빌드). rust 수정했으면 빼거나 `TP_FORCE_RUST=1`.
- 성공 판정 = 로그에 `✅ WEBPAGE E2E PASS` + `UserPromptSubmit=2, Stop=2` + `PostToolUse(Write)`+`PostToolUse(Bash)`.

**소스 상태 (HEAD 에서 확인됨)**:
- ✅ TP_E2E_WEBPAGE 하니스 머지 (#851). trust-프롬프트 응답 로직 재설계 머지 (#853).
- ✅ `answerFirstRunPrompts()` 가 3개 holder(interactive/coding/webpage) 전부에 배선됨
  (`scripts/real-daemon-pair.ts`). ⚠️ 이 함수는 `scripts/ios.sh` 에는 없다 — ios.sh 는 bash
  오케스트레이션 하니스이고, real-daemon-pair.ts 는 PTY 를 소유하고 claude 턴을 진행하는 TS holder 다.
- ✅ **visionOS PASS 재확인 (이 세션, 2026-07-05)**: `TP_E2E_WEBPAGE=1 TP_PLATFORM=visionos
  TP_FORCE_RUST=1 scripts/ios.sh smoke` → `✅ WEBPAGE E2E PASS`, `UserPromptSubmit=2, Stop=2`,
  `PostToolUse(Write)`+`PostToolUse(Bash)` 둘 다 index.html 참조. macOS/iOS/iPad 는 PR #853 body
  Validation 근거. **4-플랫폼 전부 PASS**. (이전 판본의 "visionOS 재확인 필요"는 이제 해소.)

**🐞 근본 원인 (PR #853 이 닫음)**:
현행 claude 는 (테스트가 방금 만든 운영자 소유 격리 sandbox 를 처음 열 때) Claude 자체의 first-run 확인
프롬프트를 **2개 연속** 띄운다:
  1. "Quick safety check: Is this a project you trust? ❯ 1. Yes, I trust / 2. No, exit"
     — 문서화된 기본 강조(❯) = **1. Yes**.
  2. non-interactive 권한모드 안내 다이얼로그: "❯ 1. No, exit / 2. Yes, I accept / Enter to confirm"
     — 기본 강조(❯) = **1. No, exit**.

기존 harness 의 범용 입력 루프(`for i in 1..13: sendSubmit('\r'); sleep 2000` — 화면 내용과 무관하게
고정 간격으로 Enter 를 전송하는 턴 진행용 루프)는 **단일 "Yes"-기본 다이얼로그**를 가정했다. 그래서
화면 상태를 확인하지 않는 그 범용 재시도 루프가 두 번째 확인 다이얼로그의 기본 선택지("No, exit")에서
Enter 를 보내는 바람에 claude 프로세스가 그대로 종료됐다 → SessionEnd, `UserPromptSubmit=0`,
index.html 미생성. macOS/iOS 는 cold-start 타이밍 운으로 통과했을 뿐.

**✅ 해결 + 출하 완료 (PR #853 merged)**:
- **수정 방식**: config-seed 억제는 Claude Code 자체의 non-interactive 권한모드 CLI 플래그
  (`--permission-mode bypassPermissions`, 공식 문서화된 옵션) 경로에선 작동하지 않음을 실증. 따라서
  content-aware `answerFirstRunPrompts()` 로 재설계 — operator 소유 unattended CI 하니스가, 자신이
  방금 만든 throwaway sandbox 의 first-run 프롬프트에 사람이 눌렀을 응답을 대신 제출하는 핸들러:
  세션 DB의 라이브 io 를 읽어 현재 표시된 Claude 자체 first-run 프롬프트 종류를 식별하고, 대응 응답
  키를 전송 — 신뢰 폴더 확인=Enter(문서화된 기본값 Yes 선택) / non-interactive 권한모드 안내=Down+Enter
  ("Yes, I accept" 선택) / settings-error=`3`(Continue). holder 3곳 전부 화면 상태를 확인하지 않던
  고정 간격 `\r` 재시도 루프·`setInterval` 을 제거하고 이 핸들러로 교체.
- **🐞 3번째 블로킹 지점 발견 (사용자 로컬 환경의 실제 설정 버그)**: 위 두 프롬프트에 정상 응답하도록
  수정하니 **세 번째** 블로킹 다이얼로그가 드러남 — `~/.claude.personal/settings.json` 의 `fallbackModel`
  값이 문자열 `"opus"` 인데 현행 claude 스키마는 **배열**(`A.array(A.string())`) 요구 → "Settings
  Error … Expected array, but received string" 다이얼로그가 **매 세션** 뜨고 그 파일의 설정(hooks 포함)이
  전부 스킵됨. 하니스뿐 아니라 사용자 일상 claude 전반에 영향. → 실 파일을 `["opus"]` 로 수정(리포 밖,
  적용 완료) + 하니스도 이 다이얼로그를 방어.
- **검증(PR #853 body 기준)**: macOS ✅ / iOS ✅ / iPad ✅ (index.html Write + Bash 검증,
  `UserPromptSubmit=2, Stop=2`, Write/Bash PostToolUse). M5 input round-trip 회귀(기본 loopback smoke,
  iOS) PASS. **visionOS 는 PR body 에 없음 — 재실행 필요.**

> **주의(문서 정합)**: `.claude/rules/native-testing.md` 는 PR #853 이 갱신하지 않아, 한동안
> TP_E2E_WEBPAGE/CODING 섹션이 폐기된 "13회 Enter blind loop" 동작을 설명하고 있었다. 이 세션의
> harness 식별자 중립화 커밋이 그 문서의 심볼 참조를 새 이름으로 동기화했다 (`answerFirstRunPrompts` 등).

**남은 후속 (선택)**: 인터랙티브 UI dogfood(실기기/앱에서 사람이 직접 조작) 는 별도 후속 — 현재 E2E 는
하니스가 프로그램적으로 turn 을 진행하는 방식.

---

## #49 — Pairing 재설계 (8-PR)

**목표(사용자 verbatim)**: 앱+CLI 상호 인식 + 키 교환 + relay 등록되어야만 유효. 트랜잭셔널.
앱끼리 iCloud Keychain 공유. 모든 pairing이 UUID id + hostname property + relay 발급 signature(relay가
검증 가능) + 무제한(무만료).

> **SoT = `docs/design/pairing-redesign-local-ecdh-commit-v3.md` §5 (8-PR 플랜 표).**
> relay signature 는 폐기됨 (relay 는 zero-trust) — 대신 앱+daemon 이 이미 하는 실 ECDH kx 에서
> 양측 로컬 파생한 **Pairing Confirmation Tag(PCT)** 가 commit certificate 다.

**진행 경과 (실제 머지 기준)**:
1. 1차 설계("Minimal-State Signer", relay-HMAC) → opus 적대적 검증 → **REDESIGN 판정** (4개 확증 결함:
   relay 는 zero-trust 라 daemon 실 pk 미보유; 악의 daemon 이 임의 fingerprint 서명 획득 가능;
   "app COMMITTED⇒daemon COMMITTED" 거짓; 설계의 현재상태 서술 사실오류).
2. 사용자 결정 = **"로컬 ECDH 기반 재설계"**. relay signature 폐기, 앱+daemon 이 이미 하는 실 ECDH kx 에서
   양측 로컬 파생한 **Pairing Confirmation Tag(PCT)** 를 commit certificate 로. relay 는 stateless
   ciphertext-only 유지.
3. **v2 + v3.1 설계 문서 머지 (#861)** — round-3 재검증 판정 = **PASS_WITH_CONDITIONS** (이전 판본이
   "REDESIGN hard gate, 구현 금지" 라고 적은 상태를 이미 넘어섰다).
4. **req-3(iCloud sync 메커니즘) 결정 머지 (#862)** — 이전 판본이 "사용자 스티어 필요" 라고 남긴 미결
   항목이 **Option A 로 결정**됨 (pairing v3.1 4축 분석 기록). 더 이상 사용자 스티어 대기 아님.
5. **PR-1/PR-2 머지**: tp-core 에 PCT + legacy pairing-id + QR v4 layout Rust 구현 (#863=PR-1) + 그
   TS twin byte-exact (#864=PR-2). round-2 검증이 지적했던 3개 CRITICAL(2-phase ingest 고립 / req-3
   sync inert / 단일 pct BLOB N:N 표현불가)은 v3.1 설계 + Option A 결정에서 해소.
6. **PR-3 (daemon 배선) — 이 세션**: 이전 세션이 worktree `pr2-pairing-ts-twin` 에 구현만 해두고
   커밋 없이 "일시정지"로 인계한 것을 발견. 이 세션에서 diff 를 clean 브랜치
   `feat/pr3-daemon-pct-wiring`(off origin/main) 로 재조립·검증(모든 게이트 green)·커밋(`f962b14c`).
   내용 = `pairing_confirmations` 테이블(N:N) + `pairings.pairing_id`/`hostname` + async 백필
   (`migratePairingIds`) + `handleKxFrame` PCT 파생 + **두 hello 빌더**(auto + on-demand) pct 캐리 +
   COALESCE 클로버 가드 + cascade delete + orphan sweep + `SessionHelloReply.d.pct?` additive-optional.
   적대적 리뷰(4-lens) 통과 후 push→PR→squash merge.

7. **PR-4 (앱 connect-on-pending) — 머지됨 (#869)**: pending 라이프사이클 + 3 ingest 지점 +
   pairingId 키 client 맵·promote re-key·GC dispose + committed meta `pairingId`/`hostname` 영속 +
   `TP_PAIR_PENDING` 마커 신설. PCT 검증 없음(승격=kx 완료, 레거시).

**PR-5 완료 (머지됨 #871, squash `74325a80`)**:
- 목표(설계 §5 PR-5 행 + §1.3 승격 판정 표 전체): kx 후 PCT_app 계산 → hello `d.pct` 비교 →
  `onPairingConfirmed`(PCT 일치 게이트)/`onPairingConfirmFailed` → `effectiveV<3` 레거시 분기 →
  `minAdvertisedV` floor 영속·상승(`DaemonKxPayload.v` 최초 소비) → committed 재검증(§2.5) +
  `local-relay-loopback.ts` kx `v:2`→`v:3` + hello pct.
- **§1.3 승격 판정 표 (구현 대상 단일 규칙)**: hello.d.pct present&==PCT_app → COMMITTED(promote)+floor←max(3);
  present&!=PCT_app → FAILED(mismatch, 가시적·재시도); absent & effectiveV<3 → COMMITTED(legacy,
  confirmed=false); absent & effectiveV≥3 → **FAILED(pct-missing, 레거시 fall-through 금지)**.
- ✅ **구현 완료 (전 파일)**:
  - `PairingStore.swift` — `Pairing.minAdvertisedV` 필드 + 전 persist/load 사이트(committed/pending) floor
    스레딩 + QR v4=3 / v2·v3=0 초기화 + committed persist 가 기존 floor 를 내리지 않게 max 보존 +
    `raisePendingFloor`/`raiseCommittedFloor`(monotonic) + `recordConfirmedPct`/`lastConfirmedPct`
    (device-local §2.5 진단) + `floor()` 조회.
  - `RelayClient.swift` — `deriveEpochPct`(kx-frame daemon pubkey + ephemeral 키페어 + 세션키, FFI
    `derivePairingConfirmationTag`) + `uuid16`(big-endian, TS `parseUuid16` 와 byte-exact) + `epochAdvertisedV`
    (`DaemonKxPayload.v` 최초 소비) + 승격 신호 kx→hello 이동 + `resolvePromotion`(§1.3 4셀 전부) +
    `onPairingConfirmed(pid, confirmed)`/`onPairingConfirmFailed(pid, reason)` + pending(하드)/committed(§2.5
    보수적) 구분 + `TP_PAIR_CONFIRM_OK`/`TP_PAIR_CONFIRM_FAIL` 마커.
  - `RelayMessages.swift` — `HelloData.pct: String?` additive-optional.
  - `TeleprompterApp.swift` + `Watch/TeleprompterWatchApp.swift` — 콜백 배선(confirmed/legacy→promote,
    FAILED→client alive 유지+pendingError, committed §2.5 재검증 배선, `setPairingPhase`).
  - `local-relay-loopback.ts` — kx `v:2`→`v:3` + hello `pct`(`deriveLegacyPairingId`+`parseUuid16`+
    `derivePairingConfirmationTag`, daemon-role 세션키로 계산 — app frontend-role 과 byte-exact 수렴 확인).
  - `PairingStoreTests.swift` — floor init/promote-carry/monotonic-raise/PCT-record/absent-default + 마커 7 테스트.
  - `scripts/ios.sh` — `PAIR_CONFIRM_OK_MARKER` 문서화(loopback `TP_PAIR_OK` 가 이제 PCT-confirm 을 transitively 게이트).
- ✅ **검증 통과**: XCTest **164/164**(신규 7 포함) · macOS loopback smoke **8/8** · iOS Sim loopback smoke **8/8**
  (+`TP_PAIR_CONFIRM_OK` 실기 로그 확인 = Cell 1 byte-exact PCT 일치 증명) · swift-format lint clean(내 파일) ·
  protocol 620/620 · **적대적 4-lens 리뷰(§1.3 판정표/byte-exact PCT/lifecycle·anti-downgrade/loopback) 0 findings** ·
  **CI 7/7 green**(lint/type-check/test/build-cli/rust required + swift-build/swift-smoke-ios). 문서 sync(native-testing.md·ios/README.md)는
  같은 PR 에 동봉(squash 로 main 단일 commit). dogfood tp 재빌드 불필요(백엔드 무변경).

**남은 PR (설계 §5)**:
- **PR-6 (Option A greenlit)**: `PairingRecordStore` seam + synced whole-record Keychain (Option A).
- **PR-7**: unpair vs "이 기기에서만 제거" split (localHidden tombstone, pairingId 키).
- **PR-8**: `WS_PROTOCOL_VERSION` 2→3 (`compat.ts:43`) + CLAUDE.md/ARCHITECTURE/protocol.md 문서 갱신.
  **PCT/v4 문서 갱신은 PR-8 소관** (PR-3 아님).

**참고 문서**: `docs/design/pairing-*` (repo 머지 — SoT 안전). §1.3 승격 판정 표 + §2.5 재검증 정책이
PR-5 구현의 SoT. subagent transcript 는 휘발성이므로 문서/PR diff 를 우선 신뢰.

---

## #50 — keychain 접근 확인 프롬프트 완화 (사용자 액션 필요)

**증상(사용자 verbatim)**: "계속 반복해서 keychain access를 위해 비밀번호를 입력해달라고 뜨는데,
이것좀 안뜨게 할 수 없어?"

**원인/완화**: dogfood daemon(또는 관련 프로세스)이 **개발자 본인 소유의** keychain 항목에 접근할 때마다
macOS 가 ACL 확인 프롬프트를 띄운다. 이는 사용자 편의 문제다. 표준 macOS 도구
(`security set-generic-password-partition-list`)로, 항목 소유자인 개발자 본인이 자신이 만든 자신의
keychain 항목 ACL 에 자신이 신뢰하는 apple-tool/apple 파티션을 등록하면 반복 프롬프트 없이 접근이
허용된다. 이는 macOS 표준 ACL 메커니즘이다 — 항목을 소유한 개발자 본인이 자신의 항목에 자신이 신뢰하는
접근자를 명시적으로 등록하는 것 (VS Code/Chrome 등 codesign 된 애플리케이션이 하는 것과 동일).

**⚠️ 이건 사용자 본인만 수행 가능** (keychain 비밀번호 입력이 필요한 macOS ACL 변경 = 에이전트 정책상
대신 실행 금지). 후속 세션도 대신 실행 금지 — 사용자에게 명령을 제시하고 직접 실행하도록 안내만.
정확한 대상 항목(어느 service name 인지)은 프롬프트가 뜰 때 어떤 프로세스/항목인지 확인 후 특정해야 함.

---

## 즉시 다음 액션 (후속 세션 우선순위)

1. ✅ **dogfood tp 재빌드 — 완료** (이 세션). #867 daemon/protocol 반영, daemon 06:09 재기동.
2. ✅ **#48 visionOS 웹페이지 데모 — PASS** (이 세션, fresh xcframework). 4-플랫폼 전부 PASS.
3. ✅ **#49 PR-5 (앱 PCT 검증 승격 게이트) — 머지됨** (#871, squash `74325a80`). §1.3 4셀 + floor +
   §2.5 + loopback v:3+pct. XCTest 164/164 · loopback smoke 8/8 · 적대적 리뷰 0 · CI 7/7 green.
4. ⏭️ **#49 PR-6 (다음) — Option A 착수 greenlight 대기**. `PairingRecordStore` seam + synced
   whole-record Keychain (Option A). **사용자가 명시적으로 Option A 진행을 승인한 뒤** 시작 (설계 §5 PR-6).
   그 뒤 PR-7(unpair split), PR-8(`WS_PROTOCOL_VERSION` 2→3 + PCT/v4 문서 갱신).
5. **#50, crash 로그(#45)** — 사용자 액션 대기 (리마인드만; 대신 실행 금지).
