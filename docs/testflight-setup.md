# TestFlight 셋업 체크리스트 (5-플랫폼)

> **이 문서는 에이전트가 자동화할 수 없는, 당신만 Apple 계정으로 할 수 있는 작업의 체크리스트다.**
> CI/CD 스캐폴딩(워크플로·`scripts/ios.sh archive` 분기·ExportOptions·가드)은 이미 repo 에 들어가
> 있고, 아래 시크릿/레코드가 채워지는 즉시 `v*` 태그 push 한 번으로 TestFlight 까지 자동으로 올라간다.
> 시크릿이 없으면 각 플랫폼 job 은 PR 을 막지 않고 깔끔히 skip 한다 (ADR-0004 §7).

SoT: ADR-0004 §7 (Amendment 1). 도구 = Apple 공식만 (`xcodebuild` + `xcrun altool` + ASC API 키).
fastlane/EAS/Xcode Cloud 미사용.

---

## 0. 공유 (전 플랫폼 1회)

App Store Connect API 키 + 팀 ID 는 5개 플랫폼이 전부 공유한다.

- [ ] **ASC API 키 발급** — App Store Connect → Users and Access → Integrations → App Store Connect
      API → **+** 로 키 생성 (Access: *App Manager* 이상). `AuthKey_XXXXXXXXXX.p8` 다운로드(1회만
      가능), **Key ID** 와 **Issuer ID** 기록.
- [ ] GitHub Secrets 등록:
  ```bash
  gh secret set ASC_API_KEY_P8_BASE64 < <(base64 -i AuthKey_XXXXXXXXXX.p8)
  gh secret set ASC_API_KEY_ID    -b 'XXXXXXXXXX'
  gh secret set ASC_API_ISSUER_ID -b '<issuer-uuid>'
  gh secret set APPLE_TEAM_ID     -b '<10자 팀 ID>'
  ```

---

## 1. iOS / iPadOS (이미 구현됨 — 시크릿만 채우면 라이브)

iPadOS 는 iOS `.ipa` 에 자동 포함(`TARGETED_DEVICE_FAMILY "1,2"`) — 별도 작업 없음.

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app` (iOS 플랫폼). 구 Expo 레코드 재사용 가능 (ADR-0004 §3).
- [ ] **Apple Distribution 인증서**(.p12, cert+key) export →
      `gh secret set IOS_DIST_CERT_P12_BASE64 < <(base64 -i dist.p12)`
      `gh secret set IOS_DIST_CERT_PASSWORD -b '<p12 암호 (없으면 빈 문자열)>'`
- [ ] **App Store provisioning profile** (`dev.tpmt.app`, Distribution) →
      `gh secret set IOS_PROVISIONING_PROFILE_BASE64 < <(base64 -i ios.mobileprovision)`
- [ ] **검증**: `gh workflow run release.yml` 이후 `v*` 태그가 서면 `testflight.yml` 의 iOS job 이
      자동으로 archive→upload. 또는 `gh workflow run testflight.yml` 수동 dispatch.

---

## 2. macOS (Mac App Store TestFlight)

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app`, **macOS 플랫폼** (iOS 레코드와 별개 — ASC 는
      플랫폼별 레코드).
- [ ] **Mac App Distribution 인증서**(.p12). iOS Distribution 과 **다른 인증서 타입**이다 →
      `gh secret set MAC_DIST_CERT_P12_BASE64 < <(base64 -i mac-dist.p12)`
      `gh secret set MAC_DIST_CERT_PASSWORD -b '<암호>'`
- [ ] **Mac App Store provisioning profile** (`.provisionprofile`) →
      `gh secret set MAC_PROVISIONING_PROFILE_BASE64 < <(base64 -i mac.provisionprofile)`
- [ ] **검증**: `TP_PLATFORM=macos TP_DEVELOPMENT_TEAM=<팀> scripts/ios.sh archive` 가 로컬 keychain
      서명으로 통과하는지(인증서 보유 시), 그리고 `testflight.yml` 의 macOS job 이 green 인지.

---

## 3. visionOS

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app`, **visionOS 플랫폼**.
- [ ] **visionOS provisioning profile** (App Store, `dev.tpmt.app`). 인증서는 iOS Distribution 재사용
      가능(같은 팀) →
      `gh secret set VISIONOS_PROVISIONING_PROFILE_BASE64 < <(base64 -i visionos.mobileprovision)`
- [ ] **검증**: `testflight.yml` 의 visionOS job green. (`altool --type visionos` 는 Xcode 15.2+
      필요 — `macos-26` 러너 충족.)

---

## 4. watchOS (standalone)

`TeleprompterWatch` 는 독립 앱(`WKRunsIndependentlyOfCompanionApp: YES`) — iOS 와 **별도 ASC 레코드 +
별도 업로드**.

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app.watch`, **watchOS 플랫폼**.
- [ ] **watchOS provisioning profile** (App Store, `dev.tpmt.app.watch`). 인증서는 iOS Distribution
      재사용 →
      `gh secret set WATCHOS_PROVISIONING_PROFILE_BASE64 < <(base64 -i watchos.mobileprovision)`
- [ ] **검증**: `testflight.yml` 의 watchOS job green.

---

## 참고

- 빌드 번호는 워크플로가 `run_number*100+run_attempt` 로 자동 부여 (ASC 재사용 거부 회피) — 수동 관리
  불필요.
- 모든 시크릿은 일회용 keychain 에 주입되고 `always()` 로 정리된다 — 러너 login keychain 안 건드림.
- 시크릿 하나라도 빠진 플랫폼의 job 은 `::notice::` 와 함께 skip — 다른 플랫폼/PR 에 영향 없음.
- 플랫폼 job 은 처음엔 전부 **non-required** (ci-workflows.md). main 에서 안정 green 확인 후 승격.
