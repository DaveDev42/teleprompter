---
paths:
  - ".github/**"
  - "release-please-config.json"
  - ".release-please-manifest.json"
  - "apps/app/app.json"
  - "apps/app/eas.json"
---

# Deployment Pipeline & Release

평상시는 `/release` 슬래시 커맨드가 전 과정을 자동화한다. 아래는 그 SoT.

## main push
| Target | Workflow | Condition |
|--------|----------|-----------|
| CI | GitHub Actions `ci.yml` | 항상 (parallel jobs: lint, type-check, test, build-cli, e2e) |
| Relay | GitHub Actions `deploy-relay.yml` | packages/relay,protocol,daemon 변경 시 |
| Web | Vercel (자동) | 항상 → `tpmt.dev` |
| EAS Gate | GitHub Actions `ci.yml` eas-gate job | All `ci.yml` jobs pass + apps/app,packages/protocol 변경 시 |
| iOS TestFlight | EAS Workflow `preview.yaml` via eas-gate | Fingerprint → 빌드/OTA → TestFlight 제출 |
| Android Internal | EAS Workflow `preview.yaml` via eas-gate | Fingerprint → 빌드/OTA → Internal track 제출 |

## v* 태그 release
| Target | Workflow | 설명 |
|--------|----------|------|
| tp 바이너리 | GitHub Actions `release.yml` | darwin-arm64 + linux × {arm64, x64} 빌드 → GitHub Release. `release.yml`은 `push: tags: [v*]` 와 `workflow_dispatch -f tag=...` 둘 다 받지만, GitHub API tag-creation 의 push event firing 이 누락되는 케이스가 잦아 (#172) **항상 manual dispatch 로 트리거** 한다. |
| Homebrew tap | GitHub Actions `release.yml` (tap bump step, `DaveDev42/homebrew-tap-release@v1` reusable action — PR #185) | `checksums.txt`에서 darwin sha256 추출 → `Formula/tp.rb` 렌더 → `davedev42/homebrew-tap` repo에 직접 push (PR 없음, commit subject = `tp <VERSION>`). `HOMEBREW_TAP_TOKEN` secret 미설정 또는 push 실패 시 `::warning::`로 swallow되어 release 자체는 성공으로 끝남 — 이 경우 `/release` 명령이 catch함. |
| iOS App Store | EAS Workflow `production.yaml` (수동) | Fingerprint → 빌드/OTA → 제출 |
| Android Play Store | EAS Workflow `production.yaml` (수동) | Fingerprint → 빌드/OTA → 제출 |

## 수동 dispatch only
| Workflow | 역할 |
|----------|------|
| `release-please.yml` (dispatch) | **두 가지 동작 중 하나** — main 상태에 따라 자동으로 결정: (a) release-able commit 이 쌓여 있으면 Release PR 생성/갱신, (b) 직전 dispatch 가 만든 PR 이 main 에 squash merge 되어 있으면 `vX.Y.Z` tag 을 push. 즉 한 번의 patch release 마다 dispatch 두 번 (PR 생성용 + tag push용) 이 필요하다. push trigger 는 일부러 제거 — main 의 모든 commit 마다 PR update 시도가 워크플로우를 잡아먹는 것을 회피. |
| `release.yml` (dispatch) | tag push event 가 누락된 케이스의 fallback (#172). `-f tag=vX.Y.Z` 로 기존 tag 을 재빌드. **현행 운영상 default 트리거 경로** — `release-please.yml` 두 번째 dispatch 가 tag 을 push 한 후 항상 이 dispatch 로 release.yml 을 깨운다. |
| `deploy-relay.yml` (dispatch) | 수동 relay 배포 |

## EAS 빌드 최적화
- **Fingerprint**: 네이티브 코드 해시로 기존 빌드 재사용 여부 판단
- **JS만 변경**: OTA 업데이트 발행 (~2분, 빌드 비용 $0)
- **네이티브 변경**: 풀빌드 + 스토어 제출
- **paths 필터**: `dorny/paths-filter`로 apps/app/, packages/protocol/ 변경 감지 → 변경 없으면 EAS skip
- **CI 게이트**: EAS Workflow는 git push로 자동 트리거되지 않음. CI eas-gate가 `eas workflow:run --ref` 로 트리거 (lint/test/type-check 통과 후)
- **EAS 게이트**: `ci.yml`의 모든 job (lint, type-check, test, build-cli, e2e) 전부 pass → `expo doctor` → `eas workflow:run .eas/workflows/preview.yaml --ref <sha> --non-interactive` (EXPO_TOKEN secret 필요)

## 릴리즈 절차 (수동)

```bash
# 1. 개발: main에 Conventional Commits로 push.
#    Web (Vercel), Relay (변경 시 `deploy-relay.yml`), EAS gate 등은
#    main push 트리거로 자동 진행.

# 2. Release PR 생성: release-please.yml dispatch (#1).
gh workflow run release-please.yml --ref main
# → "chore(main): release X.Y.Z" PR 생성. 이 PR 에는 main `ci.yml`
#   의 path filter 가 안 맞아 lint/test/build-cli/e2e 가 붙지 않는다 —
#   `gh pr view --json mergeable,mergeStateStatus` 로 MERGEABLE/CLEAN
#   여부만 확인하면 된다.

# 3. PR squash merge.
gh api repos/DaveDev42/teleprompter/pulls/<num>/merge -X PUT \
  -f merge_method=squash

# 4. tag push: release-please.yml dispatch (#2).
gh workflow run release-please.yml --ref main
# → main 의 release commit 을 인식해 vX.Y.Z tag 을 push.
#   (release-please.yml 은 workflow_dispatch only 이므로 자동 트리거 없음.
#    한 번의 dispatch 가 PR 생성 또는 tag push 중 하나만 하므로 두 번 필요.)

# 5. release.yml dispatch: 빌드 + GitHub Release + tap bump.
gh workflow run release.yml -f tag=vX.Y.Z
# → release.yml 은 `push: tags: [v*]` 트리거도 있지만 GitHub API
#   tag-creation 이 push event 를 항상 firing 하지는 않으므로 (#172)
#   manual dispatch 가 안전한 default.

# 6. tap repo + brew 검증 (SLA 보장 step):
gh api repos/DaveDev42/homebrew-tap/commits/main --jq '.commit.message'
brew update && brew upgrade davedev42/tap/tp && tp version
```

## Infrastructure
- **Relay**: Vultr Seoul `relay.tpmt.dev` (wss://, Caddy TLS + systemd: `tp-relay`)
- **Web**: Vercel → `tpmt.dev`
- **App**: EAS Build → TestFlight / Google Internal / App Store / Play Store
- **CLI**: GitHub Releases → `bun build --compile` (darwin/linux × arm64/x64; Windows users run the linux build under WSL)

## GitHub Secrets
| Secret | 용도 |
|--------|------|
| `RELAY_HOST` | Relay 서버 IP |
| `RELAY_USER` | Relay SSH 사용자 |
| `RELAY_SSH_KEY` | Relay SSH 키 |
| `HOMEBREW_TAP_TOKEN` | `davedev42/homebrew-tap`에 push할 PAT (fine-grained, Contents: R/W). 미설정 시 release.yml의 tap update step이 `::warning::HOMEBREW_TAP_TOKEN not set`로 swallow하고 통과. |

## EAS Credentials (Expo 서버 저장)
- iOS: Distribution Certificate + App Store Connect API Key (ascAppId: 6761056150)
- Android: Keystore + Google Play Service Account Key

# Version Management & OTA

- **NEVER bump versions** (package.json, app.json, manifest) unless the user explicitly requests it.
- Pre-1.0: only patch bumps (0.0.x). The first minor bump (0.1.0) is reserved for App Store public release.
- Release Please handles version bumps automatically via Conventional Commits — `bump-patch-for-minor-pre-major` is enabled so `feat:` commits stay patch-level while pre-1.0.
- Do not manually edit `version` fields in any package.json, app.json, or `.release-please-manifest.json`.

## OTA 정책 (fingerprint runtimeVersion)

`tp` CLI 바이너리는 release-please가 관리하는 `package.json`의 `version`을 따른다. Cloud preview/production 빌드는 `runtimeVersion: { "policy": "fingerprint" }` 정책을 사용해 **JS-only 변경은 OTA로 도달, 네이티브 변경(Podfile, 새 expo plugin, 네이티브 모듈 추가/업그레이드 등)만 풀빌드를 강제**한다. 로컬 development/device 빌드는 `app.config.js`가 `APP_VARIANT=dev-local` 환경변수를 감지해 `runtimeVersion`을 정적 문자열 `"dev-local"`로 오버라이드한다 — fingerprint 비교를 우회하므로 로컬 `.ipa` 빌드가 가능하다 (PR #560). CLI 버전과 앱 표시 버전이 분리되는 대신 OTA가 의미 있게 작동한다.

버전은 두 축으로 나뉜다:
- **사람 버전** (`expo.version`, `CFBundleShortVersionString`, `versionName`) — `apps/app/app.json`에 손으로 관리. release-please는 더 이상 이 값을 건드리지 않는다. App Store / Play 제출에 새 사람 버전이 필요할 때만 chore commit으로 bump한다.
- **빌드 카운터** (`ios.buildNumber`, `android.versionCode`) — EAS가 remote에 저장하고 `autoIncrement: true`로 빌드당 +1. Store의 단조증가 제약을 EAS가 책임진다. release-please는 이 값을 건드리지 않는다. iOS와 Android는 독립 카운터이므로 두 플랫폼 사이 숫자가 달라도 정상.
- **OTA runtimeVersion** — `@expo/fingerprint`가 네이티브 의존성/플러그인/Pods를 해시한 값. `app.json` 자체도 입력에 들어가지만 release-please가 더 이상 `app.json`을 자동 편집하지 않으므로 JS-only 변경 사이에서 안정적으로 유지된다.

### 설정

- `apps/app/app.json`: `"runtimeVersion": { "policy": "fingerprint" }` — JS-only 변경은 같은 fingerprint를 유지하므로 OTA로 도달. 네이티브 변경 시 fingerprint가 갈리며 자동으로 OTA 격리. **단, `development`/`device` 로컬 빌드는 예외**: `eas.json`의 해당 profile이 `APP_VARIANT=dev-local`을 주입하고, `apps/app/app.config.js`가 이 env var를 감지해 `runtimeVersion: "dev-local"` (정적 문자열)로 오버라이드한다 — fingerprint 비교를 우회하기 위함. Cloud `preview`/`production` 빌드는 `APP_VARIANT`를 설정하지 않으므로 fingerprint 정책이 그대로 적용된다.
- `apps/app/eas.json`: `"appVersionSource": "remote"` — 빌드 카운터를 EAS 서버에서 관리.
- `release-please-config.json`: `extra-files`에 `app.json` 항목을 두지 않는다. release-please는 `package.json`만 bump하고, `app.json`의 `expo.version`은 사람 버전이므로 별도 chore commit으로 손수 관리.
- `eas.json`의 store 제출용 profile (`preview`, `production`)에서 `"autoIncrement": true`가 `ios.buildNumber` / `android.versionCode`를 증분 (`development` profile은 해당 없음).

### 운영 규칙

- **JS / TS / 자산만 변경되는 PR**: release-please patch bump → CI 통과 → EAS Workflow가 새 OTA 발행 → 기존 TestFlight/Internal 설치본이 OTA로 받는다. 풀빌드 불필요.
- **네이티브 의존성 변경 PR** (`expo-*` 패키지 메이저/마이너 bump, plugin 추가/제거, `expo-build-properties` 변경, Podfile 영향): fingerprint가 갈리므로 EAS Workflow가 자동으로 풀빌드 + 새 TestFlight 빌드 발행. 사용자는 새 빌드를 받아야 OTA 채널이 다시 살아난다.
- **사람 버전 bump가 필요한 시점**: App Store / Play 제출 직전 marketing 버전을 올릴 때만 `apps/app/app.json`의 `expo.version`을 chore commit으로 직접 수정. 평상시 patch release에는 건드리지 않는다.

### 안티패턴

- `"appVersionSource": "local"` + `autoIncrement`: EAS가 빌드 시점에 `app.json`의 `buildNumber`/`versionCode`를 편집하지만 CI에서는 이 변경이 커밋되지 않는다. 결과적으로 다음 빌드가 낮은 카운터로 시작해 Store submit 단계에서 기존 카운터와 충돌해 거부된다. (PR #108 merge 직후 iOS `buildNumber 2`가 실제로 생성되었고 App Store Connect에는 이미 `44`가 존재. 해당 Expo workflow run은 submit 단계 이전에 `CANCELED` 상태로 종료(Android 빌드 포함)되어 Apple 측에는 도달하지 않음.)
- `"runtimeVersion": { "policy": "appVersion" }` + release-please가 `app.json` 편집: 매 patch release마다 runtimeVersion 문자열이 갈리고, 기존 TestFlight 설치본은 새 OTA를 받지 못한다 (격리). OTA 채널이 사실상 죽고, 매 릴리즈마다 새 TestFlight 빌드를 받아야 다음 OTA를 받을 수 있다. 0.1.16 → 0.1.19 사이에 실제로 OTA가 모두 격리됐다 (PR #176에서 fingerprint policy로 전환).
