---
paths:
  - "apps/app/ios/**"
  - "apps/app/app.json"
  - "apps/app/eas.json"
  - "scripts/ios-dev-build.sh"
---

# iOS 빌드 & 검증 워크플로우

**기본 워크플로우는 EAS 클라우드 빌드 + RN Web 검증이다. 로컬 iOS 빌드/Simulator/Maestro 는 옵션으로 가능하다.** 일상 개발에서 네이티브 iOS 빌드/배포는 **EAS 클라우드**가, UI/로직 검증은 **RN Web**이 담당한다 — 이게 회귀 표면이 작고 빠르기 때문이다 (정책 선호이지 하드웨어 제약이 아니다). 단 **필요할 때는 이 머신(64GB M1 Max)에서 로컬 dev build 와 Simulator/Maestro QA 를 직접 돌린다.** 2026-06-06 에 `scripts/ios-dev-build.sh` 로 device `.ipa` 를 로컬 빌드해 iPhone 15 Pro 에 설치·실행까지 실증했다 (아래 "로컬 iOS 빌드 — 가능하다").

(과거 이 문서는 "8GB Mac 메모리 천장 → 로컬 iOS 전부 불가/재시도 금지"를 전제로 했으나, 머신이 64GB M1 Max 로 바뀌면서 그 전제는 사라졌다. 메모리 천장 기반 금지 문구는 모두 폐기됐다.)

## 표준 절차

1. **일상 검증 = RN Web (기본값).** UI/로직 변경은 RN Web dogfood (`pnpm dev:app` + `pnpm dev:pair`, `.claude/rules/dogfooding.md`)로 검증한다. PR #481 류의 화면 변경(daemon 카드, 모달, 페어링 라벨 등)은 RN Web 에 동일하게 적용되므로 브라우저에서 확인할 수 있다. 네이티브 전용 동작(소프트 키보드 회피, push 배너 등)은 RN Web 근사 + 아래의 Simulator/실기기 경로로 확인한다.
2. **빌드/배포 = EAS 클라우드 + TestFlight (기본값).** main push → `ci.yml` eas-gate → `preview.yaml` 가 fingerprint 기반으로 OTA(JS-only) 또는 풀빌드(네이티브 변경)를 TestFlight/Internal 에 발행한다 (`.claude/rules/release-deploy.md`). 평상시 store 빌드는 클라우드가 굽는다.
3. **로컬 dev build (옵션).** 실기기/Simulator 에서 네이티브 거동을 직접 검증해야 하면 이 64GB 머신에서 `scripts/ios-dev-build.sh --profile device` 로 `.ipa` 를 굽고 `xcrun devicectl device install` 로 실기기에 설치한다 (Simulator 는 `eas build --profile development --platform ios --local`). 빌드는 **백그라운드로 돌리고 절대 죽이지 말 것** — 중간에 SIGTERM(Ctrl-C/timeout/kill)이 들어가면 CALCULATE phase abort 를 유발한다 (아래 H2 설명). **실기기 런치는 딥링크로**: 신규 설치 후 plain launch 는 dev client launcher 홈에서 멈춘다 (Metro 자동 연결 안 됨) — `xcrun devicectl device process launch --terminate-existing --device <UDID> --payload-url "tp://expo-development-client/?url=http%3A%2F%2F<mac-ip>%3A8081" dev.tpmt.app` 으로 런치하면 launcher 를 건너뛰고 즉시 Metro 에 붙는다 (scheme = app.json 의 `tp`; 폰 잠금 시 FBSOpenApplicationErrorDomain error 7 → 잠금 해제 후 재시도).
4. **Simulator/Maestro QA (필요 시 — `/verify-native` 큐 항목에 한함).** `expo-mcp` 는 이 머신의 `.claude/settings.local.json` 에서 `true` 로 켜져 있지만, `expo-mcp:qa` agent + Maestro flow 는 **일상 작업에서는 띄우지 않는다** (JDK/Maestro 부수 비용 — CLAUDE.md "Subagent Dispatch" 와 동일 정책). 일상 회귀는 RN Web (`app-web-qa`) 이 담당하고, Simulator/Maestro 는 `docs/local-verification-queue.md` 의 네이티브 검증 항목을 `/verify-native` 로 순회할 때만 쓴다.
5. **실기기 라이프사이클 거동 = 사용자 디버깅.** 진짜 APNs 왕복, 잠금화면 push 탭, App Switcher background↔foreground, 강제종료 후 keychain 유지 같은 **사람이 폰을 들고 조작해야 하는** 검증은 빌드/설치까지 자동화한 뒤 **사용자(Dave) 실기기 디버깅**으로 넘긴다.
6. **네이티브 검증 큐.** 네이티브 트랙 검증 항목(iOS/Android 실기기, Simulator QA, Linux daemon VM, 1h soak, WSL)은 **`docs/local-verification-queue.md`** 큐(SoT)에 정의돼 있고 **`/verify-native`** 커맨드로 순회한다. 이 64GB 머신에서 실행 가능 (Q3 Android·Q4 Simulator·Q5·Q6 PASS 실적). expo-mcp 활성화는 **머신별** — 공유 `settings.json`은 enable 플래그를 들지 않고 각 머신의 gitignored `settings.local.json`이 결정한다 (이 머신 = `true`).

## Credentials = EAS single source of truth (변경 없음)

서명 자격은 repo 에 절대 저장하지 않는다. EAS 서버가 distribution cert + provisioning profile 의 SoT 이고, 클라우드 빌드든 `eas build --local` 이든 빌드 시점에 EAS 에서 다운로드해 쓴다 (로컬 빌드도 repo 에 자격을 저장하지 않는다). `eas.json` 에 `credentialsSource` 를 명시하지 않는다 (`remote` 가 기본값). iOS push 용 profile 에 `aps-environment` capability 가 필요하면 `eas credentials -p ios` (대화형) 또는 ASC API key 로 EAS 측에서 갱신한다.

## 로컬 iOS 빌드 — 가능하다 (2026-06-06 실증)

**이 64GB M1 Max 머신에서 `eas build --platform ios --profile device --local` 은 `.ipa` 를 정상적으로 굽는다.** 2026-06-06 에 `/tmp/teleprompter-dev.ipa` (26M, signed, `dev.tpmt.app`)를 로컬 빌드해 iPhone 15 Pro 에 `xcrun devicectl device install` 로 설치하고 앱 실행(UI 로드)까지 확인했다. 과거 이 섹션은 "8GB RAM 하드웨어 천장 → 로컬 iOS 불가/재시도 금지"라고 적었으나, 그 전제는 머신이 64GB 로 바뀌며 사라졌다.

**과거의 `CALCULATE_EXPO_UPDATES_RUNTIME_VERSION` abort 는 구조적 차단이 아니라 H2(외부 SIGTERM) 오진이었다.** `INSTALL_PODS` 는 정상 완료("118 total pods installed")했고, `[ABORT] Received termination signal.` 은 그 후 외부에서 들어온 SIGTERM 이다. abort teardown 핸들러가 working dir(`build/apps/app/`)를 비동기로 지우면서 다음 phase(CALCULATE)가 읽으려던 `package.json` 을 먼저 삭제했을 뿐이다 — pod install 이 지운 게 아니다 (repo 에 package.json 을 옮기거나 지우는 H1 메커니즘 없음, grep 0건; 4-agent 진단 워크플로우로 교차검증). **해법은 빌드를 죽이지 않고 끝까지 돌리는 것뿐이다.** POST_INSTALL package.json 복원 훅은 불필요하다 (없는 H1 을 고치는 처방).

**로컬 빌드 실행 시 주의:**
- **백그라운드로 돌리고 SIGTERM 을 보내지 말 것** — Ctrl-C / shell timeout / Activity Monitor kill / 저메모리 Mac 의 OOM kill 중 하나라도 INSTALL_PODS~CALCULATE 창에 들어오면 위 abort 가 재현된다. (8GB 머신에서 과거 abort 가 "재현"된 건 메모리 압박 OOM kill 또는 수동 중단이 H2 를 유발한 것이다.)
- 64GB Mac 에서는 ~25-30분 완주하면 `.ipa` 가 나온다. `ios-dev-build.sh` 가 부수 전제(WWDR G3 설치, Aqua GUI 세션 re-exec, root 강등, root-owned tmp 청소)를 처리한다.
- doctor 는 abort 와 무관하다. 로컬 빌드는 `eas.json` 의 `development`/`device` 프로파일 `env` 에 `EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP: "1"` 을 둬 doctor phase 를 건너뛴다 (`preview`/`production` 은 `env` 없음 → cloud 미접촉). CI 의 `eas-gate` doctor false-flag 는 `apps/app/package.json` 의 `expo.install.exclude` 로 suppress 한다 (PR #566, doctor-only/cloud-safe).

**기본은 여전히 EAS 클라우드 + RN Web.** 로컬 빌드가 가능해졌다고 매번 로컬로 굽는다는 뜻은 아니다 — store 빌드/OTA 는 클라우드가, 일상 UI 검증은 RN Web 이 맡고, 로컬 dev build 는 **실기기/Simulator 네이티브 거동을 직접 확인해야 할 때 쓰는 옵션**이다. (16GB+ / 정식 OS / 신뢰된 기기 조합에서만 로컬 경로가 안정적이다 — 저사양/Beta OS Mac 이라면 EAS 클라우드 경로를 그대로 쓴다.)

# Native Build (Expo Go 드롭 완료 — development build 전용)

**Expo Go 는 지원하지 않는다 (2026-06-11 공식화 — 이전부터 사실상 드롭 상태였다).** 근거:
`expo-dev-client` 가 상시 의존성 (`apps/app/package.json`), `eas.json` development/device
프로파일 `developmentClient: true`, reanimated 4.x + custom deploymentTarget 16.4 로 Expo Go
호환성 자체가 깨져 있음 (`docs/local-verification-queue.md` "Dev build 획득" 참조), 네이티브
검증 큐 항목 (Q1–Q4, Q8–Q10) 전부 dev build (`dev.tpmt.app` dev-client) 로 수행됨. 소스에
Expo Go 분기 (`Constants.appOwnership` / `executionEnvironment` 체크) 는 없다 — **새로 추가하지
말 것.** `expo start` 는 expo-dev-client 감지로 dev-client 모드가 기본값이다.

네이티브 모듈 추가 제약 해제됨 — JSI/커스텀 네이티브 모듈 자유롭게 도입 가능. 단 네이티브
변경은 fingerprint runtimeVersion 을 바꿔 OTA 대신 풀빌드를 유발한다 (`.claude/rules/release-deploy.md`):
- ✓ libsodium-wrappers (WASM on Web/Bun, asm.js fallback on Hermes)
- ✓ expo-crypto (Expo SDK 내장 — `getRandomValues` polyfill 제공)
- ✓ ghostty-web (libghostty WASM — Canvas 2D 터미널 렌더링)
- 🔓 react-native-quick-crypto (JSI) — unblocked. 도입 시 Hermes asm.js init-noise (큐 Q8/Q9) 해소 후보
- 🔓 libghostty 네이티브 RN 모듈 (iOS Metal / Android OpenGL GPU 렌더링) — unblocked (TODO.md Future 트랙)
- 🔓 Apple Watch 컴패니언 (watchOS 타겟) — unblocked (TODO.md Future 트랙)
