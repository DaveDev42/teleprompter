# TestFlight 셋업 체크리스트 (5-플랫폼)

> **이 문서는 에이전트가 자동화할 수 없는, 당신만 Apple 계정으로 할 수 있는 작업의 체크리스트다.**
> CI/CD 스캐폴딩(워크플로·`scripts/ios.sh archive` 분기·ExportOptions·가드)은 이미 repo 에 들어가
> 있고, 아래 시크릿/레코드가 채워지는 즉시 `v*` 태그 push 한 번으로 TestFlight 까지 자동으로 올라간다.
> 시크릿이 없으면 각 플랫폼 job 은 PR 을 막지 않고 깔끔히 skip 한다 (ADR-0004 §7).

SoT: ADR-0004 §7 (Amendment 1). 도구 = Apple 공식만 (`xcodebuild` + `xcrun altool` + ASC API 키).
fastlane/EAS/Xcode Cloud 미사용.

---

## 자동화 경로 (`scripts/setup-testflight-secrets.sh`) — 권장

아래 §1–§4 의 **인증서 발급 + bundle ID 등록 + provisioning profile 생성 + `gh secret set` 13개**
는 `scripts/setup-testflight-secrets.sh` 가 **ASC REST API 를 직접 호출**(fastlane 없이 `openssl` +
`curl` + `gh` + `python3`)해서 자동화한다. `sigh` 가 못 만드는 visionOS/watchOS profile 도
`profileType=IOS_APP_STORE` + IOS-platform bundleId 로 직접 발급한다.

**당신이 직접 해야 할 것은 §0 의 `.p8` 발급(아래)과 ASC 앱 레코드 생성뿐이다.** 그 다음:

```bash
ASC_API_KEY_PATH=~/AuthKey_XXXXXXXXXX.p8 \
ASC_API_KEY_ID=XXXXXXXXXX \
ASC_API_ISSUER_ID=<issuer-uuid> \
APPLE_TEAM_ID=MU784AJZSW \
  scripts/setup-testflight-secrets.sh            # 5플랫폼 전부 (--dry-run 으로 먼저 점검 가능)
# 일부만: --platforms "ios macos visionos"
# Mac installer 분리(기본) vs 결합: --separate-installer (기본) / --combined-installer
```

- **TEAM 키 필수** — individual 키는 provisioning 엔드포인트(`/v1/certificates`·`/v1/bundleIds`·
  `/v1/profiles`)를 못 호출한다 (403). §0 에서 키 생성 시 *App Manager* 이상.
- **민감 자료는 머신 밖으로 안 나간다** — `.p8` 은 `ASC_API_KEY_PATH` 에 그대로 두고 스크립트가 읽기만,
  생성된 키/cert/.p12/비밀번호/manifest 는 gitignore 된 `~/.config/teleprompter/testflight/` (0700) 에
  영속. 재실행 시 cert 는 재사용(Apple 의 active 배포 cert ~2-3개 상한 회피), profile 만 재생성.
- **Apple 의 active 배포 cert 상한**(타입당 ~2-3개)에 걸려 로컬에 개인키 없는 cert 가 상한을 채웠으면,
  스크립트가 기존 cert 목록 + revoke 안내를 출력하고 멈춘다(자동 revoke 안 함).
- **여전히 수동**: ASC 앱 레코드(플랫폼별, API 생성 불가) — §1–§4 의 "ASC 앱 레코드" 체크박스 참조.

수동으로 하려면(또는 스크립트가 막히면) 아래 §0–§4 체크리스트가 그대로 fallback 이다.

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

> **macOS 는 서명 identity 가 *두 개* 다** — iOS 와 다른 핵심 차이. (1) **앱(.app) 서명용** Apple
> Distribution / "3rd Party Mac Developer Application", (2) **설치 패키지(.pkg) 서명용** "3rd Party Mac
> Developer Installer". Apple 포털에서 **별개 인증서 타입**이라 일반 단일 `.p12` export 엔 installer
> identity 가 안 들어있다. 두 가지 중 하나를 골라라:
>
> - **방법 A (권장, 시크릿 1개):** Keychain Access 에서 두 인증서를 **동시 선택** → 한 번에 하나의
>   `.p12` 로 export. 그러면 `MAC_DIST_CERT_P12_BASE64` 하나로 둘 다 들어온다.
> - **방법 B (시크릿 2개):** 각 인증서를 별도 `.p12` 로 export → application 은 `MAC_DIST_CERT_*`,
>   installer 는 `MAC_INSTALLER_CERT_*` 에 넣는다. 워크플로가 둘 다 import 한다.

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app`, **macOS 플랫폼** (iOS 레코드와 별개 — ASC 는
      플랫폼별 레코드).
- [ ] **Mac App Distribution 인증서**(.p12). iOS Distribution 과 **다른 인증서 타입**이다 →
      `gh secret set MAC_DIST_CERT_P12_BASE64 < <(base64 -i mac-dist.p12)`
      `gh secret set MAC_DIST_CERT_PASSWORD -b '<암호 (없으면 빈 문자열)>'`
- [ ] **(방법 B 일 때만) Mac Installer Distribution 인증서**(별도 `.p12`) →
      `gh secret set MAC_INSTALLER_CERT_P12_BASE64 < <(base64 -i mac-installer.p12)`
      `gh secret set MAC_INSTALLER_CERT_PASSWORD -b '<암호 (없으면 빈 문자열)>'`
      (방법 A 로 두 인증서를 하나의 `.p12` 에 합쳤다면 이 둘은 **생략** — 워크플로가 비어있으면 skip.)
- [ ] **Mac App Store provisioning profile** (`.provisionprofile`) →
      `gh secret set MAC_PROVISIONING_PROFILE_BASE64 < <(base64 -i mac.provisionprofile)`
- [ ] **검증**: `TP_PLATFORM=macos TP_DEVELOPMENT_TEAM=<팀> scripts/ios.sh archive` 가 로컬 keychain
      서명으로 통과하는지(두 인증서 보유 시), 그리고 `testflight.yml` 의 macOS job 이 green 인지.
      `.pkg` 서명 실패(`No such installer identity`)면 installer 인증서가 keychain 에 없는 것 — 방법 A/B
      중 하나로 채워라.

---

## 3. visionOS

> visionOS 는 **iOS Apple Distribution 인증서를 그대로 재사용**한다 (visionOS 전용 cert 타입 없음) —
> §1 에서 이미 등록한 `IOS_DIST_CERT_P12_BASE64` / `IOS_DIST_CERT_PASSWORD` 를 visionOS job 도 쓴다.
> 따라서 새로 등록할 시크릿은 **visionOS provisioning profile 하나뿐**이다. 프로파일은 iOS 처럼
> `.mobileprovision` 확장자.

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app`, **visionOS 플랫폼** (iOS/macOS 레코드와 별개).
- [ ] **visionOS provisioning profile** (App Store, `dev.tpmt.app`, visionOS) →
      `gh secret set VISIONOS_PROVISIONING_PROFILE_BASE64 < <(base64 -i visionos.mobileprovision)`
      (인증서는 §1 의 `IOS_DIST_CERT_*` 재사용 — 추가 cert 시크릿 불필요.)
- [ ] **검증**: `testflight.yml` 의 visionOS job green. (`altool --type visionos` 는 Xcode 15.2+
      필요 — `macos-26` 러너 충족.)

---

## 4. watchOS (standalone, via iOS 컨테이너)

> **App Store Connect 에는 watchOS 플랫폼 선택지가 없다.** 독립형 watch 앱도 **iOS 앱 레코드**로만
> 올라간다 (Apple 의 유일한 정식 경로 — WWDC19 §208). 그래서 `TeleprompterWatch`(독립 앱,
> `WKRunsIndependentlyOfCompanionApp: YES`)를 **iOS 컨테이너 `TeleprompterWatchContainer` 에 임베드**해서
> archive 한다. 컨테이너는 **배포 포장지일 뿐** — watch 앱은 여전히 Apple Watch 에 직접 설치/독립 실행되고
> 사용자 iPhone 에 iOS 앱이 없어도 된다. 업로드는 `altool --type ios` (watch 전용 type 없음). App Store
> 서버가 watch 슬라이스를 watchOS App Store 로 자동 라우팅.
>
> **번들 ID 2개**: 컨테이너(앱스토어 레코드 id) = `dev.tpmt.app.watch`, 임베드 watch 앱 =
> `dev.tpmt.app.watch.watchkitapp` (둘은 같은 id 공유 불가 — Apple watchapp2-container 레이아웃).
> 따라서 **provisioning profile 도 2개** 필요.

- [ ] **ASC 앱 레코드** — 번들 ID `dev.tpmt.app.watch`, **iOS 플랫폼 레코드로 생성**(watchOS 레코드라는
      건 없음; watch-only 정보만 채운다).
- [ ] **컨테이너 provisioning profile** (App Store, `dev.tpmt.app.watch`) →
      `gh secret set WATCHOS_CONTAINER_PROVISIONING_PROFILE_BASE64 < <(base64 -i watch-container.mobileprovision)`
- [ ] **watch 앱 provisioning profile** (App Store, `dev.tpmt.app.watch.watchkitapp`) →
      `gh secret set WATCHOS_APP_PROVISIONING_PROFILE_BASE64 < <(base64 -i watch-app.mobileprovision)`
- [ ] 인증서는 §1 의 `IOS_DIST_CERT_*` 재사용 (watchOS 전용 cert 타입 없음 — 추가 cert 시크릿 불필요).
- [ ] **검증**: `TP_PLATFORM=watchos TP_DEVELOPMENT_TEAM=<팀> scripts/ios.sh archive` 가 통과(두 profile
      보유 시) + archive 가 "Generic Xcode Archive" 가 아닌지(하니스가 자동 단언), `testflight.yml` 의
      watchOS job green.

> **알려진 리스크**: Xcode 26.x 에 watch archive `exportArchive -method app-store-connect` 를 거부하는
> 미해결 Apple 버그(FB23341311)가 보고됐다. iOS 컨테이너를 archive 하는 이 방식이 표준 우회책이지만, 그래도
> export 가 거부되면 `.xcarchive` 안의 `.app` 을 수동으로 `.ipa`(Payload/) 로 싸서 `altool` 직접 업로드한다
> (하니스의 classification 단언이 "Generic Xcode Archive" 케이스를 먼저 잡아준다).

---

## 참고

- 빌드 번호는 워크플로가 `run_number*100+run_attempt` 로 자동 부여 (ASC 재사용 거부 회피) — 수동 관리
  불필요.
- 모든 시크릿은 일회용 keychain 에 주입되고 `always()` 로 정리된다 — 러너 login keychain 안 건드림.
- 시크릿 하나라도 빠진 플랫폼의 job 은 `::notice::` 와 함께 skip — 다른 플랫폼/PR 에 영향 없음.
- 플랫폼 job 은 처음엔 전부 **non-required** (ci-workflows.md). main 에서 안정 green 확인 후 승격.
