# Teleprompter — native iOS app (Swift)

ADR-0001 전면 재작성의 앱 트랙. SwiftUI 네이티브 앱 + (예정) Rust `tp-core` FFI.
빌드/배포/검증은 **로컬 iOS Simulator 하니스**로 한다 (EAS 없음).

## 구조

```
ios/
  project.yml          # XcodeGen 스펙 (SoT, 체크인됨)
  Sources/             # 앱 소스 (SwiftUI)
    TeleprompterApp.swift
    ContentView.swift  # 부팅 마커 TP_BOOT_OK 방출 (하니스가 검증)
  Tests/               # XCTest (Simulator 에서 실행)
    SmokeTests.swift
  Teleprompter.xcodeproj/   # ⚠️ 생성물 — gitignore. `xcodegen generate` 로 재생성
```

`.xcodeproj` 는 체크인하지 않는다. `project.yml` 한 파일이 SoT 이고, 프로젝트는
`scripts/ios.sh gen` (= `xcodegen generate`) 으로 재현 가능하게 생성한다.

## 하니스 (`scripts/ios.sh`)

```bash
scripts/ios.sh smoke   # gen → build → install → launch → 부팅 마커 검증 (재실행 가능)
scripts/ios.sh build   # Simulator 용 빌드만
scripts/ios.sh run     # 설치 + 실행
scripts/ios.sh test    # XCTest 번들을 Simulator 에서 실행
scripts/ios.sh gen     # project.yml → .xcodeproj 재생성
scripts/ios.sh boot    # 대상 시뮬레이터 부팅 (idempotent)
```

환경 변수:
- `TP_SIM` — 시뮬레이터 디바이스 이름 (기본 `iPhone 17 Pro`)
- `TP_SCHEME` — Xcode scheme (기본 `Teleprompter`)

## 검증 규약

- **부팅 마커**: `ContentView.onAppear` 가 `os.Logger` 로 `TP_BOOT_OK` 를 방출하고,
  `scripts/ios.sh smoke` 가 `subsystem == dev.tpmt.teleprompter` 예측자로 Simulator
  통합 로그에서 이 문자열을 확인한다. 마커 상수를 바꾸면 `scripts/ios.sh` 도 같이 바꾼다.
- 새 마일스톤마다 `scripts/ios.sh smoke` + `scripts/ios.sh test` 를 돌려 회귀를 차단한다.

## 요구 도구

- Xcode 26+ (iOS Simulator SDK), `xcodebuild`, `xcrun simctl`
- `xcodegen` (`brew install xcodegen`)
- (선택) `xcbeautify` — 있으면 빌드 로그를 예쁘게 출력
