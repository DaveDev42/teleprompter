---
paths:
  - "ios/**"
  - "rust/**"
  - "scripts/ios.sh"
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
| **UI E2E** | XCUITest 가 a11y 트리를 쿼리해 세션 row tap → pane picker → chat bubble 어서션 | `scripts/ios.sh uitest` (단일) / `uitest-all` (전 플랫폼 매트릭스) | iOS/iPadOS 풀, macOS는 호스트 게이트 2종 통과 시(TCC 미인가 / Xcode 27 beta windowless-launch → SKIP), visionOS 부분, **watchOS 불가(자동 SKIP)** |
| **유닛** | XCTest (FFI/Keychain/relay.auth/terminal 등) | `scripts/ios.sh test` | iOS Simulator |

마커 E2E 는 **실 `RelayServer` + 가짜 daemon**(포트 7099, golden 토큰 pre-seed, 합성
`sess-smoketest`)이 기본. loopback 백엔드 = 컴파일된 Rust `tp-loopback` 바이너리
(`rust/tp-loopback` — 실 `tp_relay::RelayServer` in-process + `tokio-tungstenite` 가짜
daemon peer, `tp_core` 크립토로 kx/hello/PCT/batch/io 를 seal). `start_loopback` 이
`build_rust_loopback_bin`(rustup-shim-safe TC_BIN, release→debug fallback, LOUD-on-fail)으로
바이너리를 빌드해 `RELAY_PORT` env 로 스폰한다. (역사: 원조 Bun `local-relay-loopback.ts` 와
`TP_RUST_LOOPBACK=1` opt-in 시절 wire-identical 8/8 교차검증 완료(2026-07-20) 후, **#5 PR6** 에서
Bun 스크립트+opt-in seam 삭제 — Rust 가 유일 구현이고 CI `swift-smoke-ios` 도 env 없이 이 경로를
쓴다.) **실 `tp` daemon+relay** E2E 는 `TP_E2E_REAL=1` 게이트 뒤 (SoT: `.claude/rules/native-e2e-gates.md`).

## 플랫폼 매트릭스

| Platform | `TP_PLATFORM` | 빌드 destination | 마커 | UI 자동화 | 비고 |
|---|---|---|---|---|---|
| iOS | `ios` (기본) | `platform=iOS Simulator,name=$TP_SIM` (`iPhone 17 Pro`) | **8** | 풀 | |
| iPadOS | `ipad` | iOS Simulator, `$TP_SIM`=`iPad Pro 13-inch (M5)` | **8** | 풀 | iOS 경로 alias — 새 슬라이스 불필요 (`ios-arm64_x86_64-simulator` 공유). split-view/sidebar 실행. (M5 = iOS 26.5 런타임; M4 는 18.5 뿐이라 name 해석 모호) |
| macOS | `macos` | `platform=macOS` (native, `open`) | **8** | **호스트 게이트 2종** — 빌드+서명 O. (1) TCC/LocalAuthentication: 비대화형/미인가 세션에선 runner init 실패 → **SKIP** (`reason=tcc-host-gate`). (2) **windowless-launch** (Xcode 27 beta / macOS 27 beta 회귀): XCUITest 런치 앱이 부팅은 되나(TP_BOOT_OK) 메인 창이 아예 생성 안 됨 → **SKIP** (`reason=windowless-launch`; `TP_BOOT_OK` 有 + `smoke url injection` 無 로 판별 — 진짜 렌더 실패는 FAIL 유지). 둘 다 exit 0, `TP_UITEST_SKIP` 마커 emit(PASS 와 혼동 금지), `TP_UITEST_STRICT=1` 이면 **hard-fail** | sim 없음. `screencapture -x` 아티팩트. `log stream` 폴링 |
| visionOS | `visionos` | `id=$visionUDID` (xrOS sim) | **8** | **부분** — element 쿼리+flat-window tap O, 공간 제스처/eye-gaze sim **불가** | `TP_VISION_SIM`=`Apple Vision Pro` |
| watchOS | `watchos` | `-target TeleprompterWatch -sdk watchsimulator` (SDK 는 **unversioned** — 버전 핀은 Xcode 업그레이드 시 즉사) | **7** (no `TP_INPUT_OK`) | **없음** — watchOS 에 `XCUIApplication` 부재 (Apple hard limit) | `TP_WATCH_SIM`=`Apple Watch Series 11 (46mm)`. 마커+스크린샷만. **폰→워치 페어링 전달 경로는 smoke 미커버** (아래 참조) |

> **`TP_INPUT_OK` 가 watchOS 에서 빠지는 이유**: ADR-0002 §4 — watchOS 는 제한 경험(입력 송신 미구현).
> 그래서 watchOS smoke 는 M0–M4 (7마커) 만 어서션한다.

> **폰→워치 페어링 전달은 자동 게이트가 없다 (실기기 전용).** watch 가 페어링을 어떻게 얻는지는
> 두 번 바뀌었고, 두 경로 모두 smoke 로 못 잡는다:
> 1. **iCloud Keychain sync — 실기기에서 반증됨.** #944 로 컴패니언 keychain access group
>    (`$(AppIdentifierPrefix)dev.tpmt.app`, `TeleprompterWatch.entitlements`)을 공유시킨 뒤 실기기
>    (Apple Watch Ultra 1, 빌드 0.1.20(2301))에서 확인한 결과 **Apple 은 서드파티 synchronizable
>    Keychain 아이템을 watchOS 로 전파하지 않는다** — entitlement 는 필요조건이었을 뿐 전송로가 아니다.
>    이 실기기 게이트의 답은 "전파 안 됨" 으로 이미 나왔다.
> 2. **WatchConnectivity 컴패니언 미러 (현행 전송로)** — 폰이 `updateApplicationContext` 로 커밋된
>    페어링 스냅샷을 넘긴다. **이것도 smoke 미커버**: `cmd_smoke_watchos` 는 iOS Simulator 를 아예
>    부팅하지 않고 하니스에 `simctl pair` 도 없어서, 시뮬레이터에는 미러를 보낼 폰 자체가 없다
>    (`WCSession.isPaired` false → `publish()` 가 조기 return). 그래서 **7마커 세트는 그대로**이고
>    (미러는 마커를 추가하지 않는다), 전달 검증은 실기기 게이트로 남는다 (`TODO.md`).
>
> **수동 sim-레벨 검증은 가능하다 — 단 26.5↔26.5 런타임 한정 (2026-07-31 실측 PASS).** `simctl pair` 로
> iOS 26.5 iPhone + watchOS 26.5 watch 를 페어링하고, iOS smoke 로 폰 앱에 loopback 페어링을 커밋한 뒤
> 임베드 `TeleprompterWatch.app`(iOS 빌드 산출물 `Teleprompter.app/Watch/`)을 watch sim 에 `simctl install`
> 하고 **폰 앱을 일반 모드로 재기동**하면 (`publish()` 는 activation 콜백에서만 발화) 전 경로가 돈다.
> 관측된 증거: 폰 `published 1 pairing(s)` → 워치 `peer snapshot applied adopted=1` → 워치가 채택한
> 페어링의 relay 로 접속 시도; 클린 재설치 후 Keychain 영속 + 빈 `receivedApplicationContext` 를 "전부
> 해지"로 오독하지 않음(`pairings.v1` 키 가드); 재배달은 `adopted=0` 멱등 + 스냅샷에 없는 잔존 페어링은
> **hide**(삭제 아님) 재처리; 워치 반복 재기동 후에도 폰 페어링 무손상(불변식 D). 함정 4개:
> (1) **iOS 27.0 beta sim 런타임(24A5390f)엔 `appconduitd` 가 아예 없다** (LaunchDaemon plist/바이너리
> 부재 — 26.5 런타임 23F77 엔 있음) → `wcd` 초기 셋업이 `com.apple.appconduitd.device-connection` XPC
> "No such process" 로 영구 실패 → `isWatchAppInstalled` 가 절대 true 가 못 돼 `publish()` 가 (설계대로)
> 조용히 guard-out — **27.0 sim 으론 이 검증이 구조적으로 불가능하다**. (2) `sim_udid()` 는 최고 런타임을
> 선호하므로 "iPhone 17 Pro" 가 26.5/27.0 양쪽에 있으면 27.0 이 뽑힌다 — 26.5 폰을 `simctl rename` 으로
> 유니크 이름을 주고 `TP_SIM` 으로 지정할 것. (3) `simctl unpair` 는 워치 쪽 컴패니언 앱을 제거하고, 신규
> 페어는 라이브 페어링 이벤트/재부팅 전까지 폰 `wcd` 가 세션 상태를 배달 안 할 수 있다 (활성화 콜백 자체가
> 안 옴 — 재현 시 양쪽 재부팅 또는 부팅 상태 재페어로 회복). (4) 워치 앱 설치가 폰 `wcd` 에 등록되기까지
> 지연이 있고 `publish()` 트리거는 activation + committed-set 변경뿐이라, 워치 앱 설치·실행 **후** 폰 앱을
> 한 번 더 재기동해야 `published` 가 뜬다. 실기기 고유 요소(실 BT 전송, 백그라운드 전달,
> `receivedApplicationContext` 기기 영속 — sim 에선 워치 재기동 시 재적용 라인이 안 뜨는 것을 관측)는
> 여전히 실기기 게이트.
>
> 자동 커버는 **폰 타깃 XCTest** 가 대신한다 — `WCSession` 경계 **아래** 로직(`committedSnapshot()`,
> `applyPeerSnapshot()`, `WatchConnectionState.derive`)을 전부 `ios/Sources/` 에 둬서
> `TeleprompterTests`(`[iOS, macOS]`)가 컴파일·실행한다 (`ios/Tests/PairingSnapshotTests.swift`).
> watch 타깃 코드를 컴파일하는 테스트 타깃은 존재하지 않으므로, 로직을 watch 쪽에 두면 게이트가 0 이 된다.
> smoke 자체는 두 겹으로 미러와 격리된다: `PairingSyncBridge.activate()` 가 `RelayClient.isSmokeMode`
> 에서 세션을 아예 안 띄우고, `applyPeerSnapshot` 도 같은 조건으로 `.ignoredSmoke` 를 리턴한다.

> **Smoke Keychain 격리 (PR-6 Option A)**: PR-6 은 커밋 페어링 인덱스를 `simctl uninstall` 이 지우는
> UserDefaults 에서 **synchronizable Keychain blob**(`<base>.v2` service)로 옮겼다 — 이건 uninstall 을
> 살아남는다(iCloud sync 의 요점). smoke 는 매 런 fresh 페어링을 re-ingest 하므로, 잔류 committed blob 이
> 부팅 시 committed `RelayClient` 를 재연결시켜 그 런의 pending client 와 **같은 frontendId 로 경합** →
> daemon per-frontend 세션키 clobber → frame-decrypt `aead authentication failed`(M3' fail)를 낸다. 두
> 겹 방어: (1) **app-side** — `PairingViewModel.init` **과 watch 의 `WatchPairingViewModel.init` 둘 다**
> (watch 쪽은 뒤늦게 발견·이식 — phone 에만 넣으면 watchOS smoke 두 번째 런부터 M3' 가 동일하게 깨진다) 가
> `RelayClient.isSmokeMode`(`--tp-smoke*` launch
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
| M1 | `TP_PAIR_OK` | pairing PROMOTED to COMMITTED. **PR-4 (connect-on-pending)**: ingest 는 PENDING 에만 쓰고 `TP_PAIR_PENDING` 을 emit; `TP_PAIR_OK` 는 promote 시점에 emit — emit 지점은 **양쪽 view-model 모두** (phone `PairingViewModel.promoteConfirmed` + watch `WatchPairingViewModel.promoteConfirmed`): PR-4 가 emitter 를 shared ingest(DeepLinkHandler)에서 phone 전용 코드로 옮기며 watch emitter 를 삭제해 watchOS smoke M1 이 잠재 회귀했었다(뒤늦게 발견·복원). 새 마커 이동 시 watch 타깃 소스 포함 여부를 반드시 확인. **PR-5 (§1.3 PCT verification gate)**: promote 는 이제 kx 완료가 아니라 **hello 의 PCT 검증**이 게이트한다. loopback 은 kx `v:3` 을 advertise + hello 에 `pct` 를 실어(daemon-role 세션키로 계산, app frontend-role PCT 와 byte-exact 수렴) **§1.3 Cell 1(CONFIRMED)** 로만 승격시키므로 M1 = `TP_PAIR_OK` 는 이제 **PCT-confirm 을 transitively 게이트**한다 (mismatch=Cell 2 는 promote 안 함, `v:3` 이라 legacy Cell 3 도 배제 → `TP_PAIR_OK` 관찰 = Cell 1 실행 증명; 별도 `TP_PAIR_CONFIRM_OK` 도 emit). 마커 카운트 불변(8/8/8/7). **real-daemon E2E (`TP_E2E_REAL`/`TP_E2E_CLAUDE*`) 는 kx out-of-scope/racy 라 M1 = `TP_PAIR_PENDING`** (하니스가 `$real_e2e` 비어있지 않으면 `m1_marker=TP_PAIR_PENDING` 로 분기 — scrape/assert/marker-tally 전부). |
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

기본 플래그(`TP_PLATFORM`/`TP_SIM`/`TP_VISION_SIM`/`TP_WATCH_SIM`/`TP_SKIP_RUST`/`TP_FORCE_RUST`/`TP_JSON`/`TP_ARTIFACT_DIR`)의 기본값·설명은 `scripts/ios.sh` 사용법 헤더가 SoT — 여기서 반복하지 않는다.

| Var | 효과 |
|---|---|
| `TP_UITEST_STRICT=1` | macOS XCUITest 호스트 게이트 2종(TCC 미인가 / Xcode 27 beta windowless-launch)을 non-fatal SKIP 대신 **hard-fail** 로 (인가된 GUI/CI 러너용; 기본 SKIP 은 `TP_UITEST_SKIP` 마커 emit) |
TP_E2E_* 게이트 env 전체 표는 `.claude/rules/native-e2e-gates.md` (SoT).

## 서브커맨드

`scripts/ios.sh` 서브커맨드(`rust`/`gen`/`boot`/`build`/`smoke`/`uitest`/`uitest-all`/`test`/`all`/`archive`) 목록·설명은 `scripts/ios.sh` 사용법 헤더 + `ios/README.md` 가 SoT — 여기서 반복하지 않는다.

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
> 요청하면 에러). macOS 호스트 게이트 2종(TCC 미인가 / Xcode 27 beta windowless-launch)은 SKIP(실패
> 아님), `TP_UITEST_STRICT=1` 이면 FAIL. 종료코드는 FAIL 이
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

**세 번째 테스트 (iOS/iPadOS 전용, `testPinAndDeleteSwipeActionsOnSessionRow`, `#if os(iOS)`)** 는
세션 row 스와이프 액션을 가드한다: swipe-right → Pin(`session-swipe-pin-<sid>`) → 행의 pin 글리프
(`session-pinned-<sid>`) 등장 → 한 번 더 swipe-right 로 Unpin(토글 양방향) → swipe-left 로
Delete 버튼(`session-swipe-delete-<sid>`) **노출만** 확인(탭 안 함 — 세션을 살려둬야 다음 렌더 테스트가
돈다; `allowsFullSwipe: false` 라 over-swipe 로도 안 터진다). 정렬·핀 상태 자체는 유닛
(`ios/Tests/SessionPinOrderTests.swift`, `SessionStore.orderedSessions`)이 커버하고, 이 UI 테스트는
**제스처가 실제 손가락이 닿는 row 에 배선됐는지**만 증명한다. **메서드 이름이 load-bearing** — XCTest 는
알파벳순 실행이라 `testPin…` 이 `testSessionRender…` 보다 먼저 돌고, 그래서 sub-window 가 한 번도 열리지
않은 상태에서 launch 한다(iPad 에서 pop-out 테스트 뒤에 돌면 UIKit 이 그 서브 창을 frontmost 로 restore 해
리스트를 가린다 — 위 single-launch 근거와 동일 함정). 이름을 뒤로 정렬되게 바꾸지 말 것. 리딩 스와이프는
full-swipe 허용이라 XCUITest `swipeRight()` 가 버튼 노출 대신 액션을 바로 실행할 수 있어, 테스트는 **둘 다
허용**(버튼 뜨면 탭, 아니면 이미 토글됨)하고 최종 상태만 어서션한다.

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
- **macOS 호스트 게이트 #2 — windowless XCUITest launch (Xcode 27 beta / macOS 27 beta 회귀, 2026-07-24
  진단)**: XCUITest 가 launch 한 SwiftUI 앱이 **활성**(메뉴바 소유, `App.init` 실행 → `TP_BOOT_OK`)인데
  메인 value-less WindowGroup 창이 **아예 생성되지 않는다** — a11y 트리에 Window 요소 0개, 루트 content
  `.onAppear` 미발화 → `--tp-smoke-url` 주입("smoke url injection" 로그)도 세션 row 도 불가능. 코드 회귀
  아님: 같은 빌드의 마커 smoke(`open` 런치)는 8/8 + 단일-창 가드 통과, 동일 XCUITest 가 iOS/iPad/visionOS
  에서 PASS. `cmd_uitest` macOS 분기가 `start_macos_log_stream` 을 미리 켜고, 실패 시 3중 판별
  (xcodebuild 로그 "never rendered" + 스트림 `TP_BOOT_OK` 有 + "smoke url injection" 無)로 이 모드만
  **SKIP(exit 0, `reason=windowless-launch`)** 처리한다. **판별 스코프는 run 단위 fail-closed** — 스트림
  파일은 한 `xcodebuild test` run 의 **두 테스트 launch 가 공유**하는 단일 sink 라, "주입 無" 조건 =
  어느 launch 도 주입 안 함. 즉 게이트는 **순수 windowless run**(관측된 결정론 모드)만 SKIP 한다: 창이
  뜨고도 row 가 없는 **진짜 렌더 실패는 주입 로그가 남으므로 FAIL 유지**, 혼합 run(한 launch windowless
  + 다른 launch 정상 렌더)도 **의도적으로 FAIL 유지** (공유 스트림에선 launch 별 귀속 불가 → 카운트
  휴리스틱은 진짜 렌더 버그를 false-SKIP 할 위험; 대신 하니스가 boots>injections 혼합 감지 시 triage
  힌트 로그를 남긴다). 앱 launch 실패(TP_BOOT_OK 부재)도 FAIL 유지. `TP_UITEST_STRICT=1` 이면
  hard-fail. 새 Xcode/macOS beta 마다 재검 — 회귀가 풀리면 이 게이트는 자연히 미발화(창이 뜨면 주입
  로그가 남아 3중 조건이 불성립).
- **로컬 Xcode 가 CI 보다 *느슨*할 수 있다 — Swift 6.0 vs 6.4 Sendable 진단 (2026-07-26, PR #946
  `swift-smoke-ios` fail 로 실측)**: 로컬 dev 머신이 Xcode 27 beta(Swift 6.4)면 CI `macos-26`
  (Swift 6.0) 이 **error 로 거부하는 코드를 조용히 통과시킨다**. 실제 사례: `queue.async { self?.f(dict) }`
  에서 `[String: Any]`(non-Sendable) 를 `@Sendable` 클로저로 캡처 — 6.4 는 region-based isolation 이
  개선돼 허용, 6.0 은 `capture of 'x' with non-Sendable type … in a '@Sendable' closure` 로 **exit 65**.
  같은 부류: 비-`@Sendable` 클로저 프로퍼티를 로컬로 hoist 해 `Task { }` 안에서 호출하는 패턴
  (`let hook = onX; Task { @MainActor in hook?(…) }`). 회피형은 **값을 경계에서 Sendable 타입으로
  좁히고**(dict → `Data`), 콜백은 hoist 하지 말고 `Task { @MainActor [weak self] in self?.onX?(…) }`
  로 `self` 를 캡처해 main 에서 읽는 것 (`RelayClient` 전반의 기존 관용구). **로컬 5플랫폼 빌드 그린이
  CI 그린을 함의하지 않는다** — 새 동시성 코드를 추가하면 CI `swift-smoke-ios`/`swift-build` 결과까지
  보고 판단할 것.
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

## 실-Claude / 실-daemon E2E 게이트 (TP_E2E_*) — SoT 분리

실 daemon E2E(`TP_E2E_REAL`), 실 claude PRINT/M5/CODING/WEBPAGE(`TP_E2E_CLAUDE*`, `TP_E2E_WEBPAGE`), 실 push(`TP_E2E_PUSH`), runner/daemon-parity(`TP_E2E_RUNNER_BIN`/`TP_E2E_DAEMON_BIN`), 소크 프리셋(`scripts/ios.sh soak`) 의 절차·assert·env 표 전체는 `.claude/rules/native-e2e-gates.md` (SoT, `scripts/ios.sh`·`rust/tp-e2e-holder/**` 작업 시 자동 로드). 전부 **로컬 전용** — CI(`swift-smoke-ios`)에서 절대 돌지 않는다.

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
