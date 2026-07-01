# Teleprompter — native iOS / iPadOS / macOS / visionOS / watchOS app (Swift)

ADR-0001 전면 재작성의 앱 트랙 + ADR-0002 Apple 멀티플랫폼 확장. 단일 멀티플랫폼
SwiftUI 타깃(iOS/iPadOS/macOS/visionOS) + 별도 `TeleprompterWatch` 타깃(watchOS 제한 경험,
Phase B3 ✅) + Rust `tp-core` FFI (UniFFI). 빌드/배포/검증은 **로컬 하니스**로
한다 (EAS 없음): iOS/iPadOS = iOS Simulator, macOS = native macOS (Catalyst 아님),
visionOS = visionOS Simulator, watchOS = watchOS Simulator (Phase B3, 7 markers).

Rust 코어 자체(crate, 와이어 불변식, xcframework 빌드)는 [`../rust/README.md`](../rust/README.md) 참조.

## 구조

```
ios/
  project.yml          # XcodeGen 스펙 (SoT, 체크인됨) — URL scheme/scene manifest/entitlements 포함
                       # platform: auto + supportedDestinations: [iOS, macOS, visionOS] — 단일 소스, 4 대상
  Teleprompter.entitlements        # keychain-access-groups (iOS/iPadOS Simulator 용)
  Teleprompter-macOS.entitlements  # macOS 엔타이틀먼트 (keychain-access-groups; ad-hoc 로컬 빌드용)
  Sources/             # 앱 소스 (SwiftUI — iOS/iPadOS/macOS 공유, #if os(macOS) 조건부 분기)
    TeleprompterApp.swift  # @main + .onOpenURL 딥링크 라우팅 + RootView (페어링 목록)
    ContentView.swift  # 부팅 마커 TP_BOOT_OK + tp-core 라운드트립 결과(TP_CORE_OK) 방출
    TpCoreCheck.swift  # FFI 자가검사: encode→encrypt→decrypt→decode 라운드트립
    Pairing/
      PairingStore.swift     # tp://p?d=… 인제스트 → Keychain(secret)+UserDefaults(meta/frontendId)
      DeepLinkHandler.swift  # tp:// 라우팅 + TP_PAIR_OK/TP_PAIR_FAIL 마커
    Relay/
      RelayMessages.swift    # relay 프로토콜 v2 Codable wire 타입 (types/relay.ts 와 동일 필드명)
      RelayClient.swift      # URLSessionWebSocketTask 래퍼 — relay.auth(role=frontend) + TP_RELAY_AUTH_OK
  Tests/               # XCTest (Simulator 에서 실행)
    SmokeTests.swift
    TpCoreTests.swift  # tp-core FFI 단위 테스트 (codec/kx/aead/pairing)
    PairingStoreTests.swift  # M1 페어링 인제스트 (decode→persist→load, Keychain 왕복)
    RelayAuthTests.swift     # M2 relay.auth wire-byte 계약 + 토큰 골든 일치 + 클라 라이프사이클
    TerminalEmulatorTests.swift  # Phase 3.x A1: SwiftTerm SGR colour + CUP/EL + probe-survives
  Generated/           # ⚠️ 생성물 — gitignore. UniFFI Swift 바인딩 (scripts/ios.sh rust)
  Teleprompter-Info.plist   # ⚠️ 생성물 — gitignore. XcodeGen 이 project.yml info.properties 에서 생성
  Teleprompter.xcodeproj/   # ⚠️ 생성물 — gitignore. `xcodegen generate` 로 재생성
```

`.xcodeproj`, `Generated/`, `Teleprompter-Info.plist` 는 체크인하지 않는다 (모두
`project.yml` 에서 재생성). `project.yml` + `Teleprompter.entitlements` +
`Teleprompter-macOS.entitlements` 가 SoT 이고, 프로젝트는 `scripts/ios.sh gen`
(= `xcodegen generate`), 바인딩은 `scripts/ios.sh rust` (= `../rust/build-xcframework.sh`)
으로 재현 가능하게 생성한다. 앱 타깃은 `../rust/target/TpCore.xcframework`
(정적 라이브러리, **7 슬라이스**: ios-device / ios-sim-fat / macos-fat / xros-device /
xros-sim / watchos-device / watchos-sim, `embed: false`) 를 링크한다.

### 멀티플랫폼 빌드 (Phase A2 + B2 + B3)

`project.yml` 이 `platform: auto` + `supportedDestinations: [iOS, macOS, visionOS]` 로 선언돼
단일 소스트리가 4 대상을 빌드한다. watchOS 는 **별도 `TeleprompterWatch` 타깃** (B3) +
**TestFlight 배포는 메인 iOS 앱 컴패니언 임베드** 방식이다 (ADR-0004 Amendment 2, #123). `Teleprompter`
멀티플랫폼 타깃이 `- target: TeleprompterWatch / embed: true / destinationFilters: [iOS]` 의존을 가져
watch 가 iOS 슬라이스에만 임베드된다 (macOS/visionOS 슬라이스는 스킵). 배포 시 watch 는 iOS `.ipa` 안
`Payload/Teleprompter.app/Watch/TeleprompterWatch.app` 에 동반 출하되며, ASC 레코드는
`dev.tpmt.app` 단일 레코드 (`altool --type ios`) 만 필요하다. 별도 컨테이너 앱 없음. watch 번들 ID
= `dev.tpmt.app.watchkitapp` (단일, 구 컨테이너 `dev.tpmt.app.watch` 폐지). watch 는 여전히 독립
실행된다 (`WKRunsIndependentlyOfCompanionApp=YES`). Simulator smoke 는 `TeleprompterWatch` 를 직접
빌드(배포 경로와 무관, 독립 런타임 증명); `TP_PLATFORM=watchos archive` 는 `die` (watch 는 iOS `.ipa` 에
탑승 — 별도 archive 없음):

| 대상 | SDK | 검증 방법 |
|------|-----|-----------|
| iPhone + iPad | `iphonesimulator` / `iphoneos` | `TP_PLATFORM=ios scripts/ios.sh smoke` |
| native macOS | `macosx` | `TP_PLATFORM=macos scripts/ios.sh smoke` |
| visionOS Simulator | `xrsimulator` | `TP_PLATFORM=visionos scripts/ios.sh smoke` |
| watchOS Simulator (B3 ✅) | `watchsimulator` | `TP_PLATFORM=watchos scripts/ios.sh smoke` |

> **watchOS 타깃은 명시적 source allow-list 다 — 새 공유 소스를 추가하면 watch 빌드가 깨진다.**
> iOS/iPadOS/macOS/visionOS 는 `platform: auto` 멀티플랫폼 타깃이라 `Sources/**` 전체를 자동으로
> 컴파일하지만, `TeleprompterWatch` 타깃은 `project.yml` 에서 **개별 파일을 하나씩 나열**한다
> (UIKit/APNs/AVFoundation 의존 파일을 빼기 위함). 그래서 watch 가 컴파일하는 파일
> (`RelayClient.swift` 등) 이 **새 공유 심볼**을 참조하면 — 그 심볼이 watch source list 에 없는
> 파일에 정의돼 있을 경우 — watchOS 빌드만 `cannot find type … in scope` 로 깨진다 (다른 4 플랫폼은
> 통과). 두 가지 수정 패턴: (1) 새 심볼이 **플랫폼 중립**(Foundation/os/Combine 만)이면 그 파일을
> watch source list 에 추가(예: `RelayWorktreeOps.swift`, `WorktreeStore.swift`); (2) **iOS 전용**
> (APNs/UserNotifications/UIKit)이면 호출부를 `#if !os(watchOS)` 로 가드(예: `PushTokenObserver`/
> `PushTokenStore`/`NotificationService`). **공유 파일에 새 타입/콜백을 추가하면 반드시
> `TP_PLATFORM=watchos scripts/ios.sh build` 로 watch 빌드를 확인**하라 — `scripts/ios.sh all` 의
> watchOS 행이 이 회귀를 잡는 최종 게이트다.

macOS 는 **Mac Catalyst 아님** (`SUPPORTS_MACCATALYST=NO`). macOS 대상은
`[sdk=macosx*]` 조건부 빌드 설정으로 `Teleprompter-macOS.entitlements` 를 선택한다.

**ad-hoc macOS 서명 제한사항**: `app-sandbox`, `network.client` 엔타이틀먼트는
Developer ID / MAS 인증서 없이는 요청 불가 — 로컬 `open` 실행 macOS 앱은 샌드박스
없이도 동작한다. `kSecAttrSynchronizable` 은 macOS 에서 `kCFBooleanFalse` (iCloud sync
비활성 — `#if os(macOS)` 조건부, `PairingStore.swift`).

**visionOS 공간 UX (B2)**: `#if os(visionOS)` 조건부로 `TabView` 탭 컨텐츠에
`.glassBackgroundEffect()` 적용 + `.defaultSize(width: 960, height: 640)` 초기 창 크기.
TabView 스타일은 플랫폼 기본값(탭 바 ornament) — 별도 override 불필요.
`#if os(iOS) || os(visionOS)` 로 UIKit `UIAccessibility` import 가드 추가 (LiveRegion).
APNs 등록은 visionOS 에서 skip (Simulator 단계, 엔타이틀먼트 미설정 — `NotificationService.swift`).

### 딥링크 / Keychain (M1)

앱은 `tp://p?d=…` 페어링 딥링크를 받는다. 작동에 필요한 셋업 (전부 `project.yml` 에 박혀 있음):
- **URL scheme**: `CFBundleURLTypes` 에 `tp` 등록 (Info.plist 명시 필요 — `INFOPLIST_KEY_*` 없음).
- **Scene manifest**: `UIApplicationSceneManifest` 가 있어야 SwiftUI `.onOpenURL` 이 inbound URL
  을 받는다 (없으면 iOS 26 Simulator 가 URL context 를 조용히 버림). 자체 `UISceneDelegateClassName`
  은 선언하지 말 것 — SwiftUI 가 scene 을 소유하며 무시한다.
- **Keychain entitlement + ad-hoc 서명**: 미서명 Simulator 빌드는 entitlement 이 없어
  `SecItemAdd` 가 `-34018` (errSecMissingEntitlement) 로 실패. `Teleprompter.entitlements`
  (`keychain-access-groups`) + ad-hoc 서명 (`CODE_SIGN_IDENTITY=-`) 으로 해결.

**iOS/visionOS 26.5 Simulator URL scheme 라우팅 이슈**: iOS/visionOS 26.5 Simulator 에서
`xcrun simctl openurl` 이 ad-hoc 서명된 sideload 앱에 대해 LaunchServices `-10814`
("Error fetching bundle record for scheme approval") 를 반환하며 URL 이 앱에 전달되지 않는다.
smoke 하니스는 `--tp-smoke-url <link>` launch arg 로 URL 을 주입해 LS 라우팅을 우회한다
(`TeleprompterApp.handleSmokeURLIfPresent()` → `DeepLinkHandler.handle()` 직접 호출).
실제 사용자 QR 스캔 경로는 영향받지 않는다 (앱 내부에서 파싱, LS 라우팅 불필요).

## 하니스 (`scripts/ios.sh`)

```bash
# iOS/iPadOS (기본, TP_PLATFORM 미설정 또는 ios)
scripts/ios.sh smoke   # rust → gen → build → install → launch → 8 마커 검증 (재실행 가능)
scripts/ios.sh rust    # TpCore.xcframework + Swift 바인딩 빌드 (rust/tp-core, 5 슬라이스)
scripts/ios.sh build   # iOS Simulator 용 빌드만
scripts/ios.sh run     # 설치 + 실행
scripts/ios.sh test    # XCTest 번들을 Simulator 에서 실행 (xcframework 먼저)
scripts/ios.sh uitest      # XCUITest UI E2E (단일 플랫폼; TP_PLATFORM 분기)
scripts/ios.sh uitest-all  # XCUITest UI E2E 전 플랫폼 매트릭스 (iOS/iPad/macOS/visionOS 실행 + watchOS 자동 SKIP; PASS/SKIP/FAIL 표, exit=FAIL 있으면 nonzero)
scripts/ios.sh gen     # project.yml → .xcodeproj 재생성
scripts/ios.sh boot    # 대상 시뮬레이터 부팅 (idempotent)

# native macOS (TP_PLATFORM=macos)
TP_PLATFORM=macos scripts/ios.sh build  # macOS 앱 빌드 (Debug, My Mac 대상)
TP_PLATFORM=macos scripts/ios.sh smoke  # macOS 8 마커 smoke (log stream 기반 — Keychain 자동 청소)

# visionOS Simulator (TP_PLATFORM=visionos, Phase B2)
TP_PLATFORM=visionos scripts/ios.sh build  # visionOS Simulator 빌드 (Debug-xrsimulator)
TP_PLATFORM=visionos scripts/ios.sh smoke  # visionOS 8 마커 smoke (xcrun simctl, --tp-smoke-url 주입)
TP_PLATFORM=visionos scripts/ios.sh run    # visionOS Simulator 에 설치 + 실행

# watchOS Simulator (TP_PLATFORM=watchos, Phase B3)
TP_PLATFORM=watchos scripts/ios.sh build  # watchOS Simulator 빌드 (Debug-watchsimulator, TeleprompterWatch 타깃)
TP_PLATFORM=watchos scripts/ios.sh smoke  # watchOS 7 마커 smoke (TP_INPUT_OK 제외 — 글런스 전용 앱)

# iPadOS Simulator (TP_PLATFORM=ipad — iOS 경로 alias, 별도 xcframework 슬라이스 없음)
TP_PLATFORM=ipad scripts/ios.sh smoke    # iPad Pro 13-inch (M5) 부팅 + 8 마커 (split-view/sidebar 레이아웃)

# UI E2E (XCUITest — 실제 SwiftUI 렌더/탭/페인 전환을 검증; 마커 E2E 와 별개 레이어)
scripts/ios.sh uitest                    # iOS: 세션 row 탭 → 페인 picker → 'Claude:' 버블 단언 (loopback)
TP_PLATFORM=macos scripts/ios.sh uitest  # macOS: 동일 플로우 (호스트 TCC 게이트 미충족 시 SKIP, exit 0)
# watchOS 는 XCUIApplication 부재 — uitest 거부. visionOS 는 부분(쿼리+flat tap, 공간 제스처 sim 불가).

# 5-플랫폼 매트릭스 (각 플랫폼 TP_JSON 으로 순차 실행 후 pass/elapsed/markers 표 출력)
scripts/ios.sh all                       # ios/ipad/macos/visionos(8/8) + watchos(7/7); exit = 최악 플랫폼

# 구조화 출력 / 산출물
TP_JSON=1 scripts/ios.sh smoke           # 마지막 줄에 {"platform":…,"markers":{…},"passed":…,"elapsed_s":…}
TP_E2E_REAL=1 scripts/ios.sh smoke       # FAKE loopback 대신 격리된 실 tp daemon+relay 로 M0-M2 페어링 E2E
TP_E2E_CLAUDE=1 scripts/ios.sh smoke     # 위 + 실 claude -p PRINT 세션 spawn → M0-M4 (실 Stop 렌더). claude PATH 필수, 로컬 전용
TP_E2E_CLAUDE_M5=1 scripts/ios.sh smoke  # 위 + 실 INTERACTIVE claude 세션 → 전 8마커 (M0-M5: 앱→relay→daemon→PTY→claude 입력 왕복). 로컬 전용
TP_E2E_CLAUDE_CODING=1 scripts/ios.sh smoke  # M5 의 sibling. 실 INTERACTIVE claude 를 멀티턴으로 조작해 파일 생성/편집+빌드 → M0-M4 + 코딩 어서션 (PostToolUse Write/Bash, tp_qa_marker.txt). 로컬 전용
TP_E2E_WEBPAGE=1 scripts/ios.sh smoke    # CODING 의 sibling. 실 INTERACTIVE claude 를 2턴으로 원격 조작해 완전한 HTML5 웹페이지(index.html) 빌드+Bash 검증 → M0-M4 + 웹페이지 어서션 (DOCTYPE/html/body/style/marker, PostToolUse Write/Bash). CODING 과 동시 set 시 WEBPAGE 우선. 로컬 전용
TP_E2E_PUSH=1 scripts/ios.sh smoke       # PRINT(claude -p)의 sibling. 합성 Notification 주입 → in-band relay.notification → 앱 onNotification 수신(M6 TP_PUSH_NOTIFY_RECEIVED). 로컬 전용

# TestFlight 배포 (ADR-0004 — iOS device 슬라이스 Release archive → 서명 → App Store .ipa export)
TP_DEVELOPMENT_TEAM=ABCDE12345 TP_PLATFORM=ios scripts/ios.sh archive   # 실 Distribution 인증서+프로필 필요 (login keychain 또는 CI 일회용 keychain)
# CI(.github/workflows/testflight.yml)가 v* 태그 push 시 이 archive + xcrun altool 업로드를 자동화한다.
# 로컬 직접 실행 시: Xcode-관리 Distribution cert + dev.tpmt.app App Store 프로필이 keychain 에 있어야 함.
# 빌드번호는 TP_BUILD_NUMBER 로 오버라이드(미설정 시 project.yml "1"). 산출 .ipa 경로를 stdout 으로 emit.
```

환경 변수:
- `TP_PLATFORM` — 빌드/smoke 대상 플랫폼. `ios` (기본), `ipad`, `macos`, `visionos`, 또는 `watchos`.
  `ios` 는 기존 동작과 바이트 동일. `ipad` 는 iOS 경로 alias (iPad 시뮬레이터를 부팅; 별도
  xcframework 슬라이스 없이 `ios-arm64_x86_64-simulator` 재사용, 8 마커 동일). `macos` 는
  native macOS 빌드 + `open` 기반 실행. `visionos` 는 visionOS Simulator 빌드 + `xcrun simctl`
  기반 실행. `watchos` 는 `TeleprompterWatch` 타깃을 watchOS Simulator 에 빌드/설치/실행, 7 마커.
- `TP_SIM` — iOS/iPadOS 시뮬레이터 디바이스 이름 (iOS 기본 `iPhone 17 Pro`, ipad 기본
  `iPad Pro 13-inch (M5)`). 동명 시뮬레이터가 여러 OS 버전으로 존재하면 (예: M5 iPad 2개)
  하니스가 고유 UDID 를 해석해 `-destination id=<udid>` 로 타깃 — 이름 기반 ambiguity 회피.
- `TP_VISION_SIM` — visionOS 시뮬레이터 디바이스 이름 (기본 `Apple Vision Pro`)
- `TP_WATCH_SIM` — watchOS 시뮬레이터 디바이스 이름 (기본 `Apple Watch Series 11 (46mm)`)
- `TP_SCHEME` — Xcode scheme (기본 `Teleprompter`; watchOS 는 `TeleprompterWatch` 타깃 직접 빌드)
- `TP_FORCE_RUST=1` — xcframework 가 이미 있어도 매 빌드마다 재빌드 (Rust 소스 수정 후)
- `TP_SKIP_RUST=1` — xcframework 재빌드 스킵 (기존 산출물 필수; Rust 미변경 빠른 반복)
- `TP_JSON=1` — `smoke` 가 마지막 줄에 한 줄짜리 JSON 요약을 emit
  (`{"platform":…,"markers":{…},"passed":bool,"elapsed_s":N}`). 텍스트 출력은 미설정 시 불변.
  `cmd_all` 이 5-플랫폼 매트릭스를 집계하는 데 사용.
- `TP_E2E_REAL=1` — `smoke` 가 FAKE loopback 대신 격리된 **실** `tp` daemon+relay 를 띄워
  M0-M2(boot/core/pair/relay-auth) 페어링 E2E. daemon 은 임시 `XDG_*` 디렉터리로 격리되어
  dogfood daemon 과 충돌하지 않는다. M3(kx)+ 는 실 daemon kx 레이스로 범위 밖 (loopback 이 M3-M5 커버).
- `TP_E2E_CLAUDE=1` — `TP_E2E_REAL` 의 superset. 페어링과 **동시에**(세션을 먼저 등록하도록 페어링 *전*에)
  격리 daemon 에 **실 `claude -p` PRINT 세션**을 `tp run --socket-path <격리 socket>` 로 spawn → 앱 hello 가
  `sessions=1` 을 받아 auto-attach 해 **실 Stop 의 `last_assistant_message` 를 Chat 에 렌더** →
  M0-M4(7마커, M5 제외 — print 모드는 입력 도착 전에 종료). `claude` PATH 필수. OAuth 토큰은 추출 *전*
  refresh(실 config 로 `claude -p` 한 번 — stale 토큰 401 회피) 후 keychain
  (`Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>`)에서 추출해 `CLAUDE_CODE_OAUTH_TOKEN` 으로
  주입. **로컬 전용 — 절대 CI 에서 안 돈다** (인증·비용·비결정론·keychain 의존). 세션 sid/cwd/prompt 는
  `TP_E2E_CLAUDE_SID`/`_CWD`/`_PROMPT` 로 오버라이드.
- `TP_E2E_CLAUDE_M5=1` — `TP_E2E_CLAUDE` 의 superset, **전 8마커(M0-M5)**. 격리 daemon 에 **실 INTERACTIVE
  claude 세션**(`--permission-mode bypassPermissions`, no `-p`)을 spawn → holder 가 trust 프롬프트를 IPC
  `\r` 로 수락(claude REPL idle) → 앱이 attach 후 `in.chat "tp-input-probe"` 를 relay 로 전송 → daemon 이
  `\n` 붙여 PTY 제출 → claude 응답 → **새 assistant Stop** chat item 이 `TP_INPUT_OK proof=response` 를
  emit. 진짜 app→relay→daemon→PTY→claude 입력 경로의 E2E 증명. M4 도 포함하므로 dogfood 전엔 이 한 번이면
  충분. `claude` PATH 필수, **로컬 전용**.
- `TP_E2E_CLAUDE_CODING=1` — `TP_E2E_CLAUDE_M5` 의 **sibling**(둘 중 하나만). M5 처럼 실 INTERACTIVE claude 를
  spawn 하되, holder 가 **멀티턴**으로 조작해 claude 가 실제로 파일을 생성/편집하고 빌드를 돌리게 한다 → M0-M4
  + **코딩 어서션**: `PostToolUse(Write)`+`PostToolUse(Bash)` 훅 이벤트가 둘 다 파일을 참조하고,
  `UserPromptSubmit=2`/`Stop=2`(2턴), disk 에 `tp_qa_marker.txt`=`QA-CODING-OK` 가 남는다. M5 입력 probe 는
  coding 모드에서 억제(`--tp-no-input-probe`)된다. `claude` PATH 필수, **로컬 전용**. 세부 = `.claude/rules/native-testing.md`.
- `TP_E2E_WEBPAGE=1` — `TP_E2E_CLAUDE_CODING` 의 **sibling**. 동일한 holder+pipeline 로 실 INTERACTIVE claude 를
  2턴 원격 조작해 **완전한 HTML5 정적 웹페이지**(`index.html`)를 빌드한다 → M0-M4 + **웹페이지 어서션**:
  `<!DOCTYPE html>`·`<html`·`<body`·`</html>`·마커(`TP-WEBPAGE-OK`)·`<style` 전부 포함 확인,
  `PostToolUse(Write)`+`PostToolUse(Bash)` 훅 이벤트 둘 다 파일 참조, `UserPromptSubmit=2`/`Stop=2`.
  파일명/마커 = `TP_E2E_WEBPAGE_FILE`/`TP_E2E_WEBPAGE_MARKER` 로 오버라이드. CODING 과 동시 set 시 WEBPAGE 우선.
  M5 probe 억제(`--tp-no-input-probe`). `claude` PATH 필수, **로컬 전용**. 세부 = `.claude/rules/native-testing.md`.
- `TP_E2E_PUSH=1` — `TP_E2E_CLAUDE`(print)의 **sibling**(E2E_REAL+E2E_CLAUDE imply). **푸시 RECEIVE 경로**를 실
  relay/daemon 으로 증명: 앱이 `--tp-push-smoke` 하에 합성 push 토큰을 등록하고, holder 가 IPC `rec`
  (`event/Notification`)을 주입 → daemon PushNotifier → relay **in-band** `relay.notification` → 앱
  `onNotification` 이 **M6 `TP_PUSH_NOTIFY_RECEIVED`** 를 emit. 실 APNs 없이 가능한 유일한 leg(frontend 가
  소켓에 live → relay 가 APNs 대신 in-band 전달). 정직한 범위: in-band 만 — 실 APNs 전달/디바이스 토큰
  수신(`didRegister`)/tap→nav(`didReceive`)는 entitlement+실기기+.p8 필요(Dave-gated). M6 는 default 8/7
  마커 셋에 없음(`TP_E2E_PUSH` 하에서만 assert). `claude` PATH 필수, **로컬 전용**. 세부 = `.claude/rules/native-testing.md`.
- `TP_ARTIFACT_DIR` — smoke 가 마커 폴링 후 스크린샷(+선택 비디오)을 떨구는 디렉터리
  (기본 `/tmp/tp-artifacts`). UI 자동화가 불가한 watchOS/visionOS 에서도 스크린샷은 동작.

### macOS smoke 메모

macOS 는 `log show --last Ns` 로 과거 로그를 읽을 수 없다 — 앱 번들의 Default 레벨
메시지가 historical log 에 누락되는 macOS 동작 때문. 하니스는 앱 실행 **전에**
`/usr/bin/log stream --predicate "subsystem == ..."` 를 백그라운드로 시작해 실시간으로
마커를 캡처한다.

macOS Keychain ACL: 빌드할 때마다 코드 서명이 바뀌어 이전 smoke 가 남긴 Keychain 항목이
ACL 프롬프트를 띄워 앱을 막는다. 하니스가 앱 실행 전에 자동으로 해당 항목을 삭제한다.

OSLog privacy: macOS native 빌드는 String 변수 보간을 기본 `<private>` 로 처리한다
(iOS Simulator 개발 빌드는 강제하지 않음). 모든 마커 로그 라인은
`privacy: .public` 를 명시해야 한다 (RelayClient.swift, DeepLinkHandler.swift 모두 적용됨).

## 검증 규약

- **부팅 마커**: `ContentView.onAppear` 가 `os.Logger` 로 `TP_BOOT_OK` 를 방출하고,
  `scripts/ios.sh smoke` 가 `subsystem == dev.tpmt.app` 예측자로 Simulator
  통합 로그에서 이 문자열을 확인한다.
- **코어 마커**: 같은 `onAppear` 가 `TpCoreCheck.summary()` 를 호출해
  `TP_CORE_OK v<ver>` (성공) 또는 `TP_CORE_FAIL step=… detail=…` (실패) 를 방출한다.
  이는 Rust 정적 라이브러리가 **링크됐고 동작함**을 증명한다 (단순 존재가 아니라
  encode→encrypt→decrypt→decode 라운드트립이 실기 런타임에서 통과). smoke 가 두 마커를
  모두 확인하며, `TP_CORE_FAIL` 이면 step/detail 을 출력하고 실패시킨다.
  마커 상수를 바꾸면 `scripts/ios.sh` 도 같이 바꾼다.
- **페어링 마커 (M1)**: smoke 가 결정적 `tp://p?d=…` 딥링크를 `--tp-smoke-url` launch arg
  로 주입하면 앱 `onAppear` 에서 `handleSmokeURLIfPresent()` → `DeepLinkHandler.handle()` →
  FFI `decodePairingData` → `PairingStore` → Keychain 왕복을 daemon 없이 end-to-end 검증.
  `TP_PAIR_OK did=daemon-smoketest` 확인. 실패 시 `TP_PAIR_FAIL detail=…` 출력 후 실패.
  링크는 `smoke_pair_link` (pairing.rs v3 레이아웃을 바이트 동일하게 Python 으로 생성).
  (이전: `xcrun simctl openurl` 사용 — iOS/visionOS 26.5 Simulator 에서 LS -10814 error 로
  URL 이 앱에 전달되지 않는 회귀 발견. launch arg 주입으로 LS 라우팅 우회.)
- **릴레이 인증 마커 (M2)**: M1 과 같은 딥링크 하나로 — smoke 가 로컬 loopback relay
  (`scripts/local-relay-loopback.ts`, 골든 토큰 pre-seed) 를 띄우고, golden-secret +
  `ws://localhost` 링크를 주입하면 앱이 인제스트 직후 자동 `relay.auth(role=frontend)` 를
  보낸다. `TP_RELAY_AUTH_OK daemon=daemon-smoketest` (앱) + relay `/health clients>=1`
  (릴레이) 양면 확인 — 실제 WS 왕복 = 첫 E2E 네트워크 신호. 실패 시
  `TP_RELAY_AUTH_FAIL detail=…`. 토큰은 FFI `deriveRelayToken` (= Rust 골든벡터와 바이트 일치).
- 새 마일스톤마다 `scripts/ios.sh smoke` + `scripts/ios.sh test` 를 돌려 회귀를 차단한다.
  (Rust 호스트 테스트 = `cd rust && cargo test -p tp-core`, 와이어 골든벡터 포함.)
  현재: smoke (iOS) = 8 마커 (boot+core+pairing+relay-auth+kx+frame+session+input),
  smoke (macOS) = 8 마커 동일, XCTest 115/115 (iOS Simulator), Rust 호스트 20/20.

## Swift strictness (Swift 6 language mode)

앱 타깃은 **Swift 6 언어 모드 + 완전 동시성 검사 + 경고=에러**로 빌드된다 (`ios/project.yml`
`settings.base`):

```yaml
SWIFT_VERSION: "6.0"                  # Swift 6 언어 모드 — 데이터 레이스 안전성이 에러
SWIFT_STRICT_CONCURRENCY: complete    # 전체 actor-isolation / Sendable 진단
SWIFT_TREAT_WARNINGS_AS_ERRORS: "YES" # 경고가 조용히 회귀하지 못함 (deprecation 포함)
```

네이티브 재작성을 처음부터 동시성-정확하게 작성했기에 세 레버를 **한꺼번에** 켰고, 네 플랫폼
(macOS/iOS/visionOS/watchOS) 모두 진단 0으로 빌드된다. 적용 시 정리한 패턴(코드 주석에 근거 기록):

- **UI 구동 타입/뷰모델/스토어** (`PairingViewModel`, `SettingsStore`, voice capture/player
  프로토콜·구현, `MicCapture`/`PcmAudioPlayer`, `QRScannerCoordinator`) → `@MainActor`.
- **스레드를 진짜 넘는 콜백** (오디오 탭→메인, URLSession 큐→메인) → 클로저 타입에 `@Sendable`,
  본문에서 `Task { @MainActor in … }` 로 홉. 오디오 탭 콜백은 `self`(@MainActor)를 읽지 않도록
  로컬 상수로 캡처 후 사용 (`MicCapture`).
- **델리게이트 큐가 메인임이 보장된 동기 콜백** (`RealtimeClient`/`QRScannerCoordinator`의
  `queue: .main` 델리게이트) → `nonisolated` + `MainActor.assumeIsolated { … }` (억제가 아니라
  단언 — 보장이 깨지면 크래시).
- **손으로 동기화한 클래스** (`RelayClient`: `Task{@MainActor}` 홉 + `nonisolated(unsafe)` 쓰기
  규율) → `@unchecked Sendable`. 시스템-스레드세이프 핸들만 보유한 스토어(`PairingStore`:
  `UserDefaults`/Keychain) → `@unchecked Sendable`.
- **ObjC associated-object 키 토큰** (주소만 사용) → `nonisolated(unsafe) static var key = 0`.
- **deprecated API** (WAE 로 에러화): `onChange(of:perform:)`→2-param, `devices(for:)`→
  `DiscoverySession`, `requestRecordPermission`→`AVAudioApplication`(iOS17+ availability-gated),
  `allowBluetooth`→`allowBluetoothHFP`.
- **생성물** `Generated/tp_core.swift`: UniFFI 0.28 의 `var initializationResult` 는
  `rust/build-xcframework.sh` 의 post-gen `sed` 가 `nonisolated(unsafe)` 로 패치 (init-once 라
  레이스 불가; uniffi 0.29 에서 upstream fix — 그때 패치 제거).

> Apple AVFoundation 류 아직-Sendable-아님 타입은 `@preconcurrency import` 로 처리
> (`QRScannerView.swift`) — Apple 이 upstream 어노테이트하면 제거.

## 포맷/린트 (swift-format)

Apple 공식 `swift-format` (Xcode 번들, `xcrun swift-format` — Homebrew 불필요) 가 단일
포맷+린트 도구다. 설정은 repo 루트 `.swift-format` (4-space indent, lineLength 100 — rustfmt 와
정렬). 하니스:

```bash
scripts/ios.sh fmt    # swift-format format -i (포맷 규칙만 in-place 적용; 커밋 전 실행)
scripts/ios.sh lint   # swift-format lint --strict (gate — 위반 시 nonzero; cargo fmt --check 대응)
```

- `format` 은 **포맷 규칙만** 적용한다 — `AlwaysUseLowerCamelCase` 같은 lint-only 규칙은 절대
  자동 재작성하지 않으므로 식별자 이름이 바뀌지 않는다 (안전한 reflow).
- **`AlwaysUseLowerCamelCase` 는 `false`** (`.swift-format`): wire-bound `Decodable` 구조체
  (`RelayMessages.swift` 의 `HookEvent*`) 가 daemon 의 snake_case JSON 키를 synthesized Codable 로
  직접 미러링한다 — `session_id`/`last_assistant_message`/`tool_name` 등을 camelCase 로 바꾸면
  디코딩이 깨진다. 키워드 이스케이프 파라미터(`type_`/`protocol_`)도 같은 규칙에 걸려 함께 off.
- swift-format 의 config 는 **순수 JSON** (주석 키 금지 — `//foo` 를 넣으면 파싱 에러로 린트가
  조용히 무력화됨). 비활성 규칙의 근거는 이 README 에 둔다.
- SwiftLint(Realm)는 도입하지 않는다 — swift-format 이 Apple 공식 + 툴체인 번들이라 단일 도구로
  충분하고, 두 도구의 규칙 중복/충돌을 피한다.

### ANSI 터미널 에뮬레이터 (Phase 3.x A1)

**의존성**: SwiftTerm 1.13.0 (MIT, SPM) — `ios/project.yml` `packages:` 블록에 선언.

**아키텍처 결정**:
- `SessionStore.terminalOutput[sid]` (raw String 누산기) 는 유지. `RelayClient.checkInputEcho`
  가 `"tp-input-probe"` 토큰을 이 String 에서 스캔해 `TP_INPUT_OK` 를 발행한다. 절대 제거/우회 금지.
- `SessionStore.terminalByteSink` 는 **additive** 병렬 바이트 싱크 — `appendRec` 에서 String
  append 이후 실행. SwiftTerm 에뮬레이터에만 공급하고, String 경로는 건드리지 않는다.
- `SwiftTermView` (Sources/Session/SwiftTermView.swift): `UIViewRepresentable` 래퍼. sid 변경
  시 싱크 재등록, dismantleUIView 시 싱크 nil 처리.
- `TerminalView.swift` 의 `ScrollView+Text` 블록을 `SwiftTermView` 로 교체.

**A1 제한**:
- **Go-forward 전용**: 뷰가 나타나기 전 bytes (history backfill 포함) 는 에뮬레이터에 공급되지
  않는다 (`String.utf8` 재인코딩 vs 원본 `Data` 의 split multi-byte 발산 문제). `terminalOutput`
  (String) 은 full history 를 보유한다.
- **cols/rows 협상 없음**: SwiftTerm 기본값(80×24) 사용. A1 에서 daemon/runner 에 resize 신호
  미전송.

**테스트**: `TerminalEmulatorTests.swift` — SGR colour (ESC[31m → fg 속성 검증), CUP+EL 덮어쓰기,
probe-survives (String 누산기 독립성 검증). 모두 Simulator XCTest 로 실행 (`scripts/ios.sh test`).

## 요구 도구

- Xcode 26+ (iOS Simulator SDK), `xcodebuild`, `xcrun simctl`
- `xcodegen` (`brew install xcodegen`)
- Rust 툴체인 + iOS 타깃 (`../rust/README.md` 참조)
- (선택) `xcbeautify` — 있으면 빌드 로그를 예쁘게 출력
