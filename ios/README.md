# Teleprompter — native iOS app (Swift)

ADR-0001 전면 재작성의 앱 트랙. SwiftUI 네이티브 앱 + Rust `tp-core` FFI (UniFFI).
빌드/배포/검증은 **로컬 iOS Simulator 하니스**로 한다 (EAS 없음).

Rust 코어 자체(crate, 와이어 불변식, xcframework 빌드)는 [`../rust/README.md`](../rust/README.md) 참조.

## 구조

```
ios/
  project.yml          # XcodeGen 스펙 (SoT, 체크인됨) — URL scheme/scene manifest/entitlements 포함
  Teleprompter.entitlements  # keychain-access-groups (체크인됨, Simulator Keychain 용)
  Sources/             # 앱 소스 (SwiftUI)
    TeleprompterApp.swift  # @main + .onOpenURL 딥링크 라우팅 + RootView (페어링 목록)
    ContentView.swift  # 부팅 마커 TP_BOOT_OK + tp-core 라운드트립 결과(TP_CORE_OK) 방출
    TpCoreCheck.swift  # FFI 자가검사: encode→encrypt→decrypt→decode 라운드트립
    Pairing/
      PairingStore.swift     # tp://p?d=… 인제스트 → Keychain(secret)+UserDefaults(meta/frontendId)
      DeepLinkHandler.swift  # tp:// 라우팅 + TP_PAIR_OK/TP_PAIR_FAIL 마커
  Tests/               # XCTest (Simulator 에서 실행)
    SmokeTests.swift
    TpCoreTests.swift  # tp-core FFI 단위 테스트 (codec/kx/aead/pairing)
    PairingStoreTests.swift  # M1 페어링 인제스트 (decode→persist→load, Keychain 왕복)
  Generated/           # ⚠️ 생성물 — gitignore. UniFFI Swift 바인딩 (scripts/ios.sh rust)
  Teleprompter-Info.plist   # ⚠️ 생성물 — gitignore. XcodeGen 이 project.yml info.properties 에서 생성
  Teleprompter.xcodeproj/   # ⚠️ 생성물 — gitignore. `xcodegen generate` 로 재생성
```

`.xcodeproj`, `Generated/`, `Teleprompter-Info.plist` 는 체크인하지 않는다 (모두
`project.yml` 에서 재생성). `project.yml` + `Teleprompter.entitlements` 가 SoT 이고,
프로젝트는 `scripts/ios.sh gen` (= `xcodegen generate`), 바인딩은 `scripts/ios.sh rust`
(= `../rust/build-xcframework.sh`) 으로 재현 가능하게 생성한다. 앱 타깃은
`../rust/target/TpCore.xcframework` (정적 라이브러리, `embed: false`) 를 링크한다.

### 딥링크 / Keychain (M1)

앱은 `tp://p?d=…` 페어링 딥링크를 받는다. 작동에 필요한 셋업 (전부 `project.yml` 에 박혀 있음):
- **URL scheme**: `CFBundleURLTypes` 에 `tp` 등록 (Info.plist 명시 필요 — `INFOPLIST_KEY_*` 없음).
- **Scene manifest**: `UIApplicationSceneManifest` 가 있어야 SwiftUI `.onOpenURL` 이 inbound URL
  을 받는다 (없으면 iOS 26 Simulator 가 URL context 를 조용히 버림). 자체 `UISceneDelegateClassName`
  은 선언하지 말 것 — SwiftUI 가 scene 을 소유하며 무시한다.
- **Keychain entitlement + ad-hoc 서명**: 미서명 Simulator 빌드는 entitlement 이 없어
  `SecItemAdd` 가 `-34018` (errSecMissingEntitlement) 로 실패. `Teleprompter.entitlements`
  (`keychain-access-groups`) + ad-hoc 서명 (`CODE_SIGN_IDENTITY=-`) 으로 해결.
- **새 URL scheme 추가 시 1회**: Simulator LaunchServices 캐시 갱신 필요 —
  `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` (또는 erase). 안 하면
  `simctl openurl` 이 rc=0 인데도 앱에 전달 안 됨.

## 하니스 (`scripts/ios.sh`)

```bash
scripts/ios.sh smoke   # rust → gen → build → install → launch → 부팅+코어 마커 검증 (재실행 가능)
scripts/ios.sh rust    # TpCore.xcframework + Swift 바인딩 빌드 (rust/tp-core)
scripts/ios.sh build   # Simulator 용 빌드만 (xcframework 없으면 먼저 빌드)
scripts/ios.sh run     # 설치 + 실행
scripts/ios.sh test    # XCTest 번들을 Simulator 에서 실행 (xcframework 먼저)
scripts/ios.sh gen     # project.yml → .xcodeproj 재생성
scripts/ios.sh boot    # 대상 시뮬레이터 부팅 (idempotent)
```

환경 변수:
- `TP_SIM` — 시뮬레이터 디바이스 이름 (기본 `iPhone 17 Pro`)
- `TP_SCHEME` — Xcode scheme (기본 `Teleprompter`)
- `TP_FORCE_RUST=1` — xcframework 가 이미 있어도 매 빌드마다 재빌드 (Rust 소스 수정 후)
- `TP_SKIP_RUST=1` — xcframework 재빌드 스킵 (기존 산출물 필수; Rust 미변경 빠른 반복)

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
- **페어링 마커 (M1)**: smoke 가 부팅+코어 확인 후 결정적 `tp://p?d=…` 딥링크를
  `xcrun simctl openurl` 로 주입하고 `TP_PAIR_OK did=daemon-smoketest` 를 확인한다 —
  OS URL 라우팅 → `.onOpenURL` → FFI `decodePairingData` → `PairingStore` → Keychain
  왕복을 daemon 없이 end-to-end 검증. 실패 시 `TP_PAIR_FAIL detail=…` 를 출력하고 실패시킨다.
  링크는 `smoke_pair_link` (pairing.rs v3 레이아웃을 바이트 동일하게 Python 으로 생성).
- 새 마일스톤마다 `scripts/ios.sh smoke` + `scripts/ios.sh test` 를 돌려 회귀를 차단한다.
  (Rust 호스트 테스트 = `cd rust && cargo test -p tp-core`, 와이어 골든벡터 포함.)
  현재: smoke = boot+core+pairing 3 마커, XCTest 17/17, Rust 호스트 20/20.

## 요구 도구

- Xcode 26+ (iOS Simulator SDK), `xcodebuild`, `xcrun simctl`
- `xcodegen` (`brew install xcodegen`)
- Rust 툴체인 + iOS 타깃 (`../rust/README.md` 참조)
- (선택) `xcbeautify` — 있으면 빌드 로그를 예쁘게 출력
