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
| macOS | `macos` | `platform=macOS` (native, `open`) | **8** | **호스트 게이트** — 빌드+서명 O, XCUITest 런타임은 TCC/LocalAuthentication 인증 세션 필요. 비대화형/미인가 세션에선 runner init 실패 → `cmd_uitest` 가 **SKIP**(exit 0, `TP_UITEST_SKIP` 마커 emit — PASS 와 혼동 금지). `TP_UITEST_STRICT=1` 이면 이 게이트를 **hard-fail** | sim 없음. `screencapture -x` 아티팩트. `log stream` 폴링 |
| visionOS | `visionos` | `id=$visionUDID` (xrOS sim) | **8** | **부분** — element 쿼리+flat-window tap O, 공간 제스처/eye-gaze sim **불가** | `TP_VISION_SIM`=`Apple Vision Pro` |
| watchOS | `watchos` | `-target TeleprompterWatch -sdk watchsimulator` | **7** (no `TP_INPUT_OK`) | **없음** — watchOS 에 `XCUIApplication` 부재 (Apple hard limit) | `TP_WATCH_SIM`=`Apple Watch Series 11 (46mm)`. 마커+스크린샷만 |

> **`TP_INPUT_OK` 가 watchOS 에서 빠지는 이유**: ADR-0002 §4 — watchOS 는 제한 경험(입력 송신 미구현).
> 그래서 watchOS smoke 는 M0–M4 (7마커) 만 어서션한다.

## 마커 (8마커, os.Logger `subsystem == "dev.tpmt.app"`)

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
| `TP_ARTIFACT_DIR` | 스크린샷/비디오 출력 디렉터리 (기본 `/tmp/tp-artifacts`) |
| `TP_UITEST_STRICT=1` | macOS XCUITest TCC 호스트 게이트를 non-fatal SKIP 대신 **hard-fail** 로 (인가된 GUI/CI 러너용; 기본 SKIP 은 `TP_UITEST_SKIP` 마커 emit) |
| `TP_E2E_REAL=1` | 가짜 loopback 대신 **실 `tp` daemon+relay** 로 E2E (격리 XDG 디렉터리, 헤드리스 페어링, M0–M2 범위). **`TP_PLATFORM=ios`/`ipad`/`macos`/`visionos` 전부 지원** (daemon+relay+claude 는 항상 *호스트*에서 돌고, 앱만 sim/네이티브로 뜬다 — 그래서 visionOS sim 도 실 claude 원격 컨트롤 가능). watchOS 만 미지원 (M5 probe 경로 없음) |
| `TP_E2E_CLAUDE=1` | `TP_E2E_REAL` 의 strict superset — 페어링 *전* **실 `claude -p` PRINT 세션**을 격리 daemon 에 spawn (M0–M4 범위, 실 Stop `last_assistant_message` 렌더). `claude` PATH 필수, OAuth 토큰을 keychain 에서 (먼저 refresh 후) 추출해 주입. **로컬 전용 (절대 CI 아님)** |
| `TP_E2E_CLAUDE_M5=1` | `TP_E2E_CLAUDE` 의 strict superset — 페어링 *전* **실 INTERACTIVE claude 세션**(`--permission-mode bypassPermissions`, no `-p`)을 spawn (M0–M5 **전 8마커**). holder 가 trust 프롬프트를 `\r` 로 수락 → claude REPL idle → 앱의 스모크 auto-probe `in.chat` → daemon 이 `\r` 붙여 제출 → claude `UserPromptSubmit` → `TP_INPUT_OK` emit (proof=echo: claude 가 입력을 io 로 렌더; 결정적 제출 증명은 세션 DB `UserPromptSubmit≥1`). 진짜 app→relay→daemon→PTY→claude 입력 경로를 E2E 증명. **로컬 전용** |
| `TP_E2E_CLAUDE_SID` / `TP_E2E_CLAUDE_CWD` / `TP_E2E_CLAUDE_PROMPT` | claude 세션 sid(기본 `real-smoke-sess`)/cwd(기본 격리 HOME 아래 `work`)/프롬프트(print 모드만; 기본 `Reply with exactly: PONG`) 오버라이드 |

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

## 실 daemon E2E (`TP_E2E_REAL=1`, iOS/iPadOS Simulator · macOS 네이티브 · visionOS Simulator)

가짜 loopback 대신 **진짜 `tp` relay + `tp` daemon** 을 띄워 헤드리스 페어링한다.
`scripts/real-daemon-pair.ts` 가 (1) 빈 포트에 **실 RelayServer** 를 in-process 로 띄우고, (2) **격리
XDG 디렉터리**(`XDG_RUNTIME_DIR`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `HOME` 을 `mktemp -d` 아래로 —
dogfood daemon 의 socket/store 와 절대 충돌 안 함)로 `tp daemon start` 서브프로세스를 spawn, (3) daemon IPC
(`connectIpcAsClient`)로 `pair.begin` → `pair.begin.ok.qrString` 읽어 **`REAL_PAIR_URL=tp://p?d=…`** 를
stdout 으로 emit (그 뒤 relay+daemon 을 SIGTERM 까지 살려둠). `start_real_daemon_relay()` 가 이 줄을 grep
해 링크 + 실 daemonId 를 잡고, 각 플랫폼 smoke 함수가 그 링크를 주입(iOS/visionOS=`--tp-smoke-url`,
macOS=`open -a "$app" "$link"`) + `$SMOKE_DAEMON_ID` 를 실 daemonId 로 재설정한다(did=/daemon= 어서션 매칭).

> **공유 배선 (3 플랫폼 동일)**: `parse_e2e_gates`(TP_E2E_* → `E2E_REAL`/`E2E_CLAUDE`/`E2E_CLAUDE_M5` 게이트;
> `set -e` 아래에서 마지막 `[ … ] && …` 단락평가가 exit 1 을 내 caller 를 abort 시키므로 **반드시
> `return 0` 으로 닫는다**) + `extract_claude_oauth_token`(claude 모드 시 호스트 keychain OAuth 추출) +
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
> self-register → relay 의 유일 클라이언트), relay ciphertext-only.

## 실 claude PRINT E2E (`TP_E2E_CLAUDE=1`, iOS/iPadOS Sim · macOS 네이티브 · visionOS Sim) — 헤드라인 dogfood 증명 (M0–M4)

`TP_E2E_REAL` 의 **strict superset** (입력 왕복 M5 까지는 아래 `TP_E2E_CLAUDE_M5` 섹션 참조).
`real-daemon-pair.ts` 가 `--spawn-claude` 로 **실 `claude -p`
세션**을 같은 격리 daemon 에 **페어링 *전*** spawn 한다 → 앱이 hello 에서 그 세션을 받아 auto-attach →
**실 Stop 훅의 `last_assistant_message` 를 Chat 에 렌더**한다. 이게 M3'(`TP_FRAME_OK sessions=1`) +
M4(`TP_SESSION_OK events>=1`)를 만족시키며, "실 페어링 → 실 격리 daemon → 실 claude → 실 Stop → 복호 →
ChatItem 렌더" 전 체인을 증명한다 (loopback 의 합성 Stop 이 아니라 진짜 모델 응답).

- **세션 생성 경로 = `tp run --socket-path <격리 socket>`** (NOT `session.create`). `session.create`
  는 relay control 메시지라 `claudeArgs`/`env` 필드가 없어서 claude 인자를 못 넘긴다. `real-daemon-pair.ts`
  의 `spawnClaudeSession()` 이 `getSocketPath()` 로 격리 daemon socket 을 잡아 직접 `tp run` 한다 — 그
  Runner 가 hello → daemon 이 세션 등록(+ store 영속) + relay 로 `state` 브로드캐스트.
- **세션 spawn 은 페어링 *전* (race-free 시퀀싱)**: print 모드 `claude -p` 는 ~3s 안에 Stop 후 **종료**한다.
  세션을 `pair.completed` *뒤*에 spawn 하면 앱의 첫 hello 가 빈 store 를 봐서 `sessions=0` 이 되고(M3' fail),
  print 세션은 live `state` 브로드캐스트가 닿기 전에 이미 죽어버린다. 그래서 `real-daemon-pair.ts` 는 daemon
  IPC 소켓이 준비되는 즉시(`waitForSocket` 직후, step 3b) claude 를 spawn 해 페어링과 **동시 진행**시킨다 —
  세션이 store 에 등록된 뒤 앱이 페어링(~30s)하므로 hello 가 `sessions=1`(stopped 세션도 `listSessions()` 에
  포함, store.ts:231 무필터)을 반환한다. 페어링은 세션에 의존하지 않고 `tp run` 은 relay 없이 daemon IPC 로
  직접 붙으므로 둘은 독립이다.
- **요구된 production fix 2 건 (이 E2E 가 처음 노출)**: (1) **daemon kx 재브로드캐스트** —
  `relay-client.ts handleKxFrame` 이 frontend 의 first-join 시 daemon pubkey 를 재브로드캐스트(릴레이는 kx
  프레임을 캐시하지 않아 auth-time 브로드캐스트를 놓친 late-join 앱이 영영 키를 못 받던 레이스; M3 unblock).
  (2) **app subscribe-on-broadcast** — `RelayClient.swift onState` 가 resume 전에 `relay.sub` 를 보냄
  (브로드캐스트로 발견한 세션에 sub 없이 resume 하면 릴레이가 batch/rec 를 drop → chat item 0 → M4 영영 fail).
- **Auth = keychain 토큰 (refresh 후) 추출**: 격리 HOME 엔 자격증명이 없으므로, `cmd_smoke_ios` 가 실
  OAuth 토큰을 뽑아 `CLAUDE_CODE_OAUTH_TOKEN` env 로 격리 daemon 의 runner 에 주입한다(`PtyBun.spawn`
  은 자체 `env:` 가 없어 그대로 상속). **추출 *전* 토큰을 refresh** 한다 — keychain access token 은 ~8h 만에
  만료되고, stale 토큰이면 세션이 REPL 까지 가서 프롬프트 제출까지 되지만 API 호출이 401 → `StopFailure`(Stop
  아님) → M4/M5 fail 한다. refresh = 실 config(`CLAUDE_CONFIG_DIR`)로 `claude -p "Reply with exactly: OK"`
  를 한 번 돌리면 (저장된 refresh token 으로) access token 을 갱신 + keychain 에 다시 영속 → 그 다음
  `security find-generic-password -s "Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>" -w` 로 fresh
  토큰을 추출. **`CLAUDE_CODE_SIMPLE=1` 절대 금지** — simple 모드는 훅을 건너뛰어 Stop 이 안 떠서 M4 불가.
- **결정론 정직성**: M4 어서션은 `events>=1` (실 Stop, 비어있지 않은 `last_assistant_message` 가 E2E 로
  흘렀음)만 보고 **정확한 텍스트(`PONG`)는 안 본다** — 모델이 재포맷할 수 있어 brittle. load-bearing
  증명은 "실 Stop 이 흘러 ChatItem 으로 렌더됐다".

## 실 claude M5 E2E (`TP_E2E_CLAUDE_M5=1`, iOS/iPadOS Sim · macOS 네이티브 · visionOS Sim) — 입력 왕복 증명

`TP_E2E_CLAUDE` 의 **strict superset**. print 모드(`-p`)는 한 응답 후 **종료**하므로 입력이 도착하기 전에
죽어 M5(입력 왕복)가 불가능하다. M5 는 대신 **인터랙티브** claude 세션(라이브 PTY, REPL 유지)을 띄워
**앱의 입력 경로**(app→relay→daemon→PTY→claude)를 진짜로 굴린다 — 전 8마커(M0–M5).

- **세션 = INTERACTIVE** (`real-daemon-pair.ts --spawn-claude-interactive`): `tp run --sid … --
  --permission-mode bypassPermissions` (no `-p`). dogfood permission 모드라 per-tool 승인 프롬프트가 앱의
  단일 프롬프트를 막지 않는다.
- **trust 프롬프트 우회 = `\r` (Enter) over IPC**: 인터랙티브 claude 는 시작 시 PTY 에 "Do you trust this
  folder? 1. Yes / 2. No" 를 렌더한다(print 모드는 스킵). `~/.claude.json` 에 `hasTrustDialogAccepted:true`
  를 pre-seed 해도 현 claude 버전에선 **부족** — holder 가 spawn 후 (t+9s, t+15s 두 번, cold-start 보강용)
  IPC `input {sid, data:base64("\r")}` 를 보내 default 강조 옵션 1("Yes, I trust")을 수락한다. daemon 의
  command-dispatcher(`input` case, `findRunnerBySid`)가 runner PTY 로 라우팅 → 세션이 REPL idle 로 진입.
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
- **M5 어서션 = 이중 증명 (echo OR 새 Stop)**: `RelayClient.checkInputEcho` 는 **둘 중 하나**면 `TP_INPUT_OK`
  를 emit: (1) terminalOutput 에 probe 가 echo 됨(`proof=echo`) — loopback 의 byte-echo 뿐 아니라 **인터랙티브
  claude 가 타이핑된 입력을 자기 입력 박스에 렌더하면 그 io 스트림에도 probe 텍스트가 나타나므로** 실 claude
  도 보통 이 경로로 통과한다, 또는 (2) probe 전송 시점 baseline 을 **넘는 새 assistant `Stop`**(`proof=response`).
  실 claude M5 의 결정적 증명은 마커가 아니라 **세션 DB 의 `UserPromptSubmit≥1`** (=`\r` 가 실제로 프롬프트를
  제출했다는 직접 증거) — `TP_E2E_KEEP_DIR=1` 로 dir 보존 후
  `sqlite3 …/real-smoke-sess.sqlite "SELECT name,COUNT(*) FROM records WHERE kind='event' GROUP BY name"`
  로 확인. (`Stop` 은 claude 응답 완료 타이밍에 따라 마커 캡처 시점엔 아직 안 왔을 수 있다 — `UserPromptSubmit`
  이 제출 증명의 SoT.)

> **정직한 범위 — print 모드(`TP_E2E_CLAUDE`)는 M0–M4 (7마커)**, **인터랙티브 모드(`TP_E2E_CLAUDE_M5`)는
> M0–M5 (전 8마커)**. M4/M5 는 단일 세션에서 상호배타적(print 는 입력 전에 종료, interactive 는 입력을 받음)
> 이라 두 모드로 나눈다. M5 모드가 M4 도 포함하므로 dogfood 전 증명은 `TP_E2E_CLAUDE_M5=1` 한 번으로 충분.
>
> **절대 GitHub CI 에서 안 돈다**: claude 인증이 ci.yml 에 안 엮여 있고(토큰은 `claude.yml` 봇 전용),
> 비결정론적(행 가능)이며, API 크레딧을 쓰고, 토큰 추출이 **개발자 macOS Keychain** 을 읽는다 — hosted
> runner 에 없다. **로컬 pre-merge 게이트 전용** (`TP_E2E_CLAUDE_M5=1 [TP_PLATFORM=ios|ipad|macos|visionos]
> scripts/ios.sh smoke`, `claude` PATH 필수). CI 는 결정론 검증만: `swift-build`(컴파일) + 선택적
> `swift-smoke-ios`(loopback 가짜 daemon).
>
> **플랫폼 커버리지 (전부 8/8 실 claude M5 검증됨, 2026-06-30)**: iOS Simulator · iPadOS(iOS-family alias) ·
> **macOS 네이티브**(`open -a "$app" "$link"` 딥링크 라우팅) · **visionOS Simulator**. watchOS 만 제외(M5
> probe 경로 없음). daemon+relay+claude 는 항상 호스트에서 돌고 앱만 sim/네이티브로 뜨므로 visionOS sim 도
> 실 claude 원격 컨트롤이 가능하다 — sim 안에서 PTY/claude 를 띄우는 게 아니다.
>
> **하니스 함정 2건 (이 배선에서 발견·수정)**: (1) `parse_e2e_gates` 의 마지막 `[ … ] && …` 가 게이트 unset
> 시 exit 1 을 내 `set -e` 아래 caller(`cmd_smoke_macos`)를 빌드 직후 조용히 abort → **`return 0`** 로 닫음.
> (2) 같은 sim 에서 실-claude(sid=`real-smoke-sess`) 직후 loopback(sid=`sess-smoketest`)을 돌리면, 이전 런의
> `TP_SESSION_OK`/`TP_INPUT_OK` 줄이 unified-log 윈도에 남아 blind `tail -n1` 을 shadow → "wrong sid" 오탐.
> **`prefer_sid`** 헬퍼가 `sid=$SMOKE_SESSION_ID` 매칭 줄을 우선 선택(없으면 기존 tail 폴백 — loopback/CI 바이트
> 동일)해 런 순서 독립성을 보장한다. CI 는 loopback 만(sid 항상 동일) 돌아 (2)에 절대 노출 안 됨.

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
