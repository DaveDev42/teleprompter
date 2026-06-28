# ADR-0004 — TestFlight 배포 파이프라인 복원 (GitHub Actions, EAS Submit 대체)

- 상태: **Accepted** (2026-06-26) · **Amendment 1: 5-플랫폼 TestFlight 확장 (2026-06-27)**
- 결정자: Dave
- 관계: **ADR-0001 §5 "EAS 클라우드 빌드/배포 제거"를 부분적으로 보완(amend)한다.** ADR-0001 은
  Expo *빌드* 회귀 표면을 없애려고 EAS 전체를 걷어냈다. 그 결정(로컬 Simulator 하니스가 빌드/검증의
  SoT)은 유효하다. 다만 EAS 가 함께 제공하던 **배포(앱을 테스터에게 전달하는 경로)** 가 같이 사라져
  공백이 됐다 — 이 ADR 이 그 배포 경로만 표준 Apple 도구로 복원한다. 빌드/검증 SoT 는 여전히
  `scripts/ios.sh` (ADR-0001/0002).

> **Amendment 1 (2026-06-27): TestFlight 를 5개 Apple 플랫폼 전부로 확장.** 본 ADR 의 원안(§2–§6)은
> iOS(+ iPadOS 동반) TestFlight 만 다루고 macOS/watchOS/visionOS 는 §6 에서 "후속/별도 결정" 으로
> 미뤘다. Amendment 1 은 그 미룬 결정을 내려, **iOS·iPadOS·macOS·watchOS·visionOS 5개 전부를 동일한
> GitHub Actions + Apple 공식 도구 패턴으로 TestFlight(App Store Connect)에 올린다.** 도구·시크릿
> 게이트·일회용 keychain·빌드번호 공식·non-required 진입 같은 원안의 모든 불변식은 그대로 보존된다.
> 상세는 아래 **§7 Amendment 1** 참조. 원안 §6 의 "후속" 항목들은 §7 이 대체한다 (superseded).

## 1. 맥락

ADR-0001 의 네이티브 재작성으로 Expo + **EAS 전체**(빌드 + Submit)가 제거됐다. 그 결과:

- 로컬 `scripts/ios.sh` 하니스가 빌드/검증을 완전히 대체했다 (의도대로 — ADR-0001/0002).
- 그러나 **테스터에게 앱을 전달하는 경로(EAS Submit → TestFlight)는 대체물 없이 사라졌다.**
  `.github/workflows/` 에 TestFlight/App Store 업로드가 없고, 코드사이닝 구성도 없었다 (모든 빌드가
  Simulator/로컬 전용 ad-hoc 서명 `CODE_SIGN_IDENTITY="-"`).

CI/CD 배포는 프로젝트의 기본 인프라다. 네이티브 앱이 Simulator/로컬에서 동작 검증까지 끝났는데
(8마커 E2E + XCUITest) 실기기/TestFlight 로 나가는 자동 경로가 없는 것은 메워야 할 공백이다.

## 2. 결정

**GitHub Actions(`macos-26` 러너)에서 archive → 서명 → export → TestFlight 업로드를 자동화한다.**
EAS Submit 이 하던 "태그 push → 클라우드 빌드 → TestFlight" 를 **3rd-party 서비스 없이 Apple 공식
도구만으로** 복원한다.

- **워크플로**: `.github/workflows/testflight.yml`. `v*` 태그 push 또는 수동 dispatch 트리거.
- **빌드 절반은 하니스에**: `scripts/ios.sh archive` (iOS device 슬라이스 Release archive →
  `-exportArchive` → App Store `.ipa`). 빌드 로직을 워크플로에 흩지 않고 하니스에 두는 기존 규율
  (`build`/`smoke`/`uitest` 와 동일) 을 따른다. export 옵션 = `ios/ExportOptions.plist`.
- **업로드 절반은 워크플로에**: `xcrun altool --upload-app` + **ASC API 키(.p8)**. 네트워크 호출 +
  Apple 발급 시크릿이 필요하므로 하니스 밖.
- **서명**: 실 Apple Distribution 인증서(.p12) + App Store provisioning profile 을 **일회용
  keychain** 에 base64 시크릿에서 주입(러너 기본 login keychain 절대 안 건드림), `always()` 로 정리.
- **빌드 번호 = `github.run_number`** (단조 증가 — ASC 는 재사용 빌드 번호를 거부). 버전 문자열은
  `project.yml` 의 `MARKETING_VERSION`.
- **시크릿 게이트**: 값이 없으면 `guard` job 이 명확한 메시지로 skip — 포크/시크릿-없는 환경에서
  PR 을 절대 wedge 하지 않는다 (신규 job 은 항상 non-required, ci-workflows.md 규율).

필요 시크릿: `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`,
`IOS_PROVISIONING_PROFILE_BASE64`, `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`,
`ASC_API_ISSUER_ID`, `APPLE_TEAM_ID`.

## 3. 번들 ID 연속성 — "기존 EAS 채널 그대로" (결정: 구 레코드 재사용)

구 Expo 앱의 번들 ID 는 **`dev.tpmt.app`** 였다 (제거된 `apps/app/app.json`, git 히스토리
`d2e9865^` 에서 확인). 네이티브 재작성은 일시적으로 `dev.tpmt.teleprompter` 를 썼었다.

> **App Store Connect 앱 레코드는 번들 ID 1개에 묶인다.** "기존 EAS 채널 그대로 배포" 요구를
> 만족시키려면 네이티브 앱이 구 Expo 와 **동일한 번들 ID** 여야 동일 ASC 레코드/TestFlight 채널에
> 올라간다.
>
> **결정 (2026-06-26): 구 레코드 재사용 — 번들 ID 를 `dev.tpmt.app` 으로 통일.** 네이티브 앱의
> `PRODUCT_BUNDLE_IDENTIFIER`(+ watch companion `dev.tpmt.app.watch`, test 타깃들, `tp://` URL
> 스킴 name, **entitlements keychain-access-group**)를 `dev.tpmt.app` 으로 되돌렸다. 일관성을 위해
> os.Logger subsystem 문자열(~40곳)·keychain service 이름·하니스/docs 폴링 predicate 도 전부
> `dev.tpmt.app` 으로 통일했다 (subsystem 과 predicate 는 **반드시 동시에** 바꿔야 smoke 마커가
> 계속 매칭된다).
>
> **주의 — bundle id 에 묶이는 것들** (단순 "독립" 이 아님): keychain-access-group 은
> `$(AppIdentifierPrefix)<bundle-id>` 형태라 bundle id 를 따라가야 앱이 자기 그룹에 접근 가능하고,
> APNs 토픽(`APNS_BUNDLE_ID`)도 bundle id 와 일치해야 푸시가 도달한다 — 그래서 둘 다 함께 바꿨다.
> keychain *service* 이름(generic-password service attr)은 기능상 bundle id 와 무관한 불투명
> 문자열이지만, 일관성을 위해 같이 통일했다.
>
> 파이프라인 자체는 번들 ID 에 **무관**하다 (`project.yml` 의 `PRODUCT_BUNDLE_IDENTIFIER` 가 SoT,
> archive/export 가 그대로 따라감) — 다른 ID 로 가려면 그 한 줄만 바꾸면 된다.

## 4. 대안 (기각)

- **EAS Submit 복원**: ADR-0001 이 Expo/EAS 의존 표면을 의도적으로 제거했다. 배포만 위해 EAS 를
  되살리는 건 그 결정을 뒤집는다. Apple 공식 도구로 동등 기능 가능 → 기각.
- **fastlane (match/gym/pilot)**: 재현 가능·CI 친화적이지만 fastlane(+ Ruby gem) 의존성을 새로
  추가한다 — ADR 의 "의존성 표면 축소" 방향과 충돌. `xcodebuild` + `xcrun altool` 로 충분 → 기각.
- **로컬 Mac 에서 수동 archive/upload**: 1인 개발에선 가능하나 "CI/CD = 프로젝트 기본" 요구에
  미달(재현성·자동화 없음) → 기각.

## 5. 보존되는 불변식

- 빌드/검증 SoT 는 여전히 `scripts/ios.sh` 하니스 (ADR-0001/0002) — 이 ADR 은 **배포 경로만**
  추가한다.
- Simulator/로컬 빌드의 ad-hoc 서명(`CODE_SIGN_IDENTITY="-"`)은 그대로 — 실 서명은 `cmd_archive`
  (distribution) 경로에서만.
- 시크릿은 워크플로가 읽기만 하고 절대 커밋/로그하지 않는다 (일회용 keychain, `always()` 정리).
- 신규 CI job 은 non-required 로 진입 — main 안정 green 확인 후 승격 (ci-workflows.md).

## 6. 후속

- 실기기 분산(ad-hoc/development) 배포가 필요하면 동일 패턴에 `method: development` ExportOptions
  변형 추가.
- macOS 앱(Phase A) 의 Developer ID 공증(notarization) 배포는 별도 — 현 파이프라인은 iOS
  TestFlight 만 다룬다 (`cmd_archive` 가 iOS-only 로 가드).
- **watchOS 는 자동 동반 업로드 안 됨** — `TeleprompterWatch` 는 `WKRunsIndependentlyOfCompanionApp:
  YES` 인 독립 타깃이고 iOS `Teleprompter` 타깃의 임베드 의존성이 아니며 `Teleprompter` 스킴에도
  포함되지 않는다 (`project.yml`). 따라서 `xcodebuild archive -scheme Teleprompter` 산출물은
  **iOS-only `.ipa`** 다. watchOS 배포가 필요하면 별도 archive + TestFlight 업로드 파이프라인이 필요
  (또는 companion 임베드를 원하면 `project.yml` 에서 watch 타깃을 iOS 타깃의 임베드 의존성으로 추가 +
  `WKRunsIndependentlyOfCompanionApp: NO` — 별도 결정).

  > 위 §6 의 macOS / watchOS / visionOS "후속·별도 결정" 3개 항목은 **Amendment 1(§7)이 결정하여
  > 대체한다.** iOS 실기기 ad-hoc/development 분산(첫 항목)만 여전히 후속으로 남는다.

## 7. Amendment 1 — 5-플랫폼 TestFlight 확장 (2026-06-27)

목표: **iOS·iPadOS·macOS·watchOS·visionOS 5개 전부를 TestFlight(App Store Connect)에 올린다.** 원안의
iOS-전용 파이프라인을, 플랫폼별 archive 분기 + 플랫폼별 ExportOptions + 플랫폼별 업로드 job 으로
확장한다. 도구·구조·불변식은 원안 그대로 — 플랫폼 축만 늘린다.

### 7.1 플랫폼별 결정 (요청자 확정)

- **macOS → TestFlight (Mac App Store), Developer ID 공증 아님.** 원안 §6 은 macOS 를 Developer ID
  notarization 으로 미뤘으나, Amendment 는 **`method: app-store-connect` 로 MAS TestFlight** 에 올린다
  (iOS 와 동일한 ASC TestFlight 흐름). Mac App Distribution 인증서 + Mac App Store provisioning
  profile + **별도 ASC macOS 앱 레코드**(번들 ID `dev.tpmt.app`, macOS 플랫폼) 필요. Developer ID
  직접배포(.dmg/notarytool)는 채택하지 않는다 (요청자: "일단은 TestFlight만").
- **watchOS → standalone, iOS 컨테이너로 배포.** `TeleprompterWatch` 는
  `WKRunsIndependentlyOfCompanionApp: YES` 를 **유지**(런타임 독립 보존, ADR-0002 B3). 단 **구현 단계에서
  드러난 사실로 원안의 "단독 watch archive" 는 불가**: App Store Connect 에 watchOS 플랫폼 선택지가 없고
  (WWDC19 §208), altool `--type` enum 에 `watchos` 가 없으며(`macos|ios|appletvos|visionos`),
  `generic/platform=watchOS` 단독 archive 는 "Generic Xcode Archive"(배포 불가)로 나온다. **정정된 결정**:
  watch 앱을 **iOS 컨테이너 타깃 `TeleprompterWatchContainer`**(`type: application.watchapp2-container`,
  platform iOS)에 임베드 → `-scheme TeleprompterWatchContainer -destination generic/platform=iOS` archive
  → `.ipa` → **`altool --type ios`**. 컨테이너는 **배포 포장지일 뿐** (런타임에 watch 는 여전히 독립 설치/
  실행, iPhone 에 iOS 앱 불필요 — App Store 서버가 watch 슬라이스를 watchOS App Store 로 라우팅). 번들 ID:
  컨테이너(레코드 id) `dev.tpmt.app.watch` + 임베드 watch `dev.tpmt.app.watch.watchkitapp`(공유 불가).
  XcodeGen v2.45.4 가 `watchapp2-container` 타입 수락 + "Embed Watch Content" phase 자동 배선(경험적 확인 —
  pbxproj 수동 패치 불요). companion 임베드(실 iOS 동반앱) 전환은 채택하지 않는다 — 컨테이너는 빈 껍데기.
  **별도 ASC 레코드**(번들 ID `dev.tpmt.app.watch`, iOS 플랫폼 레코드로 생성). 알려진 리스크: Xcode 26.x
  watch exportArchive 거부 버그(FB23341311) — 컨테이너 archive 가 표준 우회책, 그래도 막히면 `.app`→`.ipa`
  수동 패키징 fallback.
- **visionOS → TestFlight.** 원안에 stance 가 없던 visionOS 를 추가: `generic/platform=visionOS`
  archive → `altool --type visionos`(Xcode 15.2+). 번들 ID `dev.tpmt.app`, **별도 ASC visionOS 앱
  레코드** 필요.
- **iPadOS → iOS 와 동일 `.ipa`.** 별도 작업 없음 — `TARGETED_DEVICE_FAMILY "1,2"` 로 iOS 업로드에
  자동 포함. (변경 없음, 명시만.)

### 7.2 구조 (원안 패턴 보존)

- **하니스**: `cmd_archive` 가 `resolve_archive_params()` 로 `TP_PLATFORM` 분기한다 —
  destination(ios/ipad/watchos→`generic/platform=iOS`, macos→macOS, visionos→visionOS),
  scheme(`Teleprompter` | watchos→`TeleprompterWatchContainer`), ExportOptions(플랫폼별), artifact ext
  (ipa/pkg). keychain/team/빌드번호/`-exportArchive` 로직은 공유. 더는 iOS-only `die` 가 아니다 (5개
  플랫폼; ipad→ios 접힘, watchos→iOS 컨테이너). watch 분기는 archive 가 "Generic Xcode Archive" 가
  아닌지(`Info.plist ApplicationProperties`) 단언으로 조기 차단.
- **ExportOptions**: 플랫폼별 파일 — `ios/ExportOptions.plist`(기존, iOS),
  `ios/ExportOptions.macos.plist`, `ios/ExportOptions.visionos.plist`,
  `ios/ExportOptions.watchos.plist`. 전부 `method: app-store-connect`, `signingStyle: manual`.
- **워크플로**: `testflight.yml` 에 플랫폼별 `guard`/`archive-and-upload` job 추가. 각 job 은
  자기 플랫폼 provisioning profile 시크릿 + 공유 ASC/팀 시크릿으로 게이트되고, 없으면 clean skip
  (PR wedge 없음). 업로드는 `xcrun altool --upload-app --type {ios|macos|visionos}` — **watch 는
  `--type ios`**(altool 에 `watchos` type 없음; standalone watch 는 iOS 패키지로 업로드).
  **신규 job 은 전부 non-required 로 진입** (ci-workflows.md 규율).

### 7.3 시크릿 모델 확장

원안 7개(iOS) 위에 플랫폼별 인증서/프로파일을 추가한다. ASC API 키(`ASC_API_KEY_*`)와 `APPLE_TEAM_ID`
는 **전 플랫폼 공유**. 추가 시크릿(요청자가 Apple 계정으로 생성 — 자동화 불가):

> **⚠️ 아래 표의 watchOS 행은 §8.3 (Amendment 2, #123) 으로 SUPERSEDED 됨.** watch 는 더 이상 별도
> 컨테이너/별도 ASC 레코드/2-profile 모델이 아니다 — iOS 앱에 컴패니언으로 임베드돼 **단일 watch profile
> `IOS_WATCH_PROVISIONING_PROFILE_BASE64`** (bundle `dev.tpmt.app.watchkitapp`, ASC 레코드는 `dev.tpmt.app`
> 단일) 만 쓴다. 아래 `WATCHOS_CONTAINER_*`/`WATCHOS_APP_*` 시크릿은 **DEAD** — 설정하지 말 것. 정확한
> 모델은 §8.3 참조. (macOS/visionOS 행은 유효.)

| 플랫폼 | 추가 시크릿 | 비고 |
|--------|-------------|------|
| macOS  | `MAC_DIST_CERT_P12_BASE64`, `MAC_DIST_CERT_PASSWORD`, `MAC_PROVISIONING_PROFILE_BASE64` | Mac App Distribution 인증서 + MAS profile (`.provisionprofile`). 별도 ASC macOS 레코드. |
| visionOS | `VISIONOS_PROVISIONING_PROFILE_BASE64` | iOS Distribution 인증서 재사용 가능(같은 팀); profile 만 별도. 별도 ASC visionOS 레코드. |
| ~~watchOS~~ (SUPERSEDED → §8.3) | ~~`WATCHOS_CONTAINER_PROVISIONING_PROFILE_BASE64`, `WATCHOS_APP_PROVISIONING_PROFILE_BASE64`~~ | **DEAD (Amendment 2, #123).** watch 는 iOS 앱에 임베드 — `IOS_WATCH_PROVISIONING_PROFILE_BASE64` 단일 profile (bundle `dev.tpmt.app.watchkitapp`), ASC 레코드 `dev.tpmt.app` 단일. §8.3 참조. |

> **자동화 경계.** GitHub Secrets 주입과 ASC 앱 레코드/프로비저닝 프로파일 생성은 Apple 계정 접근이
> 필요해 **에이전트가 못 한다 — 요청자만 가능**. Amendment 의 CI/CD 스캐폴딩(워크플로·하니스 분기·
> ExportOptions·가드)은 시크릿이 채워지는 즉시 라이브가 되도록 작성하고, 없으면 전부 clean skip 한다.
> 각 시크릿 생성 절차는 `docs/testflight-setup.md`(체크리스트) 참조.

### 7.4 보존 불변식 (원안 §5 그대로)

빌드/검증 SoT = `scripts/ios.sh`; Simulator/로컬 ad-hoc 서명 불변; 시크릿은 읽기-전용·일회용 keychain·
`always()` 정리; 신규 job non-required 진입; 빌드번호 = `run_number*100+run_attempt`(shell 산술).
번들 ID SoT = `project.yml` `PRODUCT_BUNDLE_IDENTIFIER`.

## 8. Amendment 2 — watchOS: companion 임베드로 전환 (2026-06-28, #123)

목표(요청자 확정): **watch 앱을 컴패니언으로 배포하고(iPhone 에서 설치·설정), 실제 구동은 iPhone 과
떨어져 있어도 단독으로 할 수 있다.** 즉 **companion DISTRIBUTION + standalone RUNTIME**. 이 둘은 상호
배타가 아니다 — 배포 모델(임베드 vs 독립 컨테이너)과 런타임 플래그(`WKRunsIndependentlyOfCompanionApp`)
는 별개 축이다.

### 8.1 Amendment 1 §7.1 watchOS 결정의 정정 (이 부분만 supersede)

Amendment 1 §7.1 은 watch 를 **독립 컨테이너(`TeleprompterWatchContainer`,
`application.watchapp2-container`)에 임베드해 별도 ASC 레코드(`dev.tpmt.app.watch`)로** 배포하기로 했고,
"companion 임베드(실 iOS 동반앱) 전환은 채택하지 않는다 — 컨테이너는 빈 껍데기"(§7.1 L136)라고 명시했다.
**Amendment 2 는 이 결정을 뒤집는다**: watch 를 빈 컨테이너가 아니라 **실제 메인 iOS 앱(`dev.tpmt.app`)의
임베드 의존성**으로 만든다. (§7.1 의 macOS·visionOS·iPadOS 결정과 §7.2~7.4 의 도구·구조·시크릿·불변식은
그대로 유효 — 이 Amendment 는 watchOS 축만 정정한다.)

### 8.2 정정 후 토폴로지

- **번들 ID 3 → 2**: `dev.tpmt.app`(메인, iOS 목적지에서만 watch 임베드) + `dev.tpmt.app.watchkitapp`
  (watch). `TeleprompterWatchContainer` 타깃·스킴과 그 레코드 `dev.tpmt.app.watch` 는 **삭제**. ASC
  레코드 2개 → **1개**(`dev.tpmt.app` 단일 레코드에 watch 슬라이스 동반).
- **임베드 배선**: 멀티플랫폼 `Teleprompter` 타깃(`platform: auto`, `supportedDestinations: [iOS, macOS,
  visionOS]`)의 dependency 에 `- target: TeleprompterWatch / embed: true / destinationFilters: [iOS]`
  추가. `destinationFilters: [iOS]` 가 "Embed Watch Content" copy phase 를 **iOS 목적지로만** 스코프
  (pbxproj `platformFilters = (ios,)`) → macOS/visionOS 슬라이스는 watch 를 임베드하지 않아 macOS
  `swift-build` CI 게이트가 깨지지 않는다. **경험적 검증 완료**(XcodeGen 2.45.4): plain `type: application`
  호스트에도 copy phase 자동 배선 + macOS `BUILD SUCCEEDED`(임베드 존재 상태). `copy: subpath` fallback
  불요.
- **런타임 플래그 보존**: watch 는 `WKApplication_IsIndependentApp: YES` +
  `WKRunsIndependentlyOfCompanionApp: YES` **유지**. companion(`WKCompanionAppBundleIdentifier`)은 이제
  빈 컨테이너가 아니라 **실제 메인 앱 `dev.tpmt.app`** 을 가리킨다. → 사용자는 iPhone 에서 한 번 설정,
  이후 iPhone 이 꺼져 있어도 Apple Watch 에서 단독 구동.
- **하니스**: `cmd_archive` 의 `resolve_archive_params()` 에서 **watchos 분기 삭제** — watch 는 iOS
  archive 안에 동반되므로 별도 archive 가 없다. `TP_PLATFORM=watchos archive` 는 iOS 경로를 가리키는
  `die`. watchOS **Simulator SMOKE** 경로(`TeleprompterWatch` 직접 빌드, 7마커)는 **그대로** — standalone
  RUNTIME 증명이며 배포와 분리된다.
- **워크플로**: `testflight.yml` 의 `guard-watchos` + `archive-and-upload-watchos` job **삭제**. iOS job
  이 watch 디바이스 슬라이스를 빌드+서명한다 — nightly Rust + rust-src(arm64_32 build-std),
  `xcodebuild -downloadPlatform watchOS`, 임베드 watch 앱 profile 설치. `ios/ExportOptions.watchos.plist`
  **삭제**(iOS ExportOptions 가 keychain-by-bundle-id 로 임베드 watch profile 을 자동 해소).
- **`.ipa` 산출물**: `Payload/Teleprompter.app/Watch/TeleprompterWatch.app` 로 watch 동반,
  `altool --type ios` 단일 업로드 → ASC 가 watch 슬라이스를 watchOS App Store 로 라우팅.

### 8.3 시크릿 모델 정정 (Amendment 1 §7.3 watchOS 행 대체)

watchOS 행의 profile **2개**(`WATCHOS_CONTAINER_PROVISIONING_PROFILE_BASE64` +
`WATCHOS_APP_PROVISIONING_PROFILE_BASE64`)는 **폐기**. 대신 단일
`IOS_WATCH_PROVISIONING_PROFILE_BASE64`(임베드 watch 앱 `dev.tpmt.app.watchkitapp`, iOS Distribution
인증서 재사용)가 **iOS job 의 hard-required 시크릿**이 된다(iOS `.ipa` 가 임베드 watch 를 서명해야 하므로).
ASC watch 레코드(`dev.tpmt.app.watch`)는 더 이상 필요 없다. `setup-testflight-secrets.sh` 는 watch profile
발급 2회 → 1회로 축소.

> **드리프트 정정**: ADR-0002 L150 은 이미 `WKCompanionAppBundleIdentifier: dev.tpmt.app` 를 기록하고
> 있었다 — 임베드 전 live `project.yml` 의 `dev.tpmt.app.watch` 는 드리프트였고, 이 Amendment 는 그
> 의도(메인 앱이 companion)에 **재정렬**한다.

### 8.4 비용·리스크

기존 3-ID 토폴로지는 "독립 배포"의 본질적 형태였다(ASC 에 watchOS 플랫폼이 없어 독립 watch 는 iOS 컨테이너
레코드를 따로 가짐 — WWDC19 §208). companion 으로 전환하면 컨테이너 레코드가 사라져 ID 가 2개로 준다. **잃는
것**: 컨테이너를 통한 "iPhone 앱 없이 watch 단독 *설치*". **유지하는 것**: watch 단독 *구동*
(`WKRunsIndependentlyOfCompanionApp: YES`). 요청자는 단독 설치는 불필요·단독 구동만 필요하다고 명시했으므로
이 트레이드는 의도된 것. 리스크: iOS job cold time 증가(nightly + downloadPlatform watchOS) — `timeout-minutes:
50` 유지로 흡수. Xcode 26.x companion .ipa export 는 컨테이너 우회책보다 표준 경로라 FB23341311 회피 가능성이
더 높으나 첫 실업로드(#122)에서 확인 필요.
