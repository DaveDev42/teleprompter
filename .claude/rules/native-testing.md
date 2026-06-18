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

## 검증 레이어 (3중)

| 레이어 | 무엇 | 명령 | 어디서 돈다 |
|---|---|---|---|
| **마커 E2E** | os.Logger 부트마커를 unified log 에서 폴링 — 실 wire/E2EE/kx 라운드트립이 동작함을 증명 | `scripts/ios.sh smoke` | 5플랫폼 전부 |
| **UI E2E** | XCUITest 가 a11y 트리를 쿼리해 세션 row tap → pane picker → chat bubble 어서션 | `scripts/ios.sh uitest` | iOS/iPadOS 풀, macOS는 호스트 TCC 인가 시(없으면 SKIP), visionOS 부분, **watchOS 불가** |
| **유닛** | XCTest (FFI/Keychain/relay.auth/terminal 등) | `scripts/ios.sh test` | iOS Simulator |

마커 E2E 는 **실 `RelayServer` + 가짜 스크립트 daemon**(`scripts/local-relay-loopback.ts`, 포트 7099,
golden 토큰 pre-seed, 합성 `sess-smoketest`)이 기본. **실 `tp` daemon+relay** E2E 는 `TP_E2E_REAL=1`
게이트 뒤 (아래 참조).

## 플랫폼 매트릭스

| Platform | `TP_PLATFORM` | 빌드 destination | 마커 | UI 자동화 | 비고 |
|---|---|---|---|---|---|
| iOS | `ios` (기본) | `platform=iOS Simulator,name=$TP_SIM` (`iPhone 17 Pro`) | **8** | 풀 | |
| iPadOS | `ipad` | iOS Simulator, `$TP_SIM`=`iPad Pro 13-inch (M5)` | **8** | 풀 | iOS 경로 alias — 새 슬라이스 불필요 (`ios-arm64_x86_64-simulator` 공유). split-view/sidebar 실행. (M5 = iOS 26.5 런타임; M4 는 18.5 뿐이라 name 해석 모호) |
| macOS | `macos` | `platform=macOS` (native, `open`) | **8** | **호스트 게이트** — 빌드+서명 O, XCUITest 런타임은 TCC/LocalAuthentication 인증 세션 필요. 비대화형/미인가 세션에선 runner init 실패 → `cmd_uitest` 가 **SKIP**(exit 0) | sim 없음. `screencapture -x` 아티팩트. `log stream` 폴링 |
| visionOS | `visionos` | `id=$visionUDID` (xrOS sim) | **8** | **부분** — element 쿼리+flat-window tap O, 공간 제스처/eye-gaze sim **불가** | `TP_VISION_SIM`=`Apple Vision Pro` |
| watchOS | `watchos` | `-target TeleprompterWatch -sdk watchsimulator` | **7** (no `TP_INPUT_OK`) | **없음** — watchOS 에 `XCUIApplication` 부재 (Apple hard limit) | `TP_WATCH_SIM`=`Apple Watch Series 11 (46mm)`. 마커+스크린샷만 |

> **`TP_INPUT_OK` 가 watchOS 에서 빠지는 이유**: ADR-0002 §4 — watchOS 는 제한 경험(입력 송신 미구현).
> 그래서 watchOS smoke 는 M0–M4 (7마커) 만 어서션한다.

## 마커 (8마커, os.Logger `subsystem == "dev.tpmt.teleprompter"`)

| # | 마커 | 의미 |
|---|---|---|
| M0 | `TP_BOOT_OK` | SwiftUI 부팅 + 보드 마운트 |
| M0' | `TP_CORE_OK` | tp-core FFI 라운드트립 (encode→encrypt→decrypt→decode) — Rust 정적 라이브러리 링크+동작 증명 |
| M1 | `TP_PAIR_OK` | pairing bundle ingest (`tp://p?d=…` 딥링크) |
| M2 | `TP_RELAY_AUTH_OK` | relay `frontend auth` 성공 |
| M3 | `TP_KX_OK` | in-band kx → per-frontend 세션키 |
| M3' | `TP_FRAME_OK` | 첫 E2EE 프레임 복호 |
| M4 | `TP_SESSION_OK` | 세션 렌더 (hello/history) |
| M5 | `TP_INPUT_OK` | 입력 송신 왕복 (watchOS 제외) |

폴링 predicate: `--predicate "subsystem == \"dev.tpmt.teleprompter\""`. iOS 는 `simctl spawn … log show`,
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
| `TP_ARTIFACT_DIR` | 스크린샷/비디오 출력 디렉터리 (기본 `/tmp/tp-artifacts`) |
| `TP_E2E_REAL=1` | 가짜 loopback 대신 **실 `tp` daemon+relay** 로 E2E (격리 XDG 디렉터리, 헤드리스 페어링, iOS 전용, M0–M2 범위) |

## 서브커맨드

```bash
scripts/ios.sh rust     # TpCore.xcframework (7 슬라이스) + UniFFI 바인딩
scripts/ios.sh gen      # xcodegen generate
scripts/ios.sh boot     # Simulator 부팅 (sim 전용)
scripts/ios.sh build    # xcodebuild
scripts/ios.sh smoke    # 빌드+설치+런치+마커 검증 (TP_PLATFORM 분기)
scripts/ios.sh uitest   # XCUITest UI-level E2E (iOS/iPad/macOS 풀, visionOS 부분, watchOS 미지원)
scripts/ios.sh test     # XCTest (iOS Simulator)
scripts/ios.sh all      # 5플랫폼 smoke 매트릭스 (행=플랫폼, 종료코드=worst)
```

xcframework 는 **7 슬라이스** (`ios-arm64`, `ios-arm64_x86_64-simulator`, `macos-arm64_x86_64`,
`xros-arm64`, `xros-arm64-simulator`, `watchos-arm64`, `watchos-arm64-simulator`). `plutil -p
rust/target/TpCore.xcframework/Info.plist | grep LibraryIdentifier` 로 7개 확인.

## UI E2E (`cmd_uitest`, XCUITest)

`TeleprompterUITests` (`ios/UITests/SmokeUITests.swift`) = `bundle.ui-testing` 타깃. **마커가
바이트 라운드트립을 증명한다면, 이건 SwiftUI 가 그 복호 데이터를 실제 a11y 트리로 렌더함을 증명**한다:
`--tp-smoke-url` 골든 링크로 런치(마커 smoke 와 동일 loopback 경로) → `session-<sid>` row tap →
`session-pane-picker` → `"Claude: smoke ok"` 버블(loopback Stop `last_assistant_message`) →
Terminal pane → `terminal-output`. 스크린샷을 `XCTAttachment` 으로 첨부.

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
  macOS destination 빌드를 깬다. 두 test 타깃(`TeleprompterTests`/`TeleprompterUITests`)은
  `platform: auto` + `supportedDestinations: [iOS, macOS]` 멀티플랫폼.
- **macOS 호스트 게이트**: macOS native 는 XCUITest runner init 가 TCC/LocalAuthentication 인증 세션을
  요구한다. 비대화형/미인가 세션에선 `Failed to initialize for UI testing … System authentication is
  running`(LocalAuthentication Code=-4)로 실패 → `cmd_uitest` 가 이 시그니처를 감지해 **SKIP(exit 0)**
  처리(빌드+서명은 성공, 동일 코드가 iOS Simulator 에선 통과). 전체 macOS UI E2E 는 GUI 로그인 세션 +
  System Settings → Privacy & Security → Accessibility/Automation 인가 후 재실행.
- macOS entitlements: native 빌드는 `CODE_SIGN_ENTITLEMENTS=""` 로 keychain-access-groups 제거(ad-hoc
  서명 — cmd_build macOS 와 동일).

## 실 daemon E2E (`TP_E2E_REAL=1`, iOS Simulator)

가짜 loopback 대신 **진짜 `tp` relay + `tp` daemon** 을 띄워 헤드리스 페어링한다.
`scripts/real-daemon-pair.ts` 가 (1) 빈 포트에 **실 RelayServer** 를 in-process 로 띄우고, (2) **격리
XDG 디렉터리**(`XDG_RUNTIME_DIR`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `HOME` 을 `mktemp -d` 아래로 —
dogfood daemon 의 socket/store 와 절대 충돌 안 함)로 `tp daemon start` 서브프로세스를 spawn, (3) daemon IPC
(`connectIpcAsClient`)로 `pair.begin` → `pair.begin.ok.qrString` 읽어 **`REAL_PAIR_URL=tp://p?d=…`** 를
stdout 으로 emit (그 뒤 relay+daemon 을 SIGTERM 까지 살려둠). `start_real_daemon_relay()` 가 이 줄을 grep
해 링크 + 실 daemonId 를 잡고, `cmd_smoke_ios` 가 `--tp-smoke-url` 로 주입 + `$SMOKE_DAEMON_ID` 를 실
daemonId 로 재설정한다(did=/daemon= 어서션 매칭).

> **정직한 범위 — M0–M2 만**: 실 daemon E2E 는 boot + tp-core FFI + pairing ingest + **실 relay 에 대한
> frontend-auth**(genuine daemon→relay→app 인증 파이프라인)를 결정론적으로 증명한다. **M3(kx)/M4/M5 는
> 범위 밖**: 실 daemon 은 pre-seed 세션이 없어 빈 hello 를 보내고(`sessions=0`), 실 daemon 의 kx-pubkey
> 브로드캐스트가 프론트엔드 자체 kx 완료와 레이스해 `relay.frame before kx — dropping` 이 날 수 있다(loopback
> 은 `LOOPBACK_READY` 시퀀싱으로 이를 피함). 전체 M3–M5 검증은 loopback 모드(8마커) 가 담당. 실 M4/M5 를
> 실 daemon 으로 보려면 spawn 된 세션 + PATH 의 `claude` 가 필요.
>
> **아키텍처 불변식 전부 유지**: app→relay 전용, daemon outbound-WS only(실 daemon 이 `relay.register` 로
> self-register → relay 의 유일 클라이언트), relay ciphertext-only.

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
