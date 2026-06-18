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
| **UI E2E** | XCUITest 가 a11y 트리를 쿼리해 세션 row tap → pane picker → chat bubble 어서션 | `scripts/ios.sh uitest` | iOS/iPadOS/macOS 풀, visionOS 부분, **watchOS 불가** |
| **유닛** | XCTest (FFI/Keychain/relay.auth/terminal 등) | `scripts/ios.sh test` | iOS Simulator |

마커 E2E 는 **실 `RelayServer` + 가짜 스크립트 daemon**(`scripts/local-relay-loopback.ts`, 포트 7099,
golden 토큰 pre-seed, 합성 `sess-smoketest`)이 기본. **실 `tp` daemon+relay** E2E 는 `TP_E2E_REAL=1`
게이트 뒤 (아래 참조).

## 플랫폼 매트릭스

| Platform | `TP_PLATFORM` | 빌드 destination | 마커 | UI 자동화 | 비고 |
|---|---|---|---|---|---|
| iOS | `ios` (기본) | `platform=iOS Simulator,name=$TP_SIM` (`iPhone 17 Pro`) | **8** | 풀 | |
| iPadOS | `ipad` | iOS Simulator, `$TP_SIM`=`iPad Pro 13-inch (M4)` | **8** | 풀 | iOS 경로 alias — 새 슬라이스 불필요 (`ios-arm64_x86_64-simulator` 공유). split-view/sidebar 실행 |
| macOS | `macos` | `platform=macOS` (native, `open`) | **8** | 풀 (`platform=macOS`) | sim 없음. `screencapture -x` 아티팩트. `log stream` 폴링 |
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
| `TP_SIM` | iOS/iPad Simulator 기기명 (iOS 기본 `iPhone 17 Pro`; `ipad` 분기 기본 `iPad Pro 13-inch (M4)`) |
| `TP_VISION_SIM` / `TP_WATCH_SIM` | visionOS/watchOS Simulator 기기명 |
| `TP_SKIP_RUST=1` | xcframework 재빌드 스킵 (없으면 die) — 빠른 반복 |
| `TP_FORCE_RUST=1` | xcframework 매번 재빌드 (Rust 수정 후) |
| `TP_JSON=1` | smoke 가 마지막 줄에 single-line JSON 결과 emit (`{platform,markers,passed,elapsed_s}`) — 텍스트 출력 불변 |
| `TP_ARTIFACT_DIR` | 스크린샷/비디오 출력 디렉터리 (기본 `/tmp/tp-artifacts`) |
| `TP_E2E_REAL=1` | 가짜 loopback 대신 **실 `tp` daemon+relay** 로 E2E (격리 `TP_CONFIG_DIR`, 헤드리스 페어링) |

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

## 실 daemon E2E (`TP_E2E_REAL=1`)

`scripts/real-daemon-pair.ts` 가 daemon IPC 로 `pair.begin` → `qrString` 읽고 → `pair.completed` 대기 →
`tp://p?d=…` 출력. `start_real_daemon_relay()` 가 (1) 빈 포트에 **실 relay** 띄우고 (proof-carrying
`relay.register` 가 받아들여지도록), (2) 격리 `TP_CONFIG_DIR=/tmp/tp-e2e-$$` 로 `tp daemon start --spawn`
(dogfood daemon 의 pid-lock 과 충돌 안 함), (3) 헤드리스 페어링해 URL 을 `--tp-smoke-url` 로 주입한다.

> **정직한 한계**: M5(`TP_INPUT_OK`)는 라이브 PTY 가 필요 — PATH 에 `claude` 없으면 Runner 가 `stopped`
> 로 빠져 M0–M4 만 통과한다. 전체 M5 는 `claude` 설치 또는 echo-`claude` 스텁 필요.
>
> **아키텍처 불변식은 전부 유지**: app→relay 전용, daemon outbound-WS only, relay ciphertext-only.

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
