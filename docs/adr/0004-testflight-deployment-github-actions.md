# ADR-0004 — TestFlight 배포 파이프라인 복원 (GitHub Actions, EAS Submit 대체)

- 상태: **Accepted** (2026-06-26)
- 결정자: Dave
- 관계: **ADR-0001 §5 "EAS 클라우드 빌드/배포 제거"를 부분적으로 보완(amend)한다.** ADR-0001 은
  Expo *빌드* 회귀 표면을 없애려고 EAS 전체를 걷어냈다. 그 결정(로컬 Simulator 하니스가 빌드/검증의
  SoT)은 유효하다. 다만 EAS 가 함께 제공하던 **배포(앱을 테스터에게 전달하는 경로)** 가 같이 사라져
  공백이 됐다 — 이 ADR 이 그 배포 경로만 표준 Apple 도구로 복원한다. 빌드/검증 SoT 는 여전히
  `scripts/ios.sh` (ADR-0001/0002).

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

## 3. 번들 ID 연속성 — "기존 EAS 채널 그대로" 의 현실

구 Expo 앱의 번들 ID 는 **`dev.tpmt.app`** 였다 (제거된 `apps/app/app.json`, git 히스토리
`d2e9865^` 에서 확인). 네이티브 앱은 **`dev.tpmt.teleprompter`** 다 (`ios/project.yml`).

> **App Store Connect 앱 레코드는 번들 ID 1개에 묶인다.** 번들 ID 가 달라졌으므로 네이티브 앱은
> 구 Expo 앱이 쓰던 **동일한 ASC 레코드/TestFlight 채널로 그대로 올라가지 않는다.** 두 선택지:
>
> 1. **새 ASC 앱 레코드** (현행 `dev.tpmt.teleprompter` 유지) — 깨끗한 출발, 단 기존 테스터/리뷰
>    이력과 단절. **기본값.**
> 2. **구 레코드 재사용** — 네이티브 앱의 `PRODUCT_BUNDLE_IDENTIFIER` 를 `dev.tpmt.app` 으로
>    되돌리면 기존 ASC 레코드/채널에 새 빌드로 올라간다. `tp://` URL 스킴·entitlements·keychain
>    access group 은 번들 ID 와 독립이라 영향 없음.
>
> 파이프라인은 번들 ID 에 **무관**하게 동작한다 (`project.yml` 의 `PRODUCT_BUNDLE_IDENTIFIER` 가
> SoT, archive/export 가 그대로 따라감). 어느 쪽을 택할지는 ASC 측 결정 — 파이프라인 변경 불필요.

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
