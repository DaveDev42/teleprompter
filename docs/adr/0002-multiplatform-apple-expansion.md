# ADR-0002 — Apple 멀티플랫폼 확장 (iOS/iPadOS/macOS/visionOS 완전 + watchOS 제한)

- 상태: **Accepted** (2026-06-15)
- 결정자: Dave
- 관계: **ADR-0001 (전면 네이티브 재작성)의 플랫폼 범위를 대체(supersede)한다.** ADR-0001 의
  "iOS(Simulator 우선)" 단일 타깃 전제와 "Web/Android 강등 · watchOS = 별도 post-Phase-3"
  서술을 이 ADR 이 갱신한다. ADR-0001 의 나머지(전면 재작성 결정, Rust `tp-core` 공유 코어,
  보존 불변식, 로컬 Simulator 하니스)는 그대로 유효하다.

## 1. 맥락

ADR-0001 로 Swift(SwiftUI) 앱 + Rust(`tp-core`) 코어 재작성을 확정하고 Phase 3 M1–M5
(pairing → relay auth → kx/first-frame → session render → input roundtrip)을 iOS Simulator
에서 8개 마커로 E2E 검증 완료했다. 이 시점에 Dave 가 플랫폼 범위를 명시했다:

> "watchOS의 제한적 경험 외에 나머지는 모두 완벽한, 완전한 경험을 줄 수 있어야 해."

즉 **iOS / iPadOS / macOS / visionOS = 완전한 경험**, **watchOS = 제한적 경험**.

ADR-0001 §6 의 "공유 단위는 `tp-core`, 분기는 UI 셸에만" 규율이 이 확장의 기반이다 — crypto/wire
는 한 줄도 재구현하지 않고, 새 Apple 플랫폼은 같은 xcframework 슬라이스 + 플랫폼-중립 Swift
레이어를 재사용한다.

## 2. 순서를 가르는 단 하나의 사실 (toolchain gate)

확장을 설계하며 빌드 호스트(rustc 1.92.0 stable)에서 `rustup target add` 를 **실제로 실행**한
결과가 전체 순서를 결정했다:

```
$ rustup target add aarch64-apple-visionos
error: toolchain stable-aarch64-apple-darwin has no prebuilt artifacts
       available for target aarch64-apple-visionos ...
```

rustup 은 이 toolchain 에서 `visionos`/`xros`/`watchos` 를 **목록에조차 올리지 않는다**.
upstream rustc book 은 visionOS 를 Tier 2 로 올렸으나(PR #152021) 그건 **설치된 것보다 새
stable** 에 있고, watchOS `arm64_32` 는 역사적으로 build-std-only 였다. 반면 macOS 트리플
(`aarch64-apple-darwin`, `x86_64-apple-darwin`)은 **이미 설치돼 있고 막히지 않았다**.

**결론: 확장을 두 Phase 로 가른다.**

- **Phase A — 지금 증명됨:** ANSI 터미널 + iOS/iPadOS/macOS. 모든 트리플 설치돼 있고 모든
  메커니즘이 Simulator/네이티브에서 검증된다. **오늘 출하.**
- **Phase B — toolchain 게이트:** visionOS + watchOS. `rustup update stable`(+ 필요 시
  nightly `-Z build-std` 브랜치) 게이트 뒤에 있다. 단순 recompile 로 취급하지 않는다.

## 3. 결정

1. **단일 멀티플랫폼 SwiftUI 타깃.** 하나의 `Teleprompter` 타깃이 iOS Simulator / iPadOS /
   네이티브 macOS / (Phase B) visionOS 를 같은 Sources 에서 컴파일한다. 메커니즘 =
   XcodeGen `platform: auto` + `supportedDestinations` (검증: 2.45.4). iPadOS 는 iOS
   destination + device-family `2` 로 자동 포함.
2. **네이티브 macOS — Mac Catalyst 아님.** SwiftUI App 생명주기 → `SDKROOT=macosx` 로
   AppKit 자동 백엔드. Catalyst 플래그 미사용. 진짜 Mac 경험(창 크기/복원, Commands 메뉴,
   `NavigationSplitView` 사이드바)을 목표로 한다.
3. **ANSI 터미널은 한 번만 구현.** SwiftTerm(MIT, SPM) 기반 VT100/xterm 렌더를 멀티플랫폼
   구조 **위에** 한 번 구현한다 — 플랫폼별 중복 구현 없음. `SwiftTerm.TerminalView`/
   `feed(byteArray:)`/`terminalDelegate`/`TerminalViewDelegate` 가 iOS/visionOS/macOS 에서
   동일하므로, 플랫폼 분기는 SwiftUI representable 래퍼(`UIViewRepresentable` ↔
   `NSViewRepresentable`)에만 둔다.
4. **watchOS = 별도 타깃, 제한적 경험.** `supportedDestinations` 가 아닌 독립
   `TeleprompterWatch` 타깃(watch app + WidgetKit 모델이 다름). 같은 `tp-core` 슬라이스 +
   플랫폼-중립 Swift(RelayClient/RelayMessages/SessionStore/PairingStore/TpCoreCheck)를
   재사용. **standalone**(자체 frontendId/kx, pairing secret 은 동기화된 iCloud Keychain).
   범위 = 읽기 위주 glance(세션 목록·상태, Stop `last_assistant_message` 카드, 경량
   approve/deny, 선택적 짧은 음성 dictation). **명시적 제외:** Terminal/PTY io(watch 에
   `TP_INPUT_OK` 없음), 멀티탭, 전체 chat scrollback.
5. **검증은 플랫폼별 같은 마커 규율.** `scripts/ios.sh` 에 `TP_PLATFORM`(`ios`|`macos`|
   (Phase B) `visionos`|`watchos`, **미지정 시 `ios` = 기존 동작 byte-identical**) 추가.
   macOS/visionOS = 8개 마커 동일; watchOS = 축소 서브셋(`TP_INPUT_OK` 제외).
6. **디렉터리는 `ios/` 유지.** rename = 13파일 66줄 변경에 기능 이득 0(`ios.sh` 가
   `IOS_DIR` 로 추상화, xcframework 상대경로는 디렉터리명 독립). 한다면 별도 `git mv` chore.

## 4. Phase A 구현에서 확정된 사실 (검증 완료)

- **소스 이식성:** 모든 Swift 파일이 플랫폼-중립이었다(SwiftUI/Foundation/Security/URLSession/
  os 만 사용). 예외 하나 — A1 의 `SwiftTermView.swift` 가 `import UIKit` + `UIViewRepresentable`
  로 작성돼 macOS 빌드를 깼고(`Unable to resolve module dependency: 'UIKit'`),
  conditional import(`AppKit`/`UIKit`) + representable 분기(공유 `_make/_update/_dismantle`
  헬퍼)로 cross-platform 화했다.
- **Info.plist:** 단일 공유 plist 유지가 동작한다 — UI* 키(`UILaunchScreen`,
  `UIApplicationSceneManifest`, `UIApplicationSupportsIndirectInputEvents`)는 AppKit 이
  macOS 에서 조용히 무시한다(macOS 빌드로 검증). plist split 불필요.
- **macOS entitlements:** `Teleprompter-macOS.entitlements` = `keychain-access-groups` 만.
  `app-sandbox`/`network.client` 는 **생략**했다(원래 critique 는 둘을 기대). ad-hoc 로컬
  빌드는 sandbox 가 적용되지 않아 localhost WS 가 `network.client` 없이도 열리고 macOS smoke
  8/8 통과. 정식 Developer ID 배포 시점에 sandbox + network.client 를 재도입한다.
- **macOS Keychain:** `PairingStore` 가 `#if os(macOS)` 에서 `kSecAttrSynchronizable =
  false`(iCloud Keychain 동기화는 macOS 에서 entitlement 필요).
- **OSLog 가시성:** 네이티브 macOS OSLog 는 String 변수 보간을 기본 `<private>` 로 가린다 →
  마커 보간에 `privacy: .public` 명시(iOS Simulator 는 강제 안 함). 호스트 unified log 에서
  `log show/stream --predicate 'subsystem == "dev.tpmt.teleprompter"'` 로 스크랩.
- **macOS deep link:** simctl 대신 LaunchServices `open 'tp://…'`(+ 필요 시
  `lsregister -f Teleprompter.app`).
- **xcframework:** Phase A 슬라이스 3개(ios-device, ios-sim-fat, macos-fat).
  `plutil` LibraryIdentifier == 3 검증.

## 5. Phase B 게이트 (B0) — 통과 전까지 시작 금지

```
rustup update stable
rustup target list | grep -E 'visionos|watchos'
```

- visionOS 가 목록에 뜨고 `rustup target add aarch64-apple-visionos
  aarch64-apple-visionos-sim` 성공 → B1/B2 는 단순 recompile.
- 여전히 부재/prebuilt 없음 → nightly + `cargo +nightly build -Z build-std=std,panic_abort
  --target …` 가 유일 경로 → `build-xcframework.sh` 에 해당 슬라이스용 새 브랜치 필요.
  watchOS `arm64_32` 은 build-std-only 가 정석 — watchOS 는 게이트 결과와 무관하게 예상.
- 게이트 통과 전까지 visionOS/watchOS 를 `supportedDestinations` 와 xcframework 에서 **완전
  배제**해, 부재 슬라이스가 Phase-A iOS/macOS smoke 를 link-time 에 깨지 못하게 한다.

Phase B 슬라이스 카운트: visionOS 추가 시 5(B1), watchOS 추가 시 7(B3).

## 6. 보존 불변식

ADR-0001 §3 의 wire/E2EE/relay/daemon 불변식 전부 유지. 추가로:

- **`tp-core` 는 순수 portable Rust(zero `cfg(target_os)`)** — 모든 Apple 슬라이스가 같은
  소스의 straight recompile. UniFFI 바인딩은 single-gen(host 빌드, 플랫폼 무관).
- **iOS 경로 불변(byte-identical).** `TP_PLATFORM` 미지정 = 기존 iOS 동작. 공유 simctl
  마커-폴링 루프는 iOS 동작을 바꾸는 방식으로 리팩터하지 않는다 — macOS/visionOS 는 별도
  non-default 브랜치.
- **`frontendId` 는 기기-로컬(동기화 금지).** N:N 와이어(relay v2)는 iPhone·iPad·Mac·Vision·
  Watch 가 같은 daemon 에 동시 접속하는 걸 이미 지원. watch standalone 도 자체 frontendId.

## 7. 기각된 대안

- **Mac Catalyst:** "iPad 앱을 늘린" 경험. 네이티브 AppKit 백엔드(완전한 Mac 경험 목표)와
  배치된다. SwiftUI App 생명주기 → `SDKROOT=macosx` 로 Catalyst 없이 네이티브 macOS 달성.
- **플랫폼별 별도 타깃(Sources 공유):** XcodeGen 2.45.4 가 per-supportedDestination
  `CODE_SIGN_ENTITLEMENTS[sdk=macosx*]` 를 표현할 수 있어 단일 타깃으로 충분 — 검증 완료.
  단일 타깃이 유지보수 표면을 최소화한다.
- **watchOS 를 `supportedDestinations` 에 포함:** watch app + WidgetKit 모델이 단일 타깃과
  다르고 경험 범위(읽기 위주)도 분리돼야 해 별도 타깃이 맞다.
- **visionOS/watchOS 를 지금 단순 recompile 로 진행:** toolchain 게이트(§2/§5) 미통과 —
  Phase B 로 분리.

## 8. 결과

- (+) 한 Sources 에서 iOS/iPadOS/macOS(+Phase B visionOS) 완전 경험, watchOS 제한 경험.
  crypto/wire 재구현 0(공유 `tp-core`).
- (+) macOS-native smoke = 빠른 회귀 경로(sim 부팅 없음) — 비-UI 로직 기본 검증 경로.
- (−) Phase B 는 Rust toolchain 게이트에 묶임 — 출하 시점 비결정.
- (−) 플랫폼 분기(`#if os(...)`)가 representable 래퍼/Commands/entitlements/harness 에 도입 —
  전용 파일(`MacCommands.swift`/`VisionAdaptations.swift`)로 격리해 core view 중립 유지.
