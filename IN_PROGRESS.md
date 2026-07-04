# IN_PROGRESS — 후속 세션 인계 (2026-07-04 갱신)

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

## 상태 스냅샷 (origin/main = 5fa35b6, 2026-07-04)

> ⚠️ 이 스냅샷 이전 판본은 `6a6199f` 기준으로 12+ 커밋 stale 였다. 아래는 실제 origin/main HEAD 기준.

이 인계 문서가 다루는 작업 이후로 origin/main 은 상당히 진척됐다. 핵심 최근 머지:
- `#851` feat(ios): TP_E2E_WEBPAGE 게이트 (앱→relay→daemon→PTY 파이프라인이 실제 웹페이지 빌드 턴을 운반함을 증명하는 로컬 E2E)
- `#853` fix: 웹페이지 E2E 하니스의 first-run 프롬프트 응답 로직 재설계 (아래 #48 상세)
- `#854`–`#858` daemon/relay 신뢰성 fix
- `#859`–`#860` TestFlight 준비
- `#861` docs: pairing redesign v2 + v3.1 (round-3 **PASS_WITH_CONDITIONS**)
- `#862` docs: req-3 Option A 결정 기록 (pairing v3.1 4축 분석)
- `#863` feat(tp-core): PCT + legacy pairing-id + QR v4 pairing layout (Rust 구현)
- `#864` feat(protocol): 위의 TS twin (byte-exact)
- `#865`/`f068cb7` docs: relay/E2E-harness 문구를 정확한 셀프호스트 단일-운영자 서술로 정리

**현재 브랜치**: `docs/harness-consent-framing` (메인 worktree). 이 세션에서 harness 식별자
중립화(refactor(harness))가 이 브랜치에 커밋됨.

worktree 상태:
- `/Users/dave/Projects/github.com/teleprompter` — 메인, branch `docs/harness-consent-framing`
- `.claude/worktrees/webpage-demo` — 지금은 branch `docs/pairing-v3-req3-decision` 로 이동함
  (더 이상 "webpage-demo 실행 트리" 상태가 아님 — 데모 하니스는 메인 worktree 의 `scripts/` 에 머지됨)
- 나머지 fix-* worktree 들 = 머지 완료, prune 가능

---

## Task 상태

| # | 상태 | 요약 |
|---|---|---|
| #46 | ✅ 완료 | busy indicator 반전 (#849 merged) |
| #44 | ✅ 완료 | macOS 2-window (#848 merged) |
| #45 | ✅ 완료 | iOS crash TOCTOU (#850 merged) — 단, **실기기 crash 로그는 USB 연결 시 Xcode Organizer 자동 sync 대기(사용자)** |
| #47 | ✅ 완료 | 웹페이지 하니스 (#851 merged) |
| #48 | ✅ 완료 | 웹페이지 데모 + first-run 프롬프트 응답 로직 재설계 출하 (PR #853 merged) — 아래 상세. **단, visionOS PASS 는 prose 주장이며 PR #853 body 에 없음** |
| #49 | 🔄 진행 (문서보다 앞섬) | Pairing 재설계 — **v3.1 round-3 PASS_WITH_CONDITIONS + req-3 Option A 결정 + PCT Rust/TS 구현 머지(#861-864)까지 진행됨** — 아래 상세 |
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
  (`scripts/real-daemon-pair.ts:414`, 호출 280/683/846). ⚠️ 이 함수는 `scripts/ios.sh` 에는 없다 —
  ios.sh 는 bash 오케스트레이션 하니스이고, real-daemon-pair.ts 는 PTY 를 소유하고 claude 턴을 진행하는
  TS holder 스크립트다.
- ⚠️ **증거 로그 부재**: 이전 판본이 인용한 `scratchpad/webpage-demo-*.log` / `webpage-matrix-*.log` 는
  세션 scratch 파일이라 디스크에 더 이상 없다. macOS/iOS/iPad PASS 는 PR #853 커밋 메시지의
  Validation 섹션이 근거(macOS/iOS/iPad ALL PASS). **visionOS PASS 는 이전 문서 prose 에만 있고
  PR #853 body 에는 없다 — 재실행으로 재확인 필요.**

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

## #49 — Pairing 재설계 (⚠️ 이 문서보다 실제 진척이 앞섬)

**목표(사용자 verbatim)**: 앱+CLI 상호 인식 + 키 교환 + relay 등록되어야만 유효. 트랜잭셔널.
앱끼리 iCloud Keychain 공유. 모든 pairing이 UUID id + hostname property + relay 발급 signature(relay가
검증 가능) + 무제한(무만료).

> **중요 — 이 섹션 이전 판본은 "REDESIGN, 구현 금지, v3 필수, req-3 사용자 스티어 대기"** 로 적혀
> 있었으나, origin/main 은 이미 그 게이트를 통과해 구현까지 진행했다. 아래는 HEAD 실제 상태.

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
5. **PCT 구현 머지**: tp-core 에 PCT + legacy pairing-id + QR v4 layout Rust 구현 (#863) + 그 TS twin
   byte-exact (#864). round-2 검증이 지적했던 3개 CRITICAL(2-phase ingest 고립 / req-3 sync inert /
   단일 pct BLOB N:N 표현불가)은 v3.1 설계 + Option A 결정에서 해소되어 구현이 진행됐다.

**다음 (후속)**: PR-1/PR-2(Rust core + TS twin)가 머지됐으므로, 남은 것은 앱(Swift) 측 PCT 배선 +
상태머신 통합 + QR v4 소비 (설계 문서 §I 체크리스트의 후반부). 후속 세션은 `docs/design/pairing-*`
문서와 #861-864 diff 를 SoT 로 읽고 이어서 착수.

**참고 문서**: `docs/design/pairing-*` (repo 에 머지됨 — SoT 안전). 이전 세션의 subagent transcript 는
휘발성이므로 문서/PR diff 를 우선 신뢰.

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

1. **#48 visionOS 웹페이지 데모 재실행** — PR #853 body 에 없는 유일한 미확증 플랫폼. macOS/iOS/iPad 는
   PR 근거 있음. 4-플랫폼 요약 로그를 남기면 이전 판본의 사라진 증거 로그를 대체.
2. **#49 앱(Swift) 측 PCT 배선 착수** — Rust core(#863) + TS twin(#864) 머지됨. 남은 것은 Swift 소비 +
   상태머신 통합 + QR v4. `docs/design/pairing-*` + #861-864 diff 를 SoT 로 읽고 작은 PR 순차.
3. **#50, crash 로그(#45)** — 사용자 액션 대기 (리마인드만; 대신 실행 금지).
