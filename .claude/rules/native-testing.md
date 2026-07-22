---
paths:
  - "ios/**"
  - "rust/**"
  - "scripts/ios.sh"
  - "scripts/local-relay-loopback.ts"
  - "scripts/real-daemon-pair.ts"
---

# Native (Apple multiplatform) Testing — SoT

Apple 멀티플랫폼 앱(iOS/iPadOS/macOS/visionOS + watchOS 별도 타깃)의 로컬 검증은 전부
**`scripts/ios.sh`** (bash 하니스) + **XCUITest 타깃 `TeleprompterUITests`** 가 담당한다.
EAS 클라우드 빌드는 제거됐다 (ADR-0001/0002). 이 문서가 검증 레이어·마커·플랫폼별 한계의 SoT 다.

> **Scope note.** 아래 실-claude E2E 게이트는 전부 **개발자 자기 머신의 로컬 통합 테스트**다 (절대 CI
> 아님, 원격 타깃 없음). throwaway 격리 HOME 에서 claude 를 unattended 로 돌리므로, 하니스가 (a) claude 의
> first-run "이 폴더 신뢰?" 프롬프트에 자기 sandbox 이니 스스로 응답하고, (b) 이미 로그인된 **개발자 본인의**
> claude 토큰을 재사용해 격리 daemon 에 넘긴다. 이는 unattended-CI 배관일 뿐 — credential 탈취도, safety
> 우회도 아니며, 어떤 자격증명도 머신을 떠나지 않는다.

## 검증 레이어 (3중)

| 레이어 | 무엇 | 명령 | 어디서 돈다 |
|---|---|---|---|
| **마커 E2E** | os.Logger 부트마커를 unified log 에서 폴링 — 실 wire/E2EE/kx 라운드트립이 동작함을 증명 | `scripts/ios.sh smoke` | 5플랫폼 전부 |
| **UI E2E** | XCUITest 가 a11y 트리를 쿼리해 세션 row tap → pane picker → chat bubble 어서션 | `scripts/ios.sh uitest` (단일) / `uitest-all` (전 플랫폼 매트릭스) | iOS/iPadOS 풀, macOS는 호스트 TCC 인가 시(없으면 SKIP), visionOS 부분, **watchOS 불가(자동 SKIP)** |
| **유닛** | XCTest (FFI/Keychain/relay.auth/terminal 등) | `scripts/ios.sh test` | iOS Simulator |

마커 E2E 는 **실 `RelayServer` + 가짜 daemon**(포트 7099, golden 토큰 pre-seed, 합성
`sess-smoketest`)이 기본. loopback 백엔드는 **두 구현**이 wire-identical 하다: 기본 = Bun
`scripts/local-relay-loopback.ts`, **`TP_RUST_LOOPBACK=1`** = 컴파일된 Rust `tp-loopback`
바이너리(`rust/tp-loopback` — 실 `tp_relay::RelayServer` in-process + `tokio-tungstenite` 가짜
daemon peer, `tp_core` 크립토로 kx/hello/PCT/batch/io 를 seal). 둘 다 같은 `LOOPBACK_READY` 핸드셰이크
+ 같은 8마커를 낸다 (macOS-native·iOS Simulator 8/8 교차검증, 2026-07-20). Rust 백엔드는 **#5
zero-Bun 목표**의 일부 — **PR3 이후 CI `swift-smoke-ios` job 이 `TP_RUST_LOOPBACK=1` 로 이 Rust
백엔드를 쓰며 `./.github/actions/setup`(bun) 을 드롭했다** (Bun 없이 iOS smoke 가 돈다). `start_loopback` 이
`TP_RUST_LOOPBACK` 세팅 시 `build_rust_loopback_bin`(rustup-shim-safe TC_BIN, release→debug
fallback, LOUD-on-fail)으로 바이너리를 빌드해 `RELAY_PORT` env 로 스폰한다. **실 `tp` daemon+relay**
E2E 는 `TP_E2E_REAL=1` 게이트 뒤 (아래 참조).

## 플랫폼 매트릭스

| Platform | `TP_PLATFORM` | 빌드 destination | 마커 | UI 자동화 | 비고 |
|---|---|---|---|---|---|
| iOS | `ios` (기본) | `platform=iOS Simulator,name=$TP_SIM` (`iPhone 17 Pro`) | **8** | 풀 | |
| iPadOS | `ipad` | iOS Simulator, `$TP_SIM`=`iPad Pro 13-inch (M5)` | **8** | 풀 | iOS 경로 alias — 새 슬라이스 불필요 (`ios-arm64_x86_64-simulator` 공유). split-view/sidebar 실행. (M5 = iOS 26.5 런타임; M4 는 18.5 뿐이라 name 해석 모호) |
| macOS | `macos` | `platform=macOS` (native, `open`) | **8** | **호스트 게이트** — 빌드+서명 O, XCUITest 런타임은 TCC/LocalAuthentication 인증 세션 필요. 비대화형/미인가 세션에선 runner init 실패 → `cmd_uitest` 가 **SKIP**(exit 0, `TP_UITEST_SKIP` 마커 emit — PASS 와 혼동 금지). `TP_UITEST_STRICT=1` 이면 이 게이트를 **hard-fail** | sim 없음. `screencapture -x` 아티팩트. `log stream` 폴링 |
| visionOS | `visionos` | `id=$visionUDID` (xrOS sim) | **8** | **부분** — element 쿼리+flat-window tap O, 공간 제스처/eye-gaze sim **불가** | `TP_VISION_SIM`=`Apple Vision Pro` |
| watchOS | `watchos` | `-target TeleprompterWatch -sdk watchsimulator` | **7** (no `TP_INPUT_OK`) | **없음** — watchOS 에 `XCUIApplication` 부재 (Apple hard limit) | `TP_WATCH_SIM`=`Apple Watch Series 11 (46mm)`. 마커+스크린샷만 |

> **`TP_INPUT_OK` 가 watchOS 에서 빠지는 이유**: ADR-0002 §4 — watchOS 는 제한 경험(입력 송신 미구현).
> 그래서 watchOS smoke 는 M0–M4 (7마커) 만 어서션한다.

> **Smoke Keychain 격리 (PR-6 Option A)**: PR-6 은 커밋 페어링 인덱스를 `simctl uninstall` 이 지우는
> UserDefaults 에서 **synchronizable Keychain blob**(`<base>.v2` service)로 옮겼다 — 이건 uninstall 을
> 살아남는다(iCloud sync 의 요점). smoke 는 매 런 fresh 페어링을 re-ingest 하므로, 잔류 committed blob 이
> 부팅 시 committed `RelayClient` 를 재연결시켜 그 런의 pending client 와 **같은 frontendId 로 경합** →
> daemon per-frontend 세션키 clobber → frame-decrypt `aead authentication failed`(M3' fail)를 낸다. 두
> 겹 방어: (1) **app-side** — `PairingViewModel.init` 이 `RelayClient.isSmokeMode`(`--tp-smoke*` launch
> arg)일 때 `store.wipeAllCommittedForSmoke()` 로 committed blob+pointer 를 부팅 즉시 wipe(프로덕션 런은
> no-op). (2) **harness-side** — `scripts/ios.sh` 의 macOS 정리 블록이 `security delete-generic-password
> -s dev.tpmt.app.pairing.v2` + `defaults delete … tp.pairings.ptr{,.order,.migrated.v2}` 로 host
> Keychain/defaults 를 청소(iOS Simulator Keychain 은 host 에서 접근 불가라 (1)이 담당). 이게 없으면 **연속
> smoke 두 번째 런부터** M3' 가 결정론적으로 깨진다.
>
> **PR-7 local-hide tombstone 정리 (같은 두 겹)**: PR-7 은 device-local·NON-synced `localHidden`
> tombstone(`tp.pairing.<pid>.localHidden` bool + **plural** `tp.pairings.hidden` 인덱스, UserDefaults)을
> 추가한다. 잔류 tombstone 이 결정론적 v3-derived smoke pairingId 를 `daemonIds()` 에서 필터하면
> **M1(`TP_PAIR_OK`)** 이 2번째 런부터 억제된다. 두 겹: (1) app-side `wipeAllCommittedForSmoke()` 가
> tombstone(플래그+인덱스)도 clear, (2) harness `defaults delete dev.tpmt.app tp.pairings.hidden`
> (plural 인덱스는 명시 삭제 — 기존 singular-prefix 루프 `grep '"tp\.pairing\.'` 는 per-pairingId
> `.localHidden` 플래그만 훑고 plural 인덱스는 못 잡는다).

## 마커 (8마커, os.Logger `subsystem == "dev.tpmt.app"`)

| # | 마커 | 의미 |
|---|---|---|
| M0 | `TP_BOOT_OK` | SwiftUI 부팅 + 보드 마운트 |
| M0' | `TP_CORE_OK` | tp-core FFI 라운드트립 (encode→encrypt→decrypt→decode) — Rust 정적 라이브러리 링크+동작 증명 |
| M1 | `TP_PAIR_OK` | pairing PROMOTED to COMMITTED. **PR-4 (connect-on-pending)**: ingest 는 PENDING 에만 쓰고 `TP_PAIR_PENDING` 을 emit; `TP_PAIR_OK` 는 promote 시점에 emit. **PR-5 (§1.3 PCT verification gate)**: promote 는 이제 kx 완료가 아니라 **hello 의 PCT 검증**이 게이트한다. loopback 은 kx `v:3` 을 advertise + hello 에 `pct` 를 실어(daemon-role 세션키로 계산, app frontend-role PCT 와 byte-exact 수렴) **§1.3 Cell 1(CONFIRMED)** 로만 승격시키므로 M1 = `TP_PAIR_OK` 는 이제 **PCT-confirm 을 transitively 게이트**한다 (mismatch=Cell 2 는 promote 안 함, `v:3` 이라 legacy Cell 3 도 배제 → `TP_PAIR_OK` 관찰 = Cell 1 실행 증명; 별도 `TP_PAIR_CONFIRM_OK` 도 emit). 마커 카운트 불변(8/8/8/7). **real-daemon E2E (`TP_E2E_REAL`/`TP_E2E_CLAUDE*`) 는 kx out-of-scope/racy 라 M1 = `TP_PAIR_PENDING`** (하니스가 `$real_e2e` 비어있지 않으면 `m1_marker=TP_PAIR_PENDING` 로 분기 — scrape/assert/marker-tally 전부). |
| — | `TP_PAIR_CONFIRM_OK` / `TP_PAIR_CONFIRM_FAIL` | **PR-5 (§1.3)** PCT 검증 결과 진단 마커 (`RelayClient` statics). CONFIRM_OK = pct==PCT_app(Cell 1) 또는 legacy commit; CONFIRM_FAIL = mismatch(Cell 2)/pct-missing(Cell 4). default 8/7 마커 셋에는 **없음** — 진단·회귀 로그용이며 loopback smoke 는 M1 의 transitive 게이팅으로 이를 커버한다. |
| M1' | `TP_PAIR_PENDING` | QR decode + PENDING persist (ingest 성공, PR-4). committed 승격 전 device-local 상태. real-daemon E2E 의 M1 어서션 마커. |
| M2 | `TP_RELAY_AUTH_OK` | relay `frontend auth` 성공 |
| M3 | `TP_KX_OK` | in-band kx → per-frontend 세션키 |
| M3' | `TP_FRAME_OK` | 첫 E2EE 프레임 복호 |
| M4 | `TP_SESSION_OK` | 세션 렌더 (hello/history) |
| M5 | `TP_INPUT_OK` | 입력 송신 왕복 (watchOS 제외) |

폴링 predicate: `--predicate "subsystem == \"dev.tpmt.app\""`. iOS 는 `simctl spawn … log show`,
macOS 는 `log stream` 라이브 캡처, visionOS/watchOS 는 `simctl spawn … log show --last Ns` (지연 큼).

## 환경 변수

| Var | 효과 |
|---|---|
| `TP_PLATFORM` | `ios`(기본)`\|ipad\|macos\|visionos\|watchos` |
| `TP_SIM` | iOS/iPad Simulator 기기명 (iOS 기본 `iPhone 17 Pro`; `ipad` 분기 기본 `iPad Pro 13-inch (M5)`) |
| `TP_VISION_SIM` / `TP_WATCH_SIM` | visionOS/watchOS Simulator 기기명 |
| `TP_SKIP_RUST=1` | xcframework 재빌드 스킵 (없으면 die) — 빠른 반복 |
| `TP_FORCE_RUST=1` | xcframework 매번 재빌드 (Rust 수정 후) |
| `TP_JSON=1` | smoke 가 마지막 줄에 single-line JSON 결과 emit (`{platform,markers,passed,elapsed_s}`) — 텍스트 출력 불변 |
| `TP_RUST_LOOPBACK=1` | loopback 백엔드를 Bun `local-relay-loopback.ts` 대신 Rust `tp-loopback` 바이너리로 (wire-identical, #5 zero-Bun). `start_loopback` 이 `build_rust_loopback_bin` 으로 빌드해 스폰 |
| `TP_ARTIFACT_DIR` | 스크린샷/비디오 출력 디렉터리 (기본 `/tmp/tp-artifacts`) |
| `TP_UITEST_STRICT=1` | macOS XCUITest TCC 호스트 게이트를 non-fatal SKIP 대신 **hard-fail** 로 (인가된 GUI/CI 러너용; 기본 SKIP 은 `TP_UITEST_SKIP` 마커 emit) |
| `TP_E2E_REAL=1` | 가짜 loopback 대신 **실 `tp` daemon+relay** 로 E2E (격리 XDG 디렉터리, 헤드리스 페어링, M0–M2 범위). **`TP_PLATFORM=ios`/`ipad`/`macos`/`visionos`/`watchos` 전부 지원** (daemon+relay+claude 는 항상 *호스트*에서 돌고, 앱만 sim/네이티브로 뜬다 — 그래서 visionOS/watchOS sim 에서도 실 claude 세션까지 왕복하는 full-path 통합 검증 가능) |
| `TP_E2E_CLAUDE=1` | `TP_E2E_REAL` 의 strict superset — 페어링 *전* **실 `claude -p` PRINT 세션**을 격리 daemon 에 spawn (M0–M4 범위, 실 Stop `last_assistant_message` 렌더). `claude` PATH 필수. 격리 HOME 엔 자격증명이 없으므로 **개발자 본인의** 이미 로그인된 claude 토큰을 재사용한다 (표준 keychain API 로 읽어 먼저 refresh 후 격리 daemon 에 전달 — 머신 밖으로 나가지 않음). **iOS/iPadOS/macOS/visionOS/watchOS 전부 지원** — watchOS 는 여기서 캡 (M5 N/A). **로컬 전용 (절대 CI 아님)** |
| `TP_E2E_CLAUDE_M5=1` | `TP_E2E_CLAUDE` 의 strict superset — 페어링 *전* **실 INTERACTIVE claude 세션**(claude 의 non-interactive `--permission-mode bypassPermissions`, no `-p` — throwaway sandbox 안이라 매-툴 프롬프트가 unattended 실행을 데드락시키지 않게)을 spawn (M0–M5 **전 8마커**). holder 가 claude 의 first-run "이 폴더 신뢰?" 프롬프트에 자기 sandbox 이니 `\r` 로 응답 → claude REPL idle → 앱의 스모크 auto-probe `in.chat` → daemon 이 `\r` 붙여 제출 → claude `UserPromptSubmit` → `TP_INPUT_OK` emit (proof=echo: claude 가 입력을 io 로 렌더; 결정적 제출 증명은 세션 DB `UserPromptSubmit≥1`). 진짜 app→relay→daemon→PTY→claude 입력 경로를 E2E 증명. **iOS/iPadOS/macOS/visionOS 지원 — watchOS 는 입력 경로 부재로 N/A** (watchOS 에서 이 게이트는 claude_e2e 로 collapse, M0–M4 까지만). **로컬 전용** |
| `TP_E2E_CLAUDE_CODING=1` | `TP_E2E_CLAUDE_M5` 의 **sibling** (superset 아님) — `TP_E2E_CLAUDE` 를 imply 하되, M5 의 입력-probe 대신 **holder 가 멀티턴 실코딩을 구동**한다. holder(`--run-claude-coding`)가 격리 sandbox 에서 interactive claude(non-interactive permission mode)를 띄우고 first-run 프롬프트를 `claude::answer_first_run_prompts` 상태머신(신뢰/설정 다이얼로그 감지 → `\r` 응답)으로 처리한 뒤, IPC `input` 프레임으로 **2개 코딩 턴**을 순차 전송한다. 각 턴은 **텍스트(CR 없이) → 별도 `\r`(제출)** 로 보내고(`text\r` 한 프레임은 claude TUI 의 paste 버퍼에 묻혀 제출 안 됨), `UserPromptSubmit` 증가로 등록을 확인하며 warmup keystroke-drop 시 제출을 재전송한다(bounded ≤5): 턴1 = "`tp_qa_marker.txt` 에 `QA-CODING-OK` 작성"(Write 툴), 턴2(턴1 Stop 게이트 후) = "`cat tp_qa_marker.txt && echo BUILD-STEP-DONE` 실행"(Bash 툴). 마커 폴은 M0–M4(첫 Stop)에서 멈추고, 그 다음 `assert_coding_e2e` 가 격리 dir 의 결정적 side-effect 를 검증한다 (모델 텍스트 아님): (1) claude 가 쓴 파일이 디스크에 존재 + body=`QA-CODING-OK`, (2) 세션 DB `UserPromptSubmit≥2` + `Stop≥2`(두 턴이 파이프라인으로 착지+완료), (3) `PostToolUse(Write)` + `PostToolUse(Bash)` 훅 이벤트가 둘 다 파일명을 참조(구조적 이벤트 체크 — ANSI io 스트림 substring 스캔은 타이핑된 명령 ECHO 에 false-positive 나므로 폐기). **앱→relay→daemon→claude 파이프라인이 실제 코딩 턴을 끝까지 운반함**을 증명 — PONG 한 줄이 아니라. 턴 게이팅은 harness 가 assert 하는 동일 세션 DB(`db::count_records`, read-only rusqlite)를 읽는다. **앱의 M5 auto-probe 는 `--tp-no-input-probe` 로 억제**(holder 가 input 을 소유 — probe 가 같은 REPL 에서 턴과 interleave 하면 corruption). **iOS/iPadOS/macOS/visionOS/watchOS 전부 지원** (앱은 trigger 가 아니라 holder 가 구동하므로 watchOS 입력 부재와 무관 — M5 와 직교). **로컬 전용 (claude auth+credits, 절대 CI 아님)**. `TP_E2E_KEEP_DIR=1` 로 격리 dir 보존해 사후 검사 권장 |
| `TP_E2E_WEBPAGE=1` | `TP_E2E_CLAUDE_CODING` 의 **sibling** — 동일한 holder+pipeline 인프라를 쓰되 **완전한 HTML5 정적 웹페이지 빌드**를 구동한다. `TP_E2E_CLAUDE` 를 imply. holder(`--run-claude-webpage`)가 격리 sandbox 에서 interactive claude(non-interactive permission mode)를 띄우고 first-run 신뢰 프롬프트에 `\r` 로 응답한 뒤 **2개 턴**을 순차 전송: 턴1 = `index.html`(또는 `$TP_E2E_WEBPAGE_FILE`)을 완전한 HTML5 문서(DOCTYPE·html·head/title·body/h1·inline `<style>` + CSS)로 Write 툴로 생성 (h1 에 `$TP_E2E_WEBPAGE_MARKER`=`TP-WEBPAGE-OK` 포함), 턴2(턴1 Stop 게이트 후) = `grep -c "<!DOCTYPE html>" <file> && grep -c "<marker>" <file> && echo WEBPAGE-STEP-DONE` 실행(Bash 툴). `assert_webpage_e2e` 가 격리 dir 의 결정적 side-effect 를 검증: (1) 파일이 존재 + DOCTYPE·html·body·/html·marker·style 전부 포함, (2) DB `UserPromptSubmit≥2`+`Stop≥2`, (3) `PostToolUse(Write)`+`PostToolUse(Bash)` 훅 이벤트가 둘 다 파일명 참조. **CODING 과 동시 set 시 WEBPAGE 가 이긴다** — `parse_e2e_gates` 가 `E2E_CLAUDE_CODING` 을 clear. M5 probe 억제(`--tp-no-input-probe`). **iOS/iPadOS/macOS/visionOS/watchOS 전부 지원**. **로컬 전용 (claude auth+credits, 절대 CI 아님)**. `TP_E2E_KEEP_DIR=1` 권장 |
| `TP_E2E_CLAUDE_SID` / `TP_E2E_CLAUDE_CWD` / `TP_E2E_CLAUDE_PROMPT` | claude 세션 sid(기본 `real-smoke-sess`)/cwd(기본 격리 HOME 아래 `work`)/프롬프트(print 모드만; 기본 `Reply with exactly: PONG`) 오버라이드 |
| `TP_E2E_CODING_MARKER` / `TP_E2E_CODING_FILE` | 코딩 E2E(`TP_E2E_CLAUDE_CODING`) 의 파일 body 마커(기본 `QA-CODING-OK`)/파일명(기본 `tp_qa_marker.txt`) 오버라이드. holder 와 `assert_coding_e2e` 가 동일 기본값을 공유 |
| `TP_E2E_WEBPAGE_MARKER` / `TP_E2E_WEBPAGE_FILE` | 웹페이지 E2E(`TP_E2E_WEBPAGE`) 의 h1 마커(기본 `TP-WEBPAGE-OK`)/파일명(기본 `index.html`) 오버라이드. holder(`claude::start_webpage`)와 `assert_webpage_e2e` 가 동일 기본값을 공유 |
| `TP_E2E_PUSH=1` | `TP_E2E_CLAUDE`(print) 의 **sibling** — 실 daemon + 실 claude PRINT 세션을 깔고(세션 DB 가 rec 타깃), 앱이 **합성 push 토큰**을 등록(`--tp-push-smoke`; 토큰은 frontendId 에서 유도한 **64 lowercase hex** — #839 의 APNs 형식 wire guard 가 그 외 형식을 조용히 drop 하므로 marker 문자열 불가)한 뒤 holder(`--emit-push-notification`)가 IPC `rec` 프레임으로 **합성 `Notification` 훅 이벤트**를 주입한다. daemon `PushNotifier` 가 notify-eligible 이벤트(`NOTIFY_EVENTS`={Notification,PermissionRequest,Elicitation}) + tokenCount>0 게이트를 통과 → `relay.push` → relay 가 앱이 소켓에 *살아있으므로* APNs 대신 **in-band `relay.notification`** 으로 전달 → 앱의 **프로덕션** `RelayClient.onNotification` 이 `TP_PUSH_NOTIFY_RECEIVED sid=…` emit. `assert_push_e2e` 가 unified log 에서 그 마커(driven sid)를 폴해 in-band push RECEIVE 경로 전체를 증명. **정직한 범위**: 실 APNs 전달("push" arm)·디바이스 토큰 수신·tap→nav 는 device-gated (aps-environment entitlement + 실기기 + .p8). **iOS/iPadOS/macOS/visionOS/watchOS 전부** (`onNotification` 은 watchOS 에서도 도는 receive/decode 경로). **로컬 전용 (실 claude auth, 절대 CI 아님)** |
| `TP_E2E_PUSH_MESSAGE` | 푸시 E2E(`TP_E2E_PUSH`) 가 주입하는 합성 `Notification` 이벤트의 `message` 필드(기본 `QA push smoke — Claude needs you`) 오버라이드. `buildPushMessage` 가 이를 push title/body 로 사용 |
| `TP_E2E_RUNNER_BIN=1` | **runner 파리티 게이트 (ADR-0003 Stage 4, increment 4)** — 다른 모든 claude 게이트와 **직교**. **#41 PR2b 이후 실 claude 세션은 항상 Rust `tp-runner` 로 구동된다** (Rust holder `tp-e2e-holder` 에 Bun runner fallback 이 없음; harness 가 tp-runner/tp-daemon/tp-e2e-holder 3종을 무조건 빌드+주입) — 이 게이트는 바이너리를 *선택*하지 않고 **pin + positive 증명만** 추가한다. `parse_e2e_gates` 가 `E2E_REAL` 을 imply 하되(격리 daemon 이 rec 타깃) **`E2E_CLAUDE` 는 imply 안 함** — 호출자가 claude 구동 게이트(`TP_E2E_CLAUDE_CODING`/`TP_E2E_WEBPAGE`/`TP_E2E_CLAUDE_M5`)와 **조합**해 증명할 세션을 만든다. `build_rust_runner_bin` 이 `cargo build --release --bin tp-runner`(rustup-shim-safe TC_BIN PATH) 후 release→debug fallback 으로 바이너리를 찾고(빌드 실패 시 loud die), `start_real_daemon_relay` 가 `TP_RUNNER_BIN="$REAL_RUNNER_BIN"` 을 holder(Rust `tp-e2e-holder`) env 로 주입한다 — holder 가 이 세션들을 **standalone `tp-runner` 프로세스**로 직접 spawn 하므로(daemon 의 `SessionManager` 경유 아님) holder 의 `spawn::resolve_bin` 이 `TP_RUNNER_BIN`(빈 값=unset)을 읽어 그 경로를 쓴다(env 미설정 시 holder 바이너리 옆 sibling probe, 그것도 없으면 die — Bun 경로 자체가 없음). `assert_runner_parity`(claude-agnostic assert 뒤 실행)가 **(1) holder 로그**(`$REAL_RP_OUT`)에서 `RUNNER_PARITY_BIN=<REAL_RUNNER_BIN>` 라인(TP_RUNNER_BIN 이 비어있지 않을 때 holder 가 stdout contract 로 emit)을 확인해 주입한 바이너리가 실제로 세션을 서빙했음을 **positive 증명**(env 미전파/sibling-fallback false-pass 방지) + **(2) 세션 DB `kind='io'` rows≥1** 구조 체크(io 바이너리 사이드카가 load-bearing 파리티 surface — 삭제된 `runner-parity.test.ts` 가 fake claude 로 byte-exact 를 증명했었고, 여기선 실 claude 로 non-empty 증명). **iOS/iPadOS/macOS/visionOS/watchOS 전부 지원**. **로컬 전용 (실 claude auth, 절대 CI 아님)**. `TP_E2E_KEEP_DIR=1` 권장. **default flip 완료 (task #4)** — Rust `tp-daemon` 이 이제 세션마다 `tp_proto::locate_tp_runner()` 로 Rust `tp-runner` 를 spawn 하고(`rust/tp-daemon/src/session/manager.rs` `default_runner_command`), tp-cli 도 같은 resolver 를 쓴다. 이 게이트는 그 flip 을 *증명*하는 pre-flip 파리티 도구였고 flip 후에도 회귀 가드로 유지된다. **소크 커버리지 갭**: 이 holder(`tp-e2e-holder`)는 runner 를 **standalone spawn** 하지 Rust daemon 의 `SessionManager.spawn_runner`(manager.rs `default_runner_command`) 를 경유하지 않는다 — 그래서 소크는 Rust runner 파리티는 증명하나 *daemon-이-runner-를-고르는* 경로(manager.rs)는 커버 안 함(dogfood + 수동 사용이 커버). cf. `packages/daemon/src/session/runner-parity.test.ts`(결정론적 fake-claude 파리티, **PR4 에서 삭제됨** — 이 로컬 게이트가 이제 runner-parity 의 주 증거) + `scripts/runner-parity-real-claude.ts`(`TP_RUNNER_PARITY_REAL_CLAUDE=1` 로컬 프레임 diff) |
| `TP_E2E_DAEMON_BIN=1` | **daemon 파리티 게이트 (ADR-0003 Phase 4, flip-prep A2)** — `TP_E2E_RUNNER_BIN` 의 **daemon 쌍둥이**, 역시 모든 claude 게이트와 **직교**. **#41 PR2b 이후 격리 E2E daemon 은 항상 Rust `tp-daemon` 이다** (Rust holder 에 Bun daemon fallback 없음) — 이 게이트는 *선택*이 아니라 **pin + positive 증명**만 추가한다. `parse_e2e_gates` 가 `E2E_REAL` 만 imply(격리 daemon 필요), `E2E_CLAUDE` 는 안 함 — CODING/WEBPAGE/M5 와 **조합**해 exercise 할 세션을 만든다. `TP_E2E_RUNNER_BIN` 과도 조합 가능. `build_rust_daemon_bin` 이 `cargo build --release --bin tp-daemon`(rustup-shim-safe TC_BIN PATH) 후 release→debug fallback(빌드 실패 시 loud die), `start_real_daemon_relay` 가 `TP_DAEMON_BIN="$REAL_DAEMON_BIN"` 을 holder(Rust `tp-e2e-holder`) env 로 주입한다 — **holder 가 daemon 을 직접 spawn** 하므로(`tp-e2e-holder` 의 단일 spawn 사이트 `spawn::spawn_daemon`, `ensureDaemon` 경유 아님) holder 의 `spawn::resolve_bin` 이 `TP_DAEMON_BIN`(빈 값=unset)을 읽어 그 경로로 `[tp-daemon]`(서브커맨드 없음 — Rust bin 이 곧 daemon) 을 exec 한다. **positive 증명이 PRIMARY**: daemon 치환은 wire/store 에 고유 fingerprint 를 안 남긴다(파리티 전제) → runner 처럼 io-row 를 독립 2차 체크로 못 씀. `assert_daemon_parity`(claude-agnostic assert 뒤)가 **(1) holder 로그에서 `DAEMON_PARITY_BIN=<REAL_DAEMON_BIN>` 라인**(TP_DAEMON_BIN 비어있지 않을 때 stdout contract 로 emit)을 확인해 주입한 바이너리가 실제로 서빙했음을 증명(env 미전파 방지 — 이게 유일한 판별자) + **(2) 격리 store DB `records≥1`** 구조 체크(치환 daemon 이 세션을 실제 영속했는지). **iOS/iPadOS/macOS/visionOS/watchOS 전부 지원**. **로컬 전용 (실 claude auth, 절대 CI 아님)**. `TP_E2E_KEEP_DIR=1` 권장. **default flip 완료 (task #4)** — Rust `tp` 의 background auto-spawn(`ensure_daemon.rs`)과 foreground/OS-service trampoline(`commands/daemon.rs::start`) 둘 다 이제 `locate_tp_daemon()` 로 Rust `tp-daemon` 을 띄운다(persistent 프로덕션 daemon 이 Rust). 이 게이트는 그 flip 을 *증명*한 pre-flip 파리티 도구였고 flip 후에도 회귀 가드로 유지된다. cf. `packages/daemon/src/**/*-rust-parity.test.ts`(5 differential 게이트, **PR4 에서 삭제됨** — 이 로컬 게이트 + `cargo test -p tp-daemon` 가 이제 daemon-parity 의 주 증거) |

## 서브커맨드

```bash
scripts/ios.sh rust     # TpCore.xcframework (7 슬라이스) + UniFFI 바인딩
scripts/ios.sh gen      # xcodegen generate
scripts/ios.sh boot     # Simulator 부팅 (sim 전용)
scripts/ios.sh build    # xcodebuild
scripts/ios.sh smoke    # 빌드+설치+런치+마커 검증 (TP_PLATFORM 분기)
scripts/ios.sh uitest   # XCUITest UI-level E2E (iOS/iPad/macOS 풀, visionOS 부분, watchOS 미지원)
scripts/ios.sh uitest-all  # XCUITest UI E2E 전 플랫폼 매트릭스 (PASS/SKIP/FAIL 표; watchOS=자동SKIP[XCUIApplication 없음], macOS=TCC미인가시SKIP; exit=FAIL 있으면 nonzero)
scripts/ios.sh test     # XCTest (iOS Simulator)
scripts/ios.sh all      # 5플랫폼 smoke 매트릭스 (행=플랫폼, 종료코드=worst)
scripts/ios.sh archive  # TestFlight: TP_PLATFORM 별 Release archive → 서명 → App Store .ipa export (ADR-0004 §7; 실 Distribution cert 필요)
```

> **`archive` 는 검증이 아니라 *배포* 경로** — 마커/UI E2E 와 다른 레이어다. **ADR-0004 Amendment 1
> 이후 `TP_PLATFORM` 으로 분기**(ios/ipad→`generic/platform=iOS` `.ipa`, macos→`generic/platform=macOS`
> MAS `.pkg`, visionos→`generic/platform=visionOS` `.ipa`) — 3개 플랫폼 job(iOS/macOS/visionOS) + watch
> 동반. **`TP_PLATFORM=watchos archive` 는 `die`** (ADR-0004 Amendment 2, #123) — watch 는 별도 archive
> 없이 iOS `.ipa` 에 컴패니언으로 탑승(`Payload/Teleprompter.app/Watch/`). `TP_PLATFORM=watchos` 는
> **smoke 전용**(watchOS Simulator, 7마커 독립 런타임 증명) — 배포 경로로 쓰지 않는다. 실 Apple
> Distribution 인증서 + 플랫폼별 provisioning profile(iOS job 은 iOS 앱 profile + 임베드 watch 앱 profile
> `IOS_WATCH_PROVISIONING_PROFILE_BASE64` 2개) + `TP_DEVELOPMENT_TEAM` 필수. CI 자동화는
> `.github/workflows/testflight.yml`(`v*` 태그 push, 플랫폼별 job). 시크릿/ASC 레코드 셋업 체크리스트 =
> `docs/testflight-setup.md`; 상세는 `.claude/rules/ci-workflows.md` → TestFlight + `docs/adr/0004-*`.
>
> **서명은 archive·export 두 단계 모두 매핑이 필요하다**: archive 는 `project.yml` 의
> `[config=Release][sdk=…]` specifier 가, export(`xcodebuild -exportArchive`)는 `cmd_archive` 가
> `ARCHIVE_PROFILE_MAP`+`$TP_DEVELOPMENT_TEAM` 으로 temp `ExportOptions.resolved.plist` 에 주입하는
> `provisioningProfiles` dict(+`teamID`)가 담당한다 (manual 서명은 keychain bundle-id 자동매칭을 안 함).
> iOS export 매핑은 메인+임베드 watch 2개, macOS/visionOS 는 1개. 상세 = `ci-workflows.md` TestFlight.

xcframework 는 **7 슬라이스** (`ios-arm64`, `ios-arm64_x86_64-simulator`, `macos-arm64_x86_64`,
`xros-arm64`, `xros-arm64-simulator`, `watchos-arm64_arm64_32`, `watchos-arm64-simulator`).
watchOS 실기기 슬라이스는 arm64 + arm64_32 fat (Series 4–8/SE = arm64_32; arm64_32 는 tier-3
→ nightly `-Z build-std`). `plutil -p rust/target/TpCore.xcframework/Info.plist | grep
LibraryIdentifier` 로 7개 확인.

## UI E2E (`cmd_uitest`, XCUITest)

> **5-플랫폼 UI E2E 의 현실적 최선안 = XCUITest 단독 + `uitest-all` 매트릭스.** 시장 조사(2026) 결론:
> **5개 Apple 플랫폼 전부를 커버하는 단일 서드파티 프레임워크는 없다** — Maestro/Appium/KIF/EarlGrey 는
> 전부 watchOS·visionOS 미지원이고 Detox 는 RN 전용(SwiftUI 부적용). **XCUITest 만 유일하게 5개에 걸치되**
> watchOS 는 `XCUIApplication` 자체가 없고(Apple hard limit) visionOS 는 2D window 요소만(spatial gesture
> 자동화 불가). 그래서 외부 툴 도입은 순손해(iOS/iPad 만 얻고 유지비 증가)이고, 기존 XCUITest 자산을
> `uitest-all` 매트릭스로 묶는 것이 달성 가능한 최선이다. **로컬 전용** (CI 미탑재 — macos-26 러너 비용/시간
> 때문에 의도적으로 로컬 수동 실행; 풀 매트릭스 `uitest-all` 또는 단일 `TP_PLATFORM=<p> uitest`).
>
> **`cmd_uitest_all`** (`scripts/ios.sh uitest-all`) 은 `cmd_all`(smoke 매트릭스)의 쌍둥이다: 지원되는 전
> 플랫폼에서 `cmd_uitest` 를 순차 실행하고 **PASS/SKIP/FAIL 3-way 매트릭스**를 렌더한다. watchOS 는
> 서브셸 없이 **SKIP row 를 합성**(단일 `TP_PLATFORM=watchos uitest` 는 여전히 die — 불가능한 걸 명시
> 요청하면 에러). macOS TCC 게이트는 SKIP(실패 아님), `TP_UITEST_STRICT=1` 이면 FAIL. 종료코드는 FAIL 이
> 하나라도 있을 때만 nonzero(SKIP 은 통과). 서브셸 결과 수집은 `TP_UITEST_JSON=1`(smoke 의 `TP_JSON` 과
> 별도 네임스페이스) 이 EXIT trap `tp_uitest_emit` 로 stdout 에 JSON 한 줄을 뱉고 부모가 `2>&3 | tail -n1`
> 로 잡는다 — `cmd_all` 과 동일 fd 기법. **주의**: `cmd_uitest` 의 xcodebuild 파이프는 `xcbeautify_or_cat
> >&2`(archive 선례와 동일)로 로그를 stderr 로 보내야 stdout 이 JSON 전용이 된다 — 안 그러면 xcodebuild
> stdout 이 새어 `tail -n1` 이 JSON 대신 빌드 로그 끝줄을 잡는다(실측으로 확인·수정된 함정).

`TeleprompterUITests` (`ios/UITests/SmokeUITests.swift`) = `bundle.ui-testing` 타깃. **마커가
바이트 라운드트립을 증명한다면, 이건 SwiftUI 가 그 복호 데이터를 실제 a11y 트리로 렌더함을 증명**한다:
`--tp-smoke-url` 골든 링크로 런치(마커 smoke 와 동일 loopback 경로) → `session-<sid>` row tap →
`session-pane-picker` → `"Claude: smoke ok"` 버블(loopback Stop `last_assistant_message`) →
Terminal pane → `terminal-output`. 스크린샷을 `XCTAttachment` 으로 첨부.

**두 번째 테스트 (macOS 전용, `testMacPerSessionWindowAndNoDuplicateMain`, `#if os(macOS)`)** 는
메신저-스타일 per-session 창 팝아웃 + main-window single-instance 를 회귀 가드한다 (main `WindowGroup`
이 value-less 라 중복 main 창이 두 경로로 생길 수 있는 버그의 fix 를 잠금): (1) 신선 런치 =
창 정확히 1개 (main 복제·복원 없음), (2) File 메뉴에 auto "New Window" **부재** + MacCommands 의 "New
Pairing…" **존재** (`.commandsRemoved()` 가 자동 커맨드만 제거, 우리 메뉴는 유지), (3) 세션 row
`.rightClick()` → `session-open-window-<sid>` context-menu 클릭 → 창 2개 (value-carrying
`WindowGroup(id:"session", for:String.self)` 팝아웃 동작). iOS/visionOS 엔 메뉴바/멀티윈도우 File 메뉴
개념이 없어 macOS 한정. `.rightClick()`/`menuBars`/`windows.count` 는 macOS XCUIApplication 에만 존재.
**단, 이 GUI 테스트는 호스트 TCC 미인가 시 SKIP 이라(위 macOS 게이트) 회귀가 이 SKIP 뒤로 샜다** (Dave 가
신선 런치에서 11개 "Sessions" 창을 맞은 버그 — File>New Window 클론이 아니라 **AppKit secure-state
restoration** 이 지난 종료 시 열려있던 창들을 재생성한 것). 실제 fix 는 `.restorationBehavior(.disabled)`
(main WindowGroup, macOS 15+)이고, 그 결정론적 회귀 가드는 GUI 없는 **headless `TP_MAC_WINDOW_COUNT`
smoke 마커**다 (아래 참조) — restoration 은 launch 시 자동 발생해 어떤 메뉴 커맨드보다 먼저 일어나므로
File-메뉴 어서션(2)로는 못 잡는다.

> **창 모델 (메인 창 vs 세션 서브 창) — macOS + iPadOS.** 세션별 pop-out 은 이제 macOS 뿐 아니라
> **iPadOS(regular width)**에도 있다: 메인 창 = `SidebarRootView`(NavigationSplitView, Sessions/Daemons/
> Settings — macOS 와 iPad-regular 가 공유하는 플랫폼-중립 shell; iPhone 은 compact width 라 기존 하단
> TabView 유지, `RootView` 가 `horizontalSizeClass` 로 런타임 분기), 서브 창 = 세션 하나만 담은
> `WindowGroup(id:"session", for:String.self)` → `SessionWindowView`. iPad 진입 = 세션 row **롱프레스**
> context-menu "Open in New Window"(`session-open-window-<sid>`) 또는 세션 상세 툴바의 pop-out 버튼
> (`session-popout-<sid>`); 둘 다 `openWindow(id:"session", value: sid)` 를 부르고 `canPopOut`
> (`supportsMultipleWindows && horizontalSizeClass == .regular`, macOS 는 항상 true)로 게이트돼 **iPhone
> 엔 안 뜬다**. **멀티신 활성화** = `project.yml` `UIApplicationSupportsMultipleScenes: true`(iPad
> WindowGroup 이 2번째 scene 을 실제로 spawn 하게; 앱은 openWindow 호출부 가드로 iPhone 에서 절대
> 프로그램적 2번째 창을 안 연다). `testMacPerSessionWindowAndNoDuplicateMain` 은 여전히 macOS 전용
> (`.rightClick`/`.menuBars`/`.windows.count` 가 macOS XCUIApplication 에만 존재). **iPad 등가 UI 어서션은
> 이제 있다** — `testSessionRenderPaneSwitchAndPopOut`(`#if os(iOS)` 헬퍼 `assertPadPopOut`)이 세션 상세
> 툴바 pop-out(`session-popout-<sid>`)을 탭해 서브 창을 열고, 서브 창 루트에만 존재하는
> `session-window-<sid>`(SessionWindowView) 의 등장으로 2번째 UIWindowScene 이 실제로 materialize 됐음을
> 어서션한다(iOS 는 macOS 처럼 `windows.count` 로 scene 을 열거하지 못하므로 sub-window 전용 identifier
> 로 증명). iPhone(compact) 브랜치는 `session-popout`/`session-open-window` 부재를 negative-guard 하고,
> 리스트로 돌아가기 위해 nav back 버튼을 탭하기 **전에 `.isHittable` 을 어서션**한다(`.exists` 아님 —
> off-screen 요소도 `.exists` 는 true). 이 가드는 **iPhone frame-floor soft-lock 회귀**를 조기에 잡는다:
> `#908` 이 iPadOS 26 windowed-narrow-launch 를 sidebar 로 밀어올리려 `TeleprompterApp.swift` 의
> 메인 `WindowGroup` 콘텐츠에 건 `.frame(minWidth: 850, minHeight: 600)`(+ scene `.contentMinSize`)가
> `#elseif os(iOS)` 라 iPhone 에도 적용돼, 402pt 고정 창 안에서 (올바르게 compact 인) TabView 서브트리를
> 850pt 로 강제 → SwiftUI 가 중앙정렬해 콘텐츠 origin 을 `x=(402-850)/2=-224` 로 밀고 nav back 버튼을
> 화면 밖으로 보내 **실제 네비게이션 soft-lock**(테스트 아티팩트 아님, 실기 iPhone 유저도 피해)을 냈다.
> Fix = frame floor 와 `.contentMinSize` 를 **`UIDevice.current.userInterfaceIdiom == .pad` 로 게이트**
> (idiom 은 static 하드웨어 속성 — mid-resolution `horizontalSizeClass` trait 의 순환을 피함; iPad 만
> floor 적용 = `#908` 의 원래 의도). iPad/visionOS 는 구조적으로 면제(iPad 는 850 을 실제로 원하고
> visionOS 는 자기 `#elseif os(visionOS)` TabView 브랜치라 floor 미적용)라 회귀 없음. 별개로, SwiftTerm
> 기본 `.blinkBlock` 커서가 도는 무한 `UIView.animate([.autoreverse,.repeat])`(iOSCaretView)는 XCUITest
> 의 app-idle 대기를 영구히 막아 `.tap()` 을 60s 로 hang 시키므로, smoke 모드에서 `setCursorStyle(.steadyBlock)`
> 로 억제한다(`SwiftTermView._make`, `RelayClient.isSmokeMode` 게이트 — 프로덕션 무영향).
> **단일-launch 설계 (isolation 핵심)**: 세션 렌더·pane 스위치·pop-out 을 **한 번의 `app.launch()`** 에서
> 어서션한다 — iPad 는 `UIApplicationSupportsMultipleScenes: true` 라 열린 서브 창의 UISceneSession 을
> UIKit 이 persist 하고 그게 프로세스 relaunch 를 살아남아(XCUIApplication.launch 는 프로세스만 죽이고
> scene-session 상태는 안 지움), **두 테스트 메서드가 각각 launch 하면** pop-out 메서드가 연 서브 창이 다른
> 메서드에서 frontmost 로 RESTORE 돼 세션 목록을 가린다(XCUITest 엔 driver-side scene-teardown API 가 없음).
> 단일 launch = 프로세스 하나 = 메서드 간 restore 불가로 이 leak 을 구조적으로 제거한다. 하니스는 추가로
> 매 `uitest` 런 전 `simctl uninstall` 로 런 간 잔류도 지운다. (이 설계 전에는 `--tp-uitest-reset-scenes`
> launch-arg + in-app `requestSceneSessionDestruction` self-destruct 뷰로 leftover 를 사후 정리하려 했으나,
> 서브 창을 여는 테스트와 정리하는 테스트가 launch-arg 로 상호배타라 순서 의존 + main-window `.onAppear`
> 딥링크 주입이 restore 된 서브 창에 preempt 되는 취약점이 있어 폐기했다.) iPad 커버리지는 이 UI 어서션 +
> `TP_PLATFORM=ipad smoke`(8마커, split-view/sidebar 부팅+렌더)가 함께 담당.
> **알려진 한계**: nav 인텐트(⌘[/⌘] step, ⌃⌘C/⌘T pane)는 `AppNavigationModel.shared` 싱글톤이라 열린
> 세션 창 전부가 공유 — macOS 에 이미 존재하던 특성을 iPad 로 parity 이식한 것(창별 격리는 out-of-scope).
>
> **메인 창 중복 방지 = 세 개의 직교 lever (macOS).** value-less 메인 `WindowGroup` 이 복제되는 경로가
> 셋이고 각각 별개 modifier 로 막는다: (1) **`.commandsRemoved()`** — SwiftUI 자동 File>New Window
> *커맨드* 제거(사용자가 명시적으로 새 창을 여는 클론). (2) **`.restorationBehavior(.disabled)`**
> (macOS 15+) — **AppKit secure-state restoration** 이 지난 종료 시 열려있던 창들을 launch 때 자동
> 재생성하는 걸 차단(Dave 가 v1.0 프로덕션 sandboxed 앱에서 11개 "Sessions" 창을 맞은 실제 원인 —
> restoration 은 어떤 커맨드보다 먼저 launch 시 자동 발생해 (1)로는 못 막는다). `.disabled` 는
> iOS/tvOS/watchOS 에 `@available`-unavailable 이라 **반드시 `#if os(macOS)`** 안에. (3) **세션 pop-out 은
> 별개 value-carrying `WindowGroup(id:"session")`** 이라 위 둘의 영향을 안 받고 `openWindow(...)` live 호출로만
> 열린다. **sandbox 뉘앙스 (재현 함정)**: 프로덕션/TestFlight 빌드는 sandboxed 라 saved-state 를 container
> (`~/Library/Containers/dev.tpmt.app/Data/Library/Saved Application State/`)에 남겨 restoration 이 일어나지만,
> **로컬 `scripts/ios.sh` macOS 빌드는 `CODE_SIGN_ENTITLEMENTS=""` 로 non-sandboxed** 라 saved-state 를 아예
> 안 남긴다 → dogfood 하니스에선 restoration 이 구조적으로 안 일어나(창 항상 1개), (2)의 필요성을 마커로 실증
> 불가. 그래도 **headless `TP_MAC_WINDOW_COUNT` 마커** (아래)가 non-sandboxed smoke 에서 n=1 을 어서션해
> **(1)의 회귀 + 미래 코드가 실수로 프로그램적 멀티-open 하는 회귀**를 GUI 없이 가드한다.
>
> **headless `TP_MAC_WINDOW_COUNT` 마커.** 앱이 macOS + smoke 모드에서 launch ~1.5s 뒤
> `NSApplication.shared.windows` 중 visible+titled top-level 창 수를 `TP_MAC_WINDOW_COUNT n=<count>` 로 emit
> (`RelayClient.isSmokeMode` 게이트 — 일반 런은 no-op). `cmd_smoke_macos` 의 loopback 경로가 8마커 뒤
> **n=1 을 어서션**(>1 이면 hard-die). default 8/7 마커 셋엔 없음(별도 어서션). TCC 미인가 호스트에서 SKIP
> 되는 GUI XCUITest(`testMacPerSessionWindowAndNoDuplicateMain`)의 창-1개 불변식을 결정론·비-GUI 로 대체하는
> 회귀 가드 — 그 GUI SKIP 뒤로 회귀가 샜던 게 이 마커를 도입한 이유다.

- **링크 주입**: 하니스가 loopback 띄우고 `smoke_pair_link` 골든 링크 만들어 `TEST_RUNNER_TP_SMOKE_URL` /
  `TEST_RUNNER_TP_SMOKE_SID` **env** 로 넘긴다 (xcodebuild 가 `TEST_RUNNER_` 접두어를 떼고 runner
  ProcessInfo.environment 에 주입 — KEY=VALUE 빌드세팅 인자로는 runner 에 **안 닿는다**).
- **`@MainActor` 필수**: 앱이 Swift 6 strict concurrency(`-swift-version 6`)로 빌드되므로 XCUITest
  의 `XCUIApplication`/element API(전부 `@MainActor`)를 nonisolated 테스트 본문에서 호출하면 컴파일
  에러. 테스트 메서드에 `@MainActor` 를 붙인다.
- **combined element**: assistant 버블은 `.accessibilityElement(children: .combine)` 이라 XCUITest 가
  `.staticText` 아닌 **combined group(.other)** 로 노출 → `app.descendants(matching: .any)` 로 label
  쿼리(staticTexts 로 제한하면 못 찾음).
- **전용 스킴**: `cmd_uitest` 는 `TeleprompterUITests` 스킴(test action = UI 테스트만)을 쓴다. 메인
  `Teleprompter` 스킴은 iOS-host unit-test 타깃도 빌드하는데 그 TEST_HOST 가 iOS .app 레이아웃에 고정돼
  macOS destination 빌드를 깬다. `TeleprompterTests`(unit)는 `supportedDestinations: [iOS, macOS]`,
  **`TeleprompterUITests`(UI)는 `[iOS, macOS, visionOS]`** — visionOS 는 `XCUIApplication` 이 실존해
  UI-test runner .app 이 xrsimulator SDK 로 빌드 가능하다(watchOS 와 달리). visionOS 를 빼면
  `Debug-xrsimulator` 에 `…-Runner.app` 이 생성 안 돼 `TP_PLATFORM=visionos uitest` 가 "no file found"
  로 die 한다 (uitest-all 첫 실행이 폭로한 하니스 결함 — 문서/코드는 "visionOS 부분 지원"을 주장했지만
  타깃이 visionOS 목적지를 못 만들어 실제론 한 번도 작동 안 함; 이 fix 로 실제 PASS 로 전환).
- **macOS 호스트 게이트**: macOS native 는 XCUITest runner init 가 TCC/LocalAuthentication 인증 세션을
  요구한다. 비대화형/미인가 세션에선 `Failed to initialize for UI testing … System authentication is
  running`(LocalAuthentication Code=-4)로 실패 → `cmd_uitest` 가 이 시그니처를 감지해 **SKIP(exit 0)**
  처리(빌드+서명은 성공, 동일 코드가 iOS Simulator 에선 통과). 전체 macOS UI E2E 는 GUI 로그인 세션 +
  System Settings → Privacy & Security → Accessibility/Automation 인가 후 재실행.
- **macOS deep-link 라우팅 함정**: `cmd_smoke_macos` 는 dev build 를 `open -gn "$app" --args --tp-smoke`
  로 띄운 뒤 페어링 `tp://` 링크를 **반드시 `open -a "$app" "$link"`** 로 그 dev build 에 명시 라우팅한다.
  bare `open "$link"` 를 쓰면 LaunchServices 가 `tp://` 핸들러를 **우선순위**로 고르는데, `/Applications`
  에 설치된 프로덕션 빌드(릴리즈/TestFlight 로 깐 것)가 DerivedData 경로보다 우선순위가 높아 deep link 를
  **가로챈다**. 그 프로덕션 인스턴스엔 `--tp-smoke` 가 없어 `RelayClient.isSmokeMode` 가 false →
  M5 auto-probe 미발사 → **M0–M4 는 (엉뚱한 인스턴스에서) 통과하지만 M5 만 결정론적으로 실패**한다
  (`lsregister -f` 로도 `/Applications` 우선순위를 못 이긴다). iOS/visionOS 는 `simctl launch` 로 특정
  앱에 직접 주입하므로 이 함정이 없다 — macOS native 경로 고유.
- macOS entitlements: native 빌드는 `CODE_SIGN_ENTITLEMENTS=""` 로 keychain-access-groups 제거(ad-hoc
  서명 — cmd_build macOS 와 동일).

## 실 daemon E2E (`TP_E2E_REAL=1`, iOS/iPadOS Simulator · macOS 네이티브 · visionOS Simulator · watchOS Simulator)

가짜 loopback 대신 **진짜 relay + Rust `tp-daemon`** 을 띄워 헤드리스 페어링한다.
**Rust `tp-e2e-holder`**(`rust/tp-e2e-holder`, **#41 PR2b** — 구 Bun `scripts/real-daemon-pair.ts`
대체; 그 TS 파일은 `rust-relay-e2e.ts` 의존 때문에 PR6 까지 dead 로 tree 에 남음) 가 (1) 빈 포트에
**실 `tp_relay::RelayServer`** 를 in-process 로 띄우고(`--relay-url` 로 외부 relay 도 가능), (2) **격리
XDG 디렉터리**(`XDG_RUNTIME_DIR`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `HOME` 을 `mktemp -d` 아래로 —
dogfood daemon 의 socket/store 와 절대 충돌 안 함)로 Rust `tp-daemon` 서브프로세스를 spawn, (3) daemon IPC
로 `pair.begin` → `pair.begin.ok.qrString` 읽어 **`REAL_PAIR_URL=tp://p?d=…`** 를
stdout 으로 emit (그 뒤 relay+daemon 을 SIGTERM 까지 살려둠; daemon id 는 그 직전에
`pairing begun (id …, daemon …)` stdout contract 라인으로 — Bun holder 시절 stderr race 제거).
`start_real_daemon_relay()` 가 tp-runner/tp-daemon/tp-e2e-holder 3종을 **무조건 빌드+주입**한 뒤 이 줄을
grep 해 링크 + 실 daemonId 를 잡고, 각 플랫폼 smoke 함수가 그 링크를 주입(iOS/visionOS/watchOS=
`--tp-smoke-url`, macOS=`open -a "$app" "$link"`) + `$SMOKE_DAEMON_ID` 를 실 daemonId 로 재설정한다
(did=/daemon= 어서션 매칭).

> **공유 배선 (4 플랫폼 동일)**: `parse_e2e_gates`(TP_E2E_* → `E2E_REAL`/`E2E_CLAUDE`/`E2E_CLAUDE_M5`/`E2E_CLAUDE_CODING` 게이트;
> `set -e` 아래에서 마지막 `[ … ] && …` 단락평가가 exit 1 을 내 caller 를 abort 시키므로 **반드시
> `return 0` 으로 닫는다**) + `reuse_operator_claude_token`(claude 모드 시 개발자 본인의 keychain OAuth 토큰을 표준 API 로 읽어 재사용) +
> `setup_real_link`(`start_real_daemon_relay` 호출 후 `$SMOKE_DAEMON_ID`/`$SMOKE_SESSION_ID` 재설정;
> **command-substitution subshell 에서 호출 금지** — 전역 재설정이 부모로 전파 안 됨, 반환 후 `$REAL_PAIR_LINK`
> 를 직접 읽는다)을 `cmd_smoke_ios`/`cmd_smoke_macos`/`cmd_smoke_visionos` 가 똑같이 쓴다. 플랫폼별 차이는
> 앱 런치 방식 + 마커 스크랩 로그면(iOS/visionOS=Simulator unified log, macOS=호스트 `log stream`)뿐.

> **정직한 범위 — M0–M2 만**: 실 daemon E2E 는 boot + tp-core FFI + pairing ingest + **실 relay 에 대한
> frontend-auth**(genuine daemon→relay→app 인증 파이프라인)를 결정론적으로 증명한다. **M3(kx)/M4/M5 는
> 범위 밖**: 실 daemon 은 pre-seed 세션이 없어 빈 hello 를 보내고(`sessions=0`), 실 daemon 의 kx-pubkey
> 브로드캐스트가 프론트엔드 자체 kx 완료와 레이스해 `relay.frame before kx — dropping` 이 날 수 있다(loopback
> 은 `LOOPBACK_READY` 시퀀싱으로 이를 피함). 전체 M3–M5 검증은 loopback 모드(8마커) 가 담당. 실 M4/M5 를
> 실 daemon 으로 보려면 spawn 된 세션 + PATH 의 `claude` 가 필요.
>
> **아키텍처 불변식 전부 유지**: app→relay 전용, daemon outbound-WS only(실 daemon 이 `relay.register` 로
> self-register → relay 의 유일 클라이언트), relay 는 이미 암호화된 프레임만 중계(평문 미접근).

## 실 claude PRINT E2E (`TP_E2E_CLAUDE=1`, iOS/iPadOS Sim · macOS 네이티브 · visionOS Sim · watchOS Sim) — 헤드라인 dogfood 증명 (M0–M4)

`TP_E2E_REAL` 의 **strict superset** (입력 왕복 M5 까지는 아래 `TP_E2E_CLAUDE_M5` 섹션 참조).
`tp-e2e-holder` 가 `--run-claude` 로 **실 `claude -p`
세션**을 같은 격리 daemon 에 **페어링 *전*** spawn 한다 → 앱이 hello 에서 그 세션을 받아 auto-attach →
**실 Stop 훅의 `last_assistant_message` 를 Chat 에 렌더**한다. 이게 M3'(`TP_FRAME_OK sessions=1`) +
M4(`TP_SESSION_OK events>=1`)를 만족시키며, "실 페어링 → 실 격리 daemon → 실 claude → 실 Stop → 복호 →
ChatItem 렌더" 전 체인을 증명한다 (loopback 의 합성 Stop 이 아니라 진짜 모델 응답).

- **세션 생성 경로 = standalone `tp-runner --socket-path <격리 socket>`** (NOT `session.create`).
  `session.create` 는 relay control 메시지라 `claudeArgs`/`env` 필드가 없어서 claude 인자를 못 넘긴다.
  holder 의 `claude::start_print`(`spawn::spawn_runner`) 가 `tp_proto::socket_path()` 로 격리 daemon
  socket 을 잡아 직접 Rust `tp-runner` 를 spawn 한다 — 그 Runner 가 hello → daemon 이 세션 등록(+ store
  영속) + relay 로 `state` 브로드캐스트.
- **세션 spawn 은 페어링 *전* (race-free 시퀀싱)**: print 모드 `claude -p` 는 ~3s 안에 Stop 후 **종료**한다.
  세션을 `pair.completed` *뒤*에 spawn 하면 앱의 첫 hello 가 빈 store 를 봐서 `sessions=0` 이 되고(M3' fail),
  print 세션은 live `state` 브로드캐스트가 닿기 전에 이미 죽어버린다. 그래서 `tp-e2e-holder` 는 daemon
  IPC 소켓이 준비되는 즉시(`wait_for_socket` 직후, step 3b) claude 를 spawn 해 페어링과 **동시 진행**시킨다 —
  세션이 store 에 등록된 뒤 앱이 페어링(~30s)하므로 hello 가 `sessions=1`(stopped 세션도 세션 목록에
  포함, 무필터)을 반환한다. 페어링은 세션에 의존하지 않고 `tp-runner` 는 relay 없이 daemon IPC 로
  직접 붙으므로 둘은 독립이다.
- **요구된 production fix 2 건 (이 E2E 가 처음 노출)**: (1) **daemon kx 재브로드캐스트** —
  `relay-client.ts handleKxFrame` 이 frontend 의 first-join 시 daemon pubkey 를 재브로드캐스트(릴레이는 kx
  프레임을 캐시하지 않아 auth-time 브로드캐스트를 놓친 late-join 앱이 영영 키를 못 받던 레이스; M3 unblock).
  (2) **app subscribe-on-broadcast** — `RelayClient.swift onState` 가 resume 전에 `relay.sub` 를 보냄
  (브로드캐스트로 발견한 세션에 sub 없이 resume 하면 릴레이가 batch/rec 를 drop → chat item 0 → M4 영영 fail).
- **Auth = 개발자 본인의 keychain 토큰 재사용 (refresh 후)**: 격리 HOME 엔 자격증명이 없으므로, `cmd_smoke_ios`
  가 **개발자 본인의** 이미 로그인된 claude OAuth 토큰(매일 쓰는 그 로그인)을 읽어 `CLAUDE_CODE_OAUTH_TOKEN`
  env 로 격리 daemon 의 runner 에 전달한다(`PtyBun.spawn` 은 자체 `env:` 가 없어 그대로 상속). 토큰은 머신을
  떠나지 않는다. **재사용 *전* 토큰을 refresh** 한다 — keychain access token 은 ~8h 만에
  만료되고, stale 토큰이면 세션이 REPL 까지 가서 프롬프트 제출까지 되지만 API 호출이 401 → `StopFailure`(Stop
  아님) → M4/M5 fail 한다. refresh = 실 config(`CLAUDE_CONFIG_DIR`)로 `claude -p "Reply with exactly: OK"`
  를 한 번 돌리면 (저장된 refresh token 으로) access token 을 갱신 + keychain 에 다시 영속 → 그 다음
  표준 macOS 자격증명 API(`security find-generic-password -s "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>" -w`)로
  fresh 토큰을 읽는다. **`CLAUDE_CODE_SIMPLE=1` 절대 금지** — simple 모드는 훅을 건너뛰어 Stop 이 안 떠서 M4 불가.
- **결정론 정직성**: M4 어서션은 `events>=1` (실 Stop, 비어있지 않은 `last_assistant_message` 가 E2E 로
  흘렀음)만 보고 **정확한 텍스트(`PONG`)는 안 본다** — 모델이 재포맷할 수 있어 brittle. load-bearing
  증명은 "실 Stop 이 흘러 ChatItem 으로 렌더됐다".

## 실 claude M5 E2E (`TP_E2E_CLAUDE_M5=1`, iOS/iPadOS Sim · macOS 네이티브 · visionOS Sim) — 입력 왕복 증명

`TP_E2E_CLAUDE` 의 **strict superset**. print 모드(`-p`)는 한 응답 후 **종료**하므로 입력이 도착하기 전에
죽어 M5(입력 왕복)가 불가능하다. M5 는 대신 **인터랙티브** claude 세션(라이브 PTY, REPL 유지)을 띄워
**앱의 입력 경로**(app→relay→daemon→PTY→claude)를 진짜로 굴린다 — 전 8마커(M0–M5).

- **세션 = INTERACTIVE** (`tp-e2e-holder --run-claude-interactive`): standalone `tp-runner --sid … --
  --permission-mode bypassPermissions` (no `-p`). claude 의 non-interactive permission 모드라 매-툴 승인
  프롬프트가 unattended 실행을 데드락시키지 않고 앱의 단일 프롬프트로 대체된다 (이 모드는 테스트의 throwaway
  격리 디렉터리에만 스코프되며 개발자의 실제 환경엔 영향 없다).
- **first-run 프롬프트 자동 응답 over IPC**: 인터랙티브 claude 는 시작 시 PTY 에 first-run 다이얼로그
  (trust-folder / bypass-permissions 수락 / settings-error, 버전에 따라 조합)를 렌더한다(print 모드는 스킵).
  격리 sandbox 는 테스트가 방금 만든 자기 소유 디렉터리이므로 하니스가 사람 대신 응답한다. `~/.claude.json`
  pre-seed(`hasTrustDialogAccepted` 등)만으론 현 claude 버전에선 **부족** — holder 의
  `claude::answer_first_run_prompts` 상태머신(1.5s tick, 40s deadline, `UserPromptSubmit` 증가 시
  early-exit)이 세션 io 를 읽어 다이얼로그별 키 시퀀스(IPC `input {sid, data:base64(…)}`)를 보낸다. daemon 의
  command-dispatcher(`input` case, `find_runner_by_sid`)가 runner PTY 로 라우팅 → 세션이 REPL idle 로 진입.
- **입력 = 앱의 auto-probe** (the genuine app path, SMOKE-ONLY): holder 가 REPL 을 idle 로 만든 *뒤*, 앱이
  세션의 **첫 렌더 이벤트**가 도착하면 `maybeSendProbe` 로 `in.chat "tp-input-probe"` 를 relay 로 보낸다. 그
  첫 이벤트는 resume **backfill 배치**(`RelayClient.onBatch`)로 올 수도, **라이브 rec**(`onRec`)로 올 수도
  있어 `maybeSendProbe` 는 **두 경로 모두**에서 호출된다 (idempotent — `inputProbe[sid] == nil` guard 로 세션당
  정확히 한 번 송신). iOS Simulator 는 backfill 배치로 첫 이벤트를 받아 `onBatch` 가 probe 를 쏘지만,
  macOS-native 는 첫 이벤트가 라이브 rec 로 와 `onBatch` 가 안 타므로 `onRec` 에도 probe 송신을 둬야 M5 가
  fire 한다 (이게 없으면 macOS 가 M0–M4 통과 후 M5 만 결정론적으로 빠지는 갭이 난다). **이 auto-probe 는
  스모크 전용** (`RelayClient.isSmokeMode` — iOS/visionOS/watchOS 는 `--tp-smoke-url`, macOS 는 bare
  `--tp-smoke` 런치 인자로 감지) — 실 세션엔 절대 안 쏜다 (안 그러면 유저 claude 에 `tp-input-probe` 가 chat
  으로 주입됨). daemon relay-manager 가 chat 입력에 **`\r`(carriage return)** 을 붙여(`relay-manager.ts`
  `onInput`, `kind==="chat"`) PTY 로 제출한다 — **인터랙티브 claude TUI 는 `\r` 에만 프롬프트를 submit하고
  `\n` 으로는 입력 박스에만 남고 제출되지 않는다** (daemon→runner→PTY 전 경로로 경험적 검증: `text+\r` →
  `UserPromptSubmit`+`Stop`; `\n`(glued/separate) → 둘 다 0). 이게 **프로덕션 dogfood-chat 버그 수정**이다 —
  앱이 보낸 chat 메시지가 실제로 claude 에 제출되게 한다. 회귀 가드: `relay-manager.test.ts` "onInput → runner".
- **probe 는 재시도한다**: 인터랙티브 claude REPL 은 warmup window(trust 프롬프트 dismiss + REPL init) 동안
  키스트로크를 흘리므로 one-shot probe 는 불안정하다. `sendProbeAttempt` 가 probe 를 타이머로 재전송한다
  (최대 `probeMaxAttempts`=12 회, `probeRetryInterval`=4s) — `TP_INPUT_OK` 가 fire 하면 self-cancel. loopback
  은 첫 echo 가 즉시 이기므로 재시도는 한 틱 뒤 취소된다.
- **M5 어서션 = 세션 DB SoT (`assert_m5_input`, #877)**: app-side `RelayClient.checkInputEcho` 는 여전히 두
  경로 중 하나로 `TP_INPUT_OK` 를 emit — (1) terminalOutput 에 probe echo(`proof=echo`) 또는 (2) baseline 을
  넘는 새 assistant `Stop`(`proof=response`) — **그러나 harness 는 이 로그 마커를 real-claude M5 의 SoT 로
  신뢰하지 않는다.** 실 인터랙티브 claude 는 warmup window 에서 키스트로크를 흘려 마커가 poll 창 안에 안 뜰 수
  있고, 마커의 blind fallback 은 같은 sim 의 이전 loopback 런이 남긴 **stale `sess-smoketest` 라인**을 잡아
  "wrong sid" 오진(또는 foreign-sid false-pass)을 냈다. 그래서 공유 헬퍼 `assert_m5_input`(iOS/macOS/visionOS)
  이 arm 별로 분기한다: **loopback** = 기존 same-sid `TP_INPUT_OK`(proof=echo) 그대로(byte-identical);
  **claude_m5** = 격리 세션 DB 의 **`UserPromptSubmit≥1`** 을 authoritative proof 로 180s settle 창(≥2 probe
  사이클, cold-warmup 흡수)에 걸쳐 폴 — same-sid 마커가 떴으면 즉시 pass, 아니면 DB submit 으로 pass, **foreign-sid
  라인은 절대 미수락**, timeout 시 이 런의 sid + DB count 를 명시해 정직하게 die. `claude_m5` scrape 루프는
  이제 M4 에서 break 하고(더는 racy `$input_line` 에 게이트 안 함) M5 는 루프 뒤 DB 폴이 독립 증명한다.
  `Stop` 은 응답 완료 타이밍에 따라 캡처 시점에 아직 안 왔을 수 있어 `UserPromptSubmit` 이 제출 증명의 SoT.
  수동 확인: `TP_E2E_KEEP_DIR=1` 후 `sqlite3 …/real-smoke-sess.sqlite "SELECT name,COUNT(*) FROM records
  WHERE kind='event' GROUP BY name"`.

> **정직한 범위 — print 모드(`TP_E2E_CLAUDE`)는 M0–M4 (7마커)**, **인터랙티브 모드(`TP_E2E_CLAUDE_M5`)는
> M0–M5 (전 8마커)**. M4/M5 는 단일 세션에서 상호배타적(print 는 입력 전에 종료, interactive 는 입력을 받음)
> 이라 두 모드로 나눈다. M5 모드가 M4 도 포함하므로 dogfood 전 증명은 `TP_E2E_CLAUDE_M5=1` 한 번으로 충분.
>
> **절대 GitHub CI 에서 안 돈다**: claude 인증이 ci.yml 에 안 엮여 있고(토큰은 `claude.yml` 봇 전용),
> 비결정론적(행 가능)이며, API 크레딧을 쓰고, 토큰 재사용이 **개발자 본인의 macOS Keychain** 을 읽는다 — hosted
> runner 에 없다. **로컬 pre-merge 게이트 전용** (`TP_E2E_CLAUDE_M5=1 [TP_PLATFORM=ios|ipad|macos|visionos]
> scripts/ios.sh smoke`, `claude` PATH 필수). CI 는 결정론 검증만: `swift-build`(컴파일) + 선택적
> `swift-smoke-ios`(loopback 가짜 daemon).
>
> **플랫폼 커버리지**: **M5 (전 8마커, `TP_E2E_CLAUDE_M5`)** = iOS Simulator · iPadOS(iOS-family alias) ·
> **macOS 네이티브**(`open -a "$app" "$link"` 딥링크 라우팅) · **visionOS Simulator** (전부 8/8 검증, 2026-06-30).
> **M0–M4 (7마커, `TP_E2E_CLAUDE` PRINT)** 는 위 4개 + **watchOS Simulator** (watchOS 는 입력 경로 부재로 M5
> N/A — `claude_e2e` 까지만, `claude_m5` 는 watchOS 에서 `claude_e2e` 로 collapse). daemon+relay+claude 는
> 항상 호스트에서 돌고 앱만 sim/네이티브로 뜨므로 visionOS/watchOS sim 도 실 claude 세션까지 왕복하는
> full-path 통합 검증(읽기 경로)이 가능하다 — sim 안에서 PTY/claude 를 띄우는 게 아니다.
>
> **하니스 함정 2건 (이 배선에서 발견·수정)**: (1) `parse_e2e_gates` 의 마지막 `[ … ] && …` 가 게이트 unset
> 시 exit 1 을 내 `set -e` 아래 caller(`cmd_smoke_macos`)를 빌드 직후 조용히 abort → **`return 0`** 로 닫음.
> (2) 같은 sim 에서 실-claude(sid=`real-smoke-sess`) 직후 loopback(sid=`sess-smoketest`)을 돌리면, 이전 런의
> `TP_SESSION_OK`/`TP_INPUT_OK` 줄이 unified-log 윈도에 남아 blind `tail -n1` 을 shadow → "wrong sid" 오탐.
> **`prefer_sid`** 헬퍼가 `sid=$SMOKE_SESSION_ID` 매칭 줄을 우선 선택(없으면 기존 tail 폴백 — loopback/CI 바이트
> 동일)해 런 순서 독립성을 보장한다. CI 는 loopback 만(sid 항상 동일) 돌아 (2)에 절대 노출 안 됨.

## 실 claude CODING E2E (`TP_E2E_CLAUDE_CODING=1`, iOS/iPadOS/macOS/visionOS/watchOS) — 앱→daemon→claude 파이프라인이 실제 코딩 턴을 운반함을 증명

M5(`TP_E2E_CLAUDE_M5`)는 입력 *왕복* 을 증명하지만, 앱이 보내는 건 고정 `tp-input-probe` 한 줄이다 — 컨트롤러가
Claude Code 로 **실제 코딩**을 시킬 수 있는지는 증명하지 않는다. `TP_E2E_CLAUDE_CODING` 은 그 갭을 닫는다:
**holder 가 멀티턴 실코딩을 구동**하고, harness 가 디스크 + 세션 DB 의 side-effect 를 어서션한다(모델 텍스트 아님).

- **모드 위치**: `TP_E2E_CLAUDE_M5` 의 **sibling** (superset 아님). 둘 다 실 daemon + 실 claude(=`E2E_REAL`+
  `E2E_CLAUDE`)를 imply 하지만 **직교**한다 — M5 는 앱의 입력 probe 를, CODING 은 holder 의 코딩 턴을 행사한다.
  `start_real_daemon_relay` 의 spawn-flag 우선순위는 **coding > m5 > print**(`--run-claude-coding` →
  `--run-claude-interactive` → `--run-claude`). **둘 다 켜면 coding 이 이긴다 — `parse_e2e_gates` 가
  `E2E_CLAUDE_M5` 를 비운다.** 둘은 한 세션에서 상호배타적이다(coding 이 probe 를 억제하므로 `TP_INPUT_OK` 가 절대
  못 뜸). M5 게이트를 비우지 않으면 8마커 셋에 `TP_INPUT_OK` 가 등록되고, M4 early-return 이 `[ -z "$claude_m5" ]`
  로 막혀 `assert_coding_e2e` 를 건너뛴 채 M5 어서션의 hard `die` 로 떨어진다 — 그래서 비우는 게 필수다. 결과:
  coding 의 M0–M4 + 코딩 어서션만 평가, M5 마커는 미등록. 전 M0–M5 + 코딩 커버리지는 **두 번의 별도 실행**으로.
  보통은 한쪽만 켠다.
- **holder (`tp-e2e-holder` `claude::start_coding`)**: 격리 sandbox 에서 interactive claude(non-interactive
  permission mode)를 띄우고 (매-툴 프롬프트가 unattended 실행을 막지 않게), first-run 프롬프트에 `answer_first_run_prompts` 상태머신으로 응답한 뒤 `send_turn` 으로 2턴을 순차 구동.
  - **`send_turn` 의 핵심**: 프롬프트 텍스트(CR 없이) → **별도 `\r`(제출)**. `text\r` 한 프레임은 claude TUI 의
    multi-line paste 버퍼에 묻혀 제출되지 않는다(실측: 프롬프트가 composer 에 남고 `UserPromptSubmit` 안 남). 제출 후
    `UserPromptSubmit` 증가로 등록 확인, warmup keystroke-drop 시 제출 재전송(bounded ≤5), 그 다음 그 턴의 Stop 대기.
    턴2 는 턴1 Stop 게이트 후 — 두 턴이 엄격히 순서대로 쌓여 깨끗한 2턴 DB.
  - **턴 게이팅 = 세션 DB read** (`db::count_records`, read-only rusqlite opener(`SQLITE_OPEN_READ_ONLY`),
    WAL reader 라 daemon writer 안 막음). 경로는 harness 가 어서션하는 것과 동일(`<XDG_DATA_HOME>/teleprompter/
    vault/sessions/<sid>.sqlite`). transient read 에러는 0 으로 degrade → "계속 폴링"(false pass/fail 아님).
- **harness 어서션 (`assert_coding_e2e`, M0–M4 통과 후)**: 격리 dir 에서 결정적 side-effect 3종 — (1) `tp_qa_marker.txt`
  가 디스크에 존재 + body=`QA-CODING-OK`(Write 툴이 우리 지시로 실행), (2) DB `UserPromptSubmit≥2` + `Stop≥2`(두 턴
  착지+완료), (3) `PostToolUse(Write)` + `PostToolUse(Bash)` 훅 이벤트가 둘 다 파일명 참조. (3)은 **구조적 훅-이벤트
  체크** — ANSI io substring 스캔은 타이핑된 명령 ECHO 에 false-positive(초기 구현이 이 함정에 걸려 명령 에코를
  진짜 출력으로 오판)나므로 폐기.
- **앱 변경 (`RelayClient.swift`)**: `--tp-no-input-probe` 가 M5 auto-probe 를 no-op 으로 만들되 `isSmokeMode` 는
  true 유지(부트 마커 + 딥링크 라우팅 불변). coding 모드는 holder 가 input 을 소유 — probe 가 같은 REPL 에서 코딩 턴과
  interleave 하면 corruption(실측: probe 가 턴 중간에 `Skill(run)` 을 제출 → 턴1 Write 미완). harness 는 coding 모드
  4개 런치 사이트 전부에 이 플래그를 추가(loopback/print/m5 경로엔 안 붙음 — M5 probe 정상 발사).
- **정직한 범위**: coding 모드는 **M0–M4 (앱이 실 Stop 렌더) + 코딩 side-effect 어서션**까지. M5 입력 probe 는 직교
  하므로 평가 안 함. watchOS 도 지원(앱은 trigger 가 아니라 holder 가 구동 — watchOS 입력 부재 무관).
- **절대 CI 에서 안 돈다** (M5 와 동일 이유 — claude 인증/크레딧/Keychain). **로컬 pre-merge 전용**:
  `TP_E2E_CLAUDE_CODING=1 [TP_PLATFORM=macos] TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke`.
- **검증 (2026-07-01, macOS 네이티브)**: coding E2E PASS — `tp_qa_marker.txt`=`QA-CODING-OK` 디스크 존재,
  `UserPromptSubmit=2`/`Stop=2`, `PostToolUse(Write)`+`PostToolUse(Bash)` 둘 다 파일 참조. default loopback macOS
  smoke 8/8 유지(M5 probe 정상 — 억제는 coding 모드 한정, 회귀 없음).

## 실 claude WEBPAGE E2E (`TP_E2E_WEBPAGE=1`, iOS/iPadOS/macOS/visionOS/watchOS) — 파이프라인이 실제 HTML5 웹페이지 빌드 턴을 운반함을 증명

`TP_E2E_CLAUDE_CODING` 의 **sibling** — 동일한 holder+pipeline 인프라를 재사용하되 구체적으로
**완전한 HTML5 정적 웹페이지 빌드**를 파이프라인 끝까지 구동한다. "파일 쓰기 + 검증" 패턴은 CODING 과 동일하나
어시션이 HTML5 구조 전체를 검증하므로 웹 output 검증에 특화된 게이트다.

- **모드 위치**: `TP_E2E_CLAUDE_CODING` 의 **sibling** (CODING 의 superset 아님). 둘 다 `E2E_REAL`+
  `E2E_CLAUDE` 를 imply 하고 `E2E_CLAUDE_M5` 를 clear (probe 억제). **둘 다 set 시 WEBPAGE 가 이긴다** —
  `parse_e2e_gates` 가 WEBPAGE 를 먼저 확인해 `E2E_CLAUDE_CODING` 을 clear 하므로, `start_real_daemon_relay`
  의 spawn-flag 우선순위 **webpage > coding > m5 > print** 와 맞물려 항상 `--run-claude-webpage` 가 선택된다.
- **holder (`tp-e2e-holder` `claude::start_webpage`)**: `start_coding` 을 거의
  그대로 클론하되 turn 프롬프트만 다르다. first-run 응답 = `answer_first_run_prompts` 상태머신 → `send_turn` 재사용(함수
  그대로, 프롬프트만 교체):
  - **턴1**: `$TP_E2E_WEBPAGE_FILE`(기본 `index.html`)을 완전한 HTML5 문서로 Write 툴로 생성하도록 지시.
    요구 사항: `<!DOCTYPE html>`, `<html>`, `<head>`+`<title>`, `<body>`+`<h1>`(마커 `$TP_E2E_WEBPAGE_MARKER`=
    `TP-WEBPAGE-OK` 포함), `<style>` 블록 + CSS 규칙 1개 이상. 단일 Write 호출로 완전한 문서 작성을 명시.
  - **턴2** (턴1 Stop 게이트 후): `grep -c "<!DOCTYPE html>" <file> && grep -c "<marker>" <file> && echo WEBPAGE-STEP-DONE` 실행(Bash 툴) — 파일 유효성 검증.
- **harness 어서션 (`assert_webpage_e2e`, M0–M4 통과 후)**:
  1. `$cwd/$file` 존재 + 본문에 `<!DOCTYPE html>`·`<html`·`<body`·`</html>`·마커·`<style` **전부** 포함
     (`grep -qi` 검증; 각 항목 miss 시 명확한 메시지로 die). 첫 5줄을 evidence 로 로그.
  2. DB `UserPromptSubmit≥2`+`Stop≥2` (2턴 착지+완료).
  3. `PostToolUse(Write)` + `PostToolUse(Bash)` 훅 이벤트 둘 다 파일명 참조 (LIKE로 tool_name, `instr()`로
     파일명 — LIKE wildcard false-positive 방지, CODING 과 동일 기법).
- **정직한 범위**: CODING 과 동일 — M0–M4 + 웹페이지 side-effect 어서션. M5 probe 억제이므로 `TP_INPUT_OK` 미평가. watchOS 도 지원(holder 가 구동 — watchOS 입력 부재 무관). **절대 CI 에서 안 돈다** (claude 인증/크레딧/Keychain). **로컬 전용**:
  `TP_E2E_WEBPAGE=1 [TP_PLATFORM=macos] TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke`.

## 실 push E2E (`TP_E2E_PUSH=1`, iOS/iPadOS/macOS/visionOS/watchOS) — in-band push RECEIVE 증명

앱의 푸시 RECEIVE 경로(`RelayClient.onNotification` → `NotificationService.scheduleLocal` → `willPresent` →
`ToastCenter`)가 **실 relay/daemon 을 통해** 동작함을 증명한다. 실 APNs 없이 가능한 유일한 푸시 leg = relay 의
**in-band 전달**(타깃 frontend 가 소켓에 살아있으면 relay 가 APNs 대신 `relay.notification` 으로 보냄).

- **모드 위치**: `TP_E2E_CLAUDE`(print) 의 **sibling**. `E2E_REAL`+`E2E_CLAUDE` 를 imply 한다 — 주입할 `rec`
  의 타깃 세션 DB(print claude 가 생성)와 in-band 전달 조건(앱이 소켓에 live)이 필요하기 때문. **print 모드라
  M5(interactive)와 양립 불가** — `TP_E2E_PUSH` 와 `TP_E2E_CLAUDE_M5` 가 동시 set 되면 (coding 과 동일하게)
  push 가 이겨 `E2E_CLAUDE_M5` 를 clear → print 경로로 내려가 push assertion 이 항상 발화한다 (그 clear 없으면
  M5 경로가 토큰만 등록하고 push assertion 을 조용히 skip — `parse_e2e_gates`).
- **왜 기존 E2E 로는 안 터지나 (둘 다 실측 확인)**: (1) `push-notifier.ts` `tokenCount===0` 게이트 — Sim/macOS 는
  APNs 등록이 `didFailToRegister` 라 토큰이 daemon 에 안 들어감. (2) `NOTIFY_EVENTS`={Notification,
  PermissionRequest,Elicitation} 에 `Stop` 이 없어 coding-E2E 의 Stop 도 push 를 안 띄움. → **토큰 등록 + Notification
  이벤트 주입 둘 다** 필요.
- **이 게이트가 잡은 실버그 2건 (#41 PR2b 첫 live run — 둘 다 pre-existing, 스택돼서 어느 한쪽만 고쳐도 FAIL)**:
  (1) **앱 합성 토큰 vs #839 wire guard** — 구 `"tp-smoke-fake-token-…"` 마커 문자열이 #839(2026-07-01)의
  APNs 형식 guard(64 lowercase hex, TS/Rust 동일)에 걸려 relay 가 `UNKNOWN_TYPE` 으로 조용히 drop → vault
  `push_tokens` 빈 채로 tokenCount==0 no-op. 수정 = frontendId 유도 64-hex(`RelayClient.swift onAuthOk`).
  (2) **Rust relay 의 in-band leg 이 APNs 설정에 오결합** — `conn.rs handle_push` 가 `push_service`(None
  when `APNS_*` unset) 를 `?` 로 early-return 해 **in-band `relay.notification` 까지** drop. TS 레퍼런스는
  PushService 를 무조건 만들고 "ws" verdict(push.ts step 1)가 APNs 없이 동작 — APNs-less relay(모든 로컬/E2E
  relay + push 미설정 self-host)에서 라이브 frontend 가 알림을 전부 잃는 파리티 버그. 수정 = None arm 에서
  `is_frontend_connected` 면 `DeliveryResult::Ws` 경로로 직접 전달(offline leg 만 no-op 유지). 회귀 가드:
  `conn.rs` `push_without_apns_delivers_in_band_when_frontend_connected`(구 `push_send_is_noop_when_
  push_service_unconfigured` 는 이 오동작을 *고정*하고 있어 교체) + `push_without_apns_is_noop_when_frontend_offline`.
- **구동 (가장 충실한 경로)**: (a) **앱**이 `--tp-push-smoke` 하에 `onAuthOk` 에서 **합성 push 토큰**을
  `sendPushRegister` — relay 가 임의 문자열을 seal 하고, frontend 가 live 라 "ws" arm 으로 가서 그 토큰을 실 APNs 로
  절대 안 씀(안전). smoke 모드 전용 게이트 — 실유저/coding/M5 런에 영향 0. (b) **holder**(`--emit-push-notification`)가
  세션 DB 가 준비되면 IPC `rec` 프레임(`kind:"event", name:"Notification", payload=base64({message})`)을 주입 →
  실 `handleRec`→`onRecord`→`sendPush` 파이프라인. 토큰 등록 레이스를 흡수하려 8×@3s 재전송(토큰 전엔 tokenCount==0
  no-op, 등록 후 성공).
- **assert_push_e2e**: unified log 를 폴해 `TP_PUSH_NOTIFY_RECEIVED sid=<driven>` 마커를 확인(세션 DB 아님 — push 는
  DB 에 안 남는 transient). 그 마커는 load-bearing proof — 전체 체인(detect→sendPush→relay "ws"→app decode)이
  돌아야만 emit. 보조로 holder 의 "push: injected …" 로그를 grep(diagnostic, 실패시 warn 만 — 로그 라우팅 차이로
  flake 금지). macOS = host `log stream` 파일, sim = `simctl spawn log show`.
- **정직한 범위**: in-band push 만. **device-gated (자동화 불가)**: 실 APNs 전달("push" DeliveryResult arm),
  디바이스 토큰 수신(`didRegister`), tap→nav(`didReceive`→`SessionNavigator` — 헤드리스 탭 스크립트 불가, 그래서
  `TP_PUSH_NAV_OK` 마커는 의도적으로 미추가). aps-environment entitlement + 실기기 + .p8 필요.
- **절대 CI 에서 안 돈다** (claude 인증/크레딧). **로컬 전용**: `TP_E2E_PUSH=1 [TP_PLATFORM=macos]
  TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke`.
- **회귀 안전**: `TP_PUSH_NOTIFY_RECEIVED` 는 default 8/7 마커 셋에 없음(`TP_E2E_PUSH` 하에서만 assert). 합성 토큰
  등록은 `--tp-push-smoke` 한정 opt-in — 없으면 안 터져 M5/coding 무영향. 토큰은 격리 `$REAL_E2E_DIR` store 에만
  영속(mktemp, 정리됨) — dogfood store 절대 안 건드림.
- **flake caveat (in-band arm 은 앱-liveness 에 타이밍 의존 — FAIL≠production bug)**: 이 E2E 가 증명하는 유일한
  leg 는 **in-band**(`result==="ws"`)다. print `claude -p` 세션은 첫 Stop 후 ~2–3s 안에 종료하고, 그 무렵 앱이
  relay WS 를 tear down 하면 relay 는 `handlePush` 에서 타깃 frontend 를 더 이상 live 로 못 보고 **APNs arm** 으로
  내려간다 — 격리 relay 엔 `APNS_*`/`.p8` 이 없어(sandbox 미설정) 그 push 는 조용히 drop 되고 `TP_PUSH_NOTIFY_RECEIVED`
  가 안 뜬다. 이건 **하니스/타이밍 아티팩트지 프로덕션 버그가 아니다**: 프로덕션 relay 는 `relay-server.ts:1594-1618`
  의 **TOCTOU guard** 로 정확히 이 케이스를 처리한다 — unseal/sendOrDeliver await 동안 소켓이 닫히면 stale `"ws"`
  verdict 를 재검증(`isFrontendWsLive`)해 실 APNs 로 re-deliver 한다(회귀 가드: `relay-server.test.ts`). 따라서 이
  E2E 가 간헐 FAIL 하면 **먼저 앱-liveness 타이밍(injection 이 앱 teardown 을 이겼는지)을 의심**하고, holder 의
  8×@3s 재전송이 그 창을 흡수하도록 설계됐음을 상기하라. 결정적 재현이 필요하면 앱이 소켓에 확실히 살아있는
  interactive 세션 위에서 주입하거나 격리 relay 에 실 `APNS_*` 를 붙여 APNs arm 까지 검증한다(후자는 실기기 gate).

## 실 runner-parity E2E (`TP_E2E_RUNNER_BIN=1`, iOS/iPadOS/macOS/visionOS/watchOS) — Rust `tp-runner` 파리티 증명 (ADR-0003 Stage 4, increment 4)

runner 포트의 load-bearing 불변식은 **daemon 이 어느 runner 가 세션을 만들었는지 구별 못 한다**는 것이다.
`runner-parity.test.ts`(결정론적 fake claude byte-exact wire-parity)가 한때 이를 CI 상시로 증명했으나
**PR4(Bun-deletion cascade #5)에서 삭제됐다** — 이 게이트는 **실 claude 세션**을 Rust `tp-runner` 로 돌려 그
byte-exactness 가 실전에서도 성립함을 증명하며, 삭제된 CI 게이트 대신 `cargo test -p tp-daemon` + tp-core
골든벡터와 함께 runner-parity 의 주 증거로 남는다.

- **모드 위치**: 다른 모든 claude 게이트(CODING/WEBPAGE/M5)와 **직교** — 세션을 *어떻게* 구동하느냐가 아니라
  어느 **runner 바이너리**로 spawn 하느냐를 고른다. `parse_e2e_gates` 가 `E2E_REAL` 만 imply(격리 daemon 이
  rec 타깃), `E2E_CLAUDE` 는 안 함. 그래서 **claude 구동 게이트와 조합**해 쓴다:
  `TP_E2E_CLAUDE_CODING=1 TP_E2E_RUNNER_BIN=1` 이면 코딩 턴을 Rust runner 로 돌려 CODING side-effect
  assert + runner-parity assert 둘 다 평가.
- **왜 seam 이 아니라 holder 가 runner 를 고르나**: 이 E2E 세션들은 daemon 의 `SessionManager.spawn_runner`
  가 만드는 게 아니라 **holder(`tp-e2e-holder`)가 `tp-runner --socket-path <격리>` 로 직접 spawn** 해
  격리 daemon IPC 소켓에 붙는 standalone 프로세스다 (실 claude PRINT/M5/CODING/WEBPAGE 전부 이 경로) —
  daemon-내부 runner 선택 경로는 이 세션엔 안 탄다. holder 의 `spawn::resolve_bin("TP_RUNNER_BIN",
  "tp-runner")` 이 binary 를 정한다: env 가 비어있지 않으면 그 경로(harness 는 항상 주입), 아니면 holder
  바이너리 옆 sibling probe, 둘 다 없으면 die. argv = `[<tp-runner>, --sid, …, --socket-path, …, --,
  <claude args>]`(Rust `tp-runner` 는 `run` 서브커맨드 없이 이 argv 를 직수신, `rust/tp-runner/src/main.rs`).
- **빌드+주입 (`start_real_daemon_relay`)**: `build_rust_runner_bin` 이 `cargo build --release --bin
  tp-runner`(rustup shim 이 cargo 인자를 mis-parse 하므로 `TC_BIN="$(dirname "$(rustup which cargo)")"` 를
  PATH 앞에) 후 `rust/target/{release,debug}/tp-runner`(release 우선) 를 찾아 `REAL_RUNNER_BIN` 에 담고
  (빌드 실패 시 loud die — #41 PR2b 이후 게이트와 무관하게 **항상** 실행), env prefix
  `TP_RUNNER_BIN="$REAL_RUNNER_BIN"` 로 holder 에 주입한다. **리터럴 env-prefix 여야 한다** — `${VAR:+…}`
  파라미터 확장은 word-split 돼 `TP_RUNNER_BIN=…` 를 *명령*으로 오실행("No such file or directory")한다.
- **positive 증명 (`assert_runner_parity`, claude-agnostic assert 뒤)**: env 미전파/sibling-fallback 이
  runner-agnostic assert 를 전부 통과시켜 게이트를 no-op 으로 만드는 걸 막는다. holder 는 `TP_RUNNER_BIN`
  이 비어있지 않을 때 STDOUT contract 라인(=`$REAL_RP_OUT` 에 캡처됨)으로
  `RUNNER_PARITY_BIN=<REAL_RUNNER_BIN>` 를 찍는다 — 그 바이너리가 아래 모든 세션을 서빙한다는 선언. assert 가
  `$REAL_RP_OUT` 에서 그 라인을 grep -F(literal 경로 매칭 — 느슨한 'tp-runner' substring 아님)해 확인한다
  (proof 를 holder 에 두는 이유: 세션을 spawn 한 게 holder 라 어느 바이너리를 썼는지 holder 만 확실히 안다 —
  daemon spawn 로그는 이 경로에선 비어있다). + 세션 DB `kind='io'` rows≥1 구조 체크(io 바이너리 사이드카가
  파리티 surface — non-empty 확인; byte-exactness 는 tp-core 골든벡터 + `cargo test` 가 잠금).
- **정직한 범위**: 이 게이트는 파리티를 **증명**한다 — pre-flip 증명 도구였고 flip 후에도 회귀 가드로 유지.
  **기본 runner default flip 완료 (task #4)**: Rust 데몬 경로가 `tp_proto::locate_tp_runner()` 로 Rust
  `tp-runner` 를 spawn 한다(`manager.rs` `default_runner_command`) — 이 게이트가 요구한 N회 clean 실 claude
  E2E 소크(사용자 구동, 5 macOS-native 런)를 통과해 flip 됐다. (Bun `resolveRunnerCommand()`(spawn.ts)는 Bun
  데몬 레퍼런스 구현이 살아있는 동안만 유효 — Rust 데몬이 기본이라 프로덕션 spawn 경로는 아님.)
- **절대 CI 에서 안 돈다** (실 claude auth/credits/Keychain — CODING/WEBPAGE 와 동일). **로컬 pre-merge 전용**:
  `TP_E2E_CLAUDE_CODING=1 TP_E2E_RUNNER_BIN=1 [TP_PLATFORM=macos] TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke`.
- **관련 결정론 게이트**: `packages/daemon/src/session/runner-parity.test.ts` — Bun↔Rust differential
  wire-parity(fake claude, hello/io/bye byte-exact + JSON 키순서, CI 상시)였으나 **PR4(Bun-deletion cascade
  #5)에서 삭제됨** — Bun 레퍼런스 구현이 사라지며 이 gate 도 존재 이유를 잃었다. 살아남은 결정론적 커버리지는
  `cargo test -p tp-daemon`(187 pass, store/worktree/reconnect-policy/push-gate/dispatcher 유닛) + tp-core
  골든벡터다. `scripts/runner-parity-real-claude.ts` — committed 로컬 전용 프레임 diff 하니스
  (`TP_RUNNER_PARITY_REAL_CLAUDE=1`, 실 claude 로 hello/bye byte-exact mod {pid,ts} + io 구조 diff)는 그대로
  남아 이 섹션(위)의 **로컬 실-claude `TP_E2E_RUNNER_BIN=1` 게이트**와 함께 runner-parity 의 주 증거다.

## 실 daemon-parity E2E (`TP_E2E_DAEMON_BIN=1`, iOS/iPadOS/macOS/visionOS/watchOS) — Rust `tp-daemon` 파리티 증명 (ADR-0003 Phase 4, flip-prep A2)

runner-parity 게이트의 **daemon 쌍둥이**. daemon 포트(inc1–inc5)의 load-bearing 불변식은 **앱/relay/store 가
어느 daemon 구현이 서빙하는지 구별 못 한다**는 것 — 다섯 개 `*-rust-parity.test.ts` differential 게이트(store/
worktree/reconnect/push/dispatcher)가 한때 CI 상시로 이를 결정론적으로 증명했으나 **PR4(Bun-deletion cascade
#5)에서 전부 삭제됐다**. 이 게이트는 **실 claude 세션**을 Rust `tp-daemon` 으로 서빙해 그 파리티가 실전
full-path 에서도 성립함을 증명하며, 삭제된 다섯 CI 게이트 대신 `cargo test -p tp-daemon` + tp-core 골든벡터와
함께 daemon-parity 의 주 증거로 남는다. **pre-flip 증명 도구였고 flip 후에도 회귀 가드로 유지** —
A1(ship+locate)에 이은 flip-prep 이었고, flip 자체(task #4)는 이 게이트가
요구한 N회 clean 실 claude E2E 소크(사용자 구동, 5 macOS-native 런)를 통과해 완료됐다.

- **모드 위치**: 모든 claude 구동 게이트(CODING/WEBPAGE/M5)와 **직교** — 세션을 *어떻게* 구동하느냐가 아니라
  어느 **daemon 바이너리**가 서빙하느냐를 고른다. `parse_e2e_gates` 가 `E2E_REAL` 만 imply, `E2E_CLAUDE` 는 안
  함. 그래서 claude 구동 게이트와 **조합**: `TP_E2E_CLAUDE_CODING=1 TP_E2E_DAEMON_BIN=1` 이면 코딩 턴을 Rust
  daemon 위에서 돌려 CODING side-effect assert + daemon-parity assert 둘 다 평가. **`TP_E2E_RUNNER_BIN` 과도
  조합** 가능(한 런에서 Rust daemon + Rust runner).
- **왜 seam 이 아니라 holder 가 daemon 을 고르나**: 격리 E2E daemon 은 **holder(`tp-e2e-holder`)가 직접
  spawn** 한다(`spawn::spawn_daemon` — 단일 spawn 사이트). `tp` CLI 의 background auto-spawn/foreground
  trampoline 경로를 전혀 안 타므로 CLI 쪽 seam 은 무효. binary 는 runner 와 동일한
  `spawn::resolve_bin("TP_DAEMON_BIN", "tp-daemon")` 이 정한다: env 가 비어있지 않으면 그 경로(harness 는
  항상 주입), 아니면 holder 옆 sibling probe, 둘 다 없으면 die — `locate_tp_daemon()` 은 절대 안 쓴다(dogfood
  prefix-tree 는 E2E 샌드박스에서 의도적으로 unreachable). argv = `[<tp-daemon>]`(서브커맨드 없음 — Rust bin
  이 곧 daemon: pid-lock → `Daemon::new/start` → signals, `rust/tp-daemon/src/bin/tp_daemon.rs`).
- **빌드+주입 (`start_real_daemon_relay`)**: `build_rust_daemon_bin` 이 `cargo build --release --bin
  tp-daemon`(rustup shim 우회 `TC_BIN` PATH 앞) 후 `rust/target/{release,debug}/tp-daemon`(release 우선)을
  찾아 `REAL_DAEMON_BIN` 에 담고(빌드 실패 시 loud die — #41 PR2b 이후 게이트와 무관하게 **항상** 실행), env
  prefix `TP_DAEMON_BIN="$REAL_DAEMON_BIN"` 로 holder 에 주입. **리터럴 env-prefix** 필수(runner 와 동일 —
  `${VAR:+…}` 확장은 word-split 돼 오실행).
- **positive 증명이 PRIMARY (`assert_daemon_parity`, claude-agnostic assert 뒤)**: runner 케이스는 io-row
  count 가 독립 2차 체크지만, daemon 은 wire/store surface 가 구현-무관하게 동일하도록 설계돼 치환된 daemon 이
  고유 fingerprint 를 안 남긴다 → `DAEMON_PARITY_BIN` 라인이 **유일한 판별자**다. holder 는 `TP_DAEMON_BIN`
  이 비어있지 않을 때 자기 STDOUT(=`$REAL_RP_OUT`)에 `DAEMON_PARITY_BIN=<REAL_DAEMON_BIN>` contract 라인을
  찍고(REAL_PAIR_URL 옆 durable 라인 — stderr diagnostics 는 `>rp_out 2>>rp_out` shared-fd 에서 race 가능,
  contract 라인은 그래서 전부 stdout + line-단위 flush), assert 가 `grep -F`(literal 경로)로 확인한다(env
  미전파/sibling-fallback = NO 라인 → die). + 보조로 격리 store DB `records≥1`(치환 daemon 이 세션을 실제
  영속 — 라인만 찍고 크래시한 게 아님을 확인).
- **정직한 범위**: 이 게이트는 파리티를 **증명**한다 — pre-flip 증명 도구였고 flip 후에도 회귀 가드로 유지.
  **기본 daemon default flip 완료 (task #4)**: Rust `tp` 의 background auto-spawn(`ensure_daemon.rs`
  `spawn_background_daemon`)과 foreground/OS-service trampoline(`commands/daemon.rs::start`) 둘 다
  `locate_tp_daemon()` 로 Rust `tp-daemon` 을 띄운다 — 이 게이트가 요구한 N회 clean 실 claude E2E 소크(사용자
  구동, 5 macOS-native 런) 통과로 flip. (Bun tpd 블롭은 아직 ship — 레퍼런스 구현 퇴역은 task #5 삭제 cascade;
  이 flip 은 *기본*만 Rust 로 돌린다.)
- **절대 CI 에서 안 돈다** (실 claude auth/credits/Keychain). **로컬 pre-merge 전용**:
  `TP_E2E_CLAUDE_CODING=1 TP_E2E_DAEMON_BIN=1 [TP_PLATFORM=macos] TP_E2E_KEEP_DIR=1 scripts/ios.sh smoke`.
- **관련 결정론 게이트**: `packages/daemon/src/{store,worktree,transport,push,ipc}/*-rust-parity.test.ts` —
  다섯 개 Bun↔Rust differential 게이트(및 이를 구동하던 `tp-daemon-probe` 바이너리, `test` job 의
  `cargo build --release --bin tp-daemon-probe` 로 SKIP→RUN 전환하던 CI 상시 게이트)는 **PR4(Bun-deletion
  cascade #5)에서 전부 삭제됐다** — Bun 레퍼런스 구현이 사라지며 이 differential 비교 자체가 존재 이유를
  잃었다. 살아남은 결정론적 커버리지는 `cargo test -p tp-daemon`(187 pass) + tp-core 골든벡터이고, 위 로컬
  실-claude `TP_E2E_DAEMON_BIN=1` 게이트가 full-path 파리티의 주 증거로 남는다.

## 소크 프리셋 (`scripts/ios.sh soak`) — flip 게이트 5-run 시퀀스 (task #36)

flip 소크는 **고정 레시피**다: 같은 프리셋(Rust daemon+runner, macOS-native, keep-dir)을 여러 실
claude 세션 모드에 걸쳐 돌린다. 손으로 치면 **run 마다 4-flag 곱(`TP_E2E_DAEMON_BIN=1
TP_E2E_RUNNER_BIN=1 TP_PLATFORM=macos TP_E2E_KEEP_DIR=1` + 구동 게이트)**을 5번 반복해야 해서 —
사용자가 "사용성이 거지같다"고 한 바로 그 `TP_E2E_*` sprawl. `scripts/ios.sh soak` 서브커맨드
(`cmd_soak`)가 전 시퀀스를 한 진입점으로 감싼다.

- **새 env 노브 없음, minimal blast radius**: `parse_e2e_gates` 는 손대지 않는다. `cmd_soak` 은
  얇은 드라이버 — 사용자가 칠 env 를 그대로 세팅하고 **평범한 `bash "$0" smoke` 서브셸**을 run 마다
  돌린다(모든 게이트가 `parse_e2e_gates` 로 종전과 동일하게 resolve). env 오버라이드로 다른 서브커맨드를
  하이재킹하는 방식(`TP_E2E_SOAK=1`)은 의도적으로 **채택 안 함** — 그건 더 많은 implicit coupling 이라
  단순화 목표에 역행. 명시적 서브커맨드 하나가 SoT.
- **프리셋 (전 run 공통)**: `TP_E2E_DAEMON_BIN=1`(격리 daemon=Rust tp-daemon) +
  `TP_E2E_RUNNER_BIN=1`(그 daemon 이 Rust tp-runner spawn) + `TP_PLATFORM=macos`(sim 없는 host-side
  경로) + `TP_E2E_KEEP_DIR=1`(실패 post-mortem 용 격리 dir 보존).
- **시퀀스 (구동 게이트만 run 별로 변화)**: `3×TP_E2E_CLAUDE_M5`(M0–M5 인터랙티브 입력 왕복 —
  app-probe→PTY→claude→Stop 이 가장 타이밍 민감해 반복) + `1×TP_E2E_CLAUDE_CODING`(Write+Bash 코딩 턴,
  M0–M4) + `1×TP_E2E_WEBPAGE`(HTML5 빌드+검증 턴, M0–M4). `TP_SOAK_RUNS` 로 M5 반복 횟수 오버라이드(기본 3).
- **serial + self-sweeping (load-bearing 하이진)**: 실 claude macOS 소크는 **하나의 host relay +
  LaunchServices + app 페어링 store 를 공유**하므로 iteration 은 반드시 **직렬**이어야 한다. `cmd_smoke_macos`
  의 per-run 텔다운은 **app 만** kill(`pkill -x Teleprompter`) + app-side 페어링 keychain 만 purge 한다 —
  run 이 mid-flight `die`(e.g. M5 타임아웃)하면 **격리 tp-daemon + tp-runner + spawned claude 가 살아남아**
  공유 host relay 에 등록된 채로 남고, **다음 run 의 app 이 그 stale daemon 으로 auto-reconnect** 한다(관찰:
  모든 run 이 leftover `daemon-…` 하나로 latch → 이 run 자기 격리 세션 DB 는 UserPromptSubmit=0 → #877
  foreign-sid 가드가 정당하게 M5 fail). `soak_sweep_stray_e2e()` 가 이 프로세스 leak 을 run 사이마다
  닫는다 — E2E 시그니처(`rust/target/release/tp-{daemon,runner}`, Bun `apps/cli … run --sid
  real-smoke-sess`, `hook-real-smoke-sess.sock` 바인딩된 claude)만 정밀 매칭해 kill 하고 **dogfood daemon
  (`~/.local/share/tp`) 이나 비-E2E claude 는 절대 안 건드린다**. (동시 실행 run 은 서로 cross-wire 하므로
  절대 금지 — 소크는 항상 직렬 단일.)
- **STANDING-DELEGATED to the agent (정책)**: 소크 실행은 이제 **에이전트에 상시 위임**돼 있다(사용자
  "앞으로는 네가 돌려"). 예전 "USER-driven soak, never agent-launched" 는 더 이상 적용 안 됨 —
  에이전트가 `scripts/ios.sh soak` 를 직접 돌린다. 여전히 **로컬 전용, 절대 CI 아님**(실 claude auth/credits/
  Keychain — 운영자 자기 토큰 재사용, unattended-CI plumbing 이지 credential theft 아님).

## 공식 Apple Xcode MCP (`mcpbridge`) — 인터랙티브 전용

`.mcp.json` 에 등록된 `xcode` 서버 = Apple 공식 **`mcpbridge`** (Xcode 26.3+ 내장,
`/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge`). STDIO ↔ JSON-RPC 2.0 으로
**실행 중인 Xcode.app** 에 XPC 브리지 (Xcode 안 떠있으면 에러). 도구: File System, Build & Test,
Intelligence(Swift REPL, **RenderPreview = 실제 SwiftUI 스크린샷**, 온디바이스 문서검색).

> **이건 인터랙티브 개발 루프 보조 도구일 뿐 — CI/E2E 게이트가 아니다.** "실제로 동작하는가" 의
> 재현 가능한 SoT 는 `scripts/ios.sh` (마커 E2E) + `TeleprompterUITests` (XCUITest). MCP 는 빌드/프리뷰/
> REPL 을 Xcode 열어둔 채 굴릴 때만 쓴다. 활성화: Xcode Settings(⌘,) → Intelligence → "Enable Model
> Context Protocol".

## 커밋 규율

이 영역(`ios/**`, `rust/**`, `scripts/ios.sh`)을 바꾸면 같은 커밋에서 이 rule 파일 + `ios/README.md` +
`rust/README.md` 를 동기화한다.
