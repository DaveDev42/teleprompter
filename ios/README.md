# Teleprompter — native iOS app (Swift)

ADR-0001 전면 재작성의 앱 트랙. SwiftUI 네이티브 앱 + Rust `tp-core` FFI (UniFFI).
빌드/배포/검증은 **로컬 iOS Simulator 하니스**로 한다 (EAS 없음).

Rust 코어 자체(crate, 와이어 불변식, xcframework 빌드)는 [`../rust/README.md`](../rust/README.md) 참조.

## 구조

```
ios/
  project.yml          # XcodeGen 스펙 (SoT, 체크인됨)
  Sources/             # 앱 소스 (SwiftUI)
    TeleprompterApp.swift
    ContentView.swift  # 부팅 마커 TP_BOOT_OK + tp-core 라운드트립 결과(TP_CORE_OK) 방출
    TpCoreCheck.swift  # FFI 자가검사: encode→encrypt→decrypt→decode 라운드트립
  Tests/               # XCTest (Simulator 에서 실행)
    SmokeTests.swift
    TpCoreTests.swift  # tp-core FFI 단위 테스트 (codec/kx/aead/pairing)
  Generated/           # ⚠️ 생성물 — gitignore. UniFFI Swift 바인딩 (scripts/ios.sh rust)
  Teleprompter.xcodeproj/   # ⚠️ 생성물 — gitignore. `xcodegen generate` 로 재생성
```

`.xcodeproj` 와 `Generated/` 는 체크인하지 않는다. `project.yml` 한 파일이 SoT 이고,
프로젝트는 `scripts/ios.sh gen` (= `xcodegen generate`), 바인딩은 `scripts/ios.sh rust`
(= `../rust/build-xcframework.sh`) 으로 재현 가능하게 생성한다. 앱 타깃은
`../rust/target/TpCore.xcframework` (정적 라이브러리, `embed: false`) 를 링크한다.

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
- 새 마일스톤마다 `scripts/ios.sh smoke` + `scripts/ios.sh test` 를 돌려 회귀를 차단한다.
  (Rust 호스트 테스트 = `cd rust && cargo test -p tp-core`, 와이어 골든벡터 포함.)

## 요구 도구

- Xcode 26+ (iOS Simulator SDK), `xcodebuild`, `xcrun simctl`
- `xcodegen` (`brew install xcodegen`)
- Rust 툴체인 + iOS 타깃 (`../rust/README.md` 참조)
- (선택) `xcbeautify` — 있으면 빌드 로그를 예쁘게 출력
