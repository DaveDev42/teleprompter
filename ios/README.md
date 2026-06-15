# Teleprompter — native iOS / iPadOS / macOS / visionOS app (Swift)

ADR-0001 전면 재작성의 앱 트랙 + ADR-0002 Apple 멀티플랫폼 확장. 단일 멀티플랫폼
SwiftUI 타깃 + Rust `tp-core` FFI (UniFFI). 빌드/배포/검증은 **로컬 하니스**로
한다 (EAS 없음): iOS/iPadOS = iOS Simulator, macOS = native macOS (Catalyst 아님),
visionOS = visionOS Simulator (Phase B, B2 완료). watchOS(제한 경험)는 Phase B3.

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
(정적 라이브러리, **5 슬라이스**: ios-device / ios-sim-fat / macos-fat / xros-device /
xros-sim, `embed: false`) 를 링크한다.

### 멀티플랫폼 빌드 (Phase A2 + B2)

`project.yml` 이 `platform: auto` + `supportedDestinations: [iOS, macOS, visionOS]` 로 선언돼
단일 소스트리가 4 대상을 빌드한다:

| 대상 | SDK | 검증 방법 |
|------|-----|-----------|
| iPhone + iPad | `iphonesimulator` / `iphoneos` | `TP_PLATFORM=ios scripts/ios.sh smoke` |
| native macOS | `macosx` | `TP_PLATFORM=macos scripts/ios.sh smoke` |
| visionOS Simulator | `xrsimulator` | `TP_PLATFORM=visionos scripts/ios.sh smoke` |

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
scripts/ios.sh gen     # project.yml → .xcodeproj 재생성
scripts/ios.sh boot    # 대상 시뮬레이터 부팅 (idempotent)

# native macOS (TP_PLATFORM=macos)
TP_PLATFORM=macos scripts/ios.sh build  # macOS 앱 빌드 (Debug, My Mac 대상)
TP_PLATFORM=macos scripts/ios.sh smoke  # macOS 8 마커 smoke (log stream 기반 — Keychain 자동 청소)

# visionOS Simulator (TP_PLATFORM=visionos, Phase B2)
TP_PLATFORM=visionos scripts/ios.sh build  # visionOS Simulator 빌드 (Debug-xrsimulator)
TP_PLATFORM=visionos scripts/ios.sh smoke  # visionOS 8 마커 smoke (xcrun simctl, --tp-smoke-url 주입)
TP_PLATFORM=visionos scripts/ios.sh run    # visionOS Simulator 에 설치 + 실행
```

환경 변수:
- `TP_PLATFORM` — 빌드/smoke 대상 플랫폼. `ios` (기본), `macos`, 또는 `visionos`.
  `ios` 는 기존 동작과 바이트 동일. `macos` 는 native macOS 빌드 + `open` 기반 실행.
  `visionos` 는 visionOS Simulator 빌드 + `xcrun simctl` 기반 실행.
- `TP_SIM` — iOS 시뮬레이터 디바이스 이름 (기본 `iPhone 17 Pro`, iOS 경로에서만 사용)
- `TP_VISION_SIM` — visionOS 시뮬레이터 디바이스 이름 (기본 `Apple Vision Pro`)
- `TP_SCHEME` — Xcode scheme (기본 `Teleprompter`)
- `TP_FORCE_RUST=1` — xcframework 가 이미 있어도 매 빌드마다 재빌드 (Rust 소스 수정 후)
- `TP_SKIP_RUST=1` — xcframework 재빌드 스킵 (기존 산출물 필수; Rust 미변경 빠른 반복)

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
  `scripts/ios.sh smoke` 가 `subsystem == dev.tpmt.teleprompter` 예측자로 Simulator
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
  smoke (macOS) = 8 마커 동일, XCTest 48/48 (iOS Simulator), Rust 호스트 20/20.

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
