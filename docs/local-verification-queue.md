# Local Verification Queue (네이티브 트랙 — 고성능 Mac 전용)

이 문서는 **이 8GB 개발 머신에서 구조적으로 돌릴 수 없는 검증 항목**의 단일 출처(SoT)다.
이 머신의 정책은 `CLAUDE.md` "iOS 빌드 & 검증 워크플로우" — 로컬 Simulator/Xcode/Maestro/네이티브
빌드를 띄우지 않는다 (RAM 천장: load 100+, heavy swap). 그래서 네이티브 트랙 **전체**를 더 사양
좋은 Mac(16GB+, 정식 OS, 신뢰된 실기기)으로 이관하고, 그 Mac의 별도 Claude Code 세션이 이 큐를
순회한다.

`/verify-native` 슬래시 커맨드가 이 문서를 읽어 순회한다 — **이 문서가 SoT, 커맨드는 얇은 래퍼**다.
항목을 추가/수정할 때는 이 문서만 고치면 커맨드가 자동으로 따라온다.

---

## 0. 고성능 Mac 1회 셋업 (큐 진입 전 게이트)

아래가 **모두** 충족되기 전에는 어떤 항목도 시작하지 않는다. 하나라도 빠지면 그 항목은 `blocked`로
남기고 사유를 기록한다.

| 게이트 | 확인 명령 | 통과 기준 |
|---|---|---|
| 머신 사양 | `sysctl hw.memsize` | ≥ 16 GB (8GB면 이 큐 전체 중단) |
| 정식 OS | `sw_vers` | Developer Beta 아님 (실기기 trust 깨짐 방지) |
| expo-mcp 활성화 | `.claude/settings.local.json` | `"expo-mcp@expo-mcp": true` (이 머신과 반대) |
| JDK 17–21 | `java -version` | Maestro 호환 (OpenJDK 26 ❌ — 반복 크래시) |
| Xcode + 시뮬레이터 런타임 | `xcrun simctl list runtimes` | iOS 런타임 1개 이상 설치 |
| eas-cli 인증 | `eas whoami` | 로그인됨 (`eas login` 1회) |
| Apple Team / bundleId | (레퍼런스) | Team `MU784AJZSW`, bundleId `dev.tpmt.app` |
| 실기기 trust | iPhone USB 연결 후 Xcode Devices | "Trusted" (pairing: unsupported ❌) |

### expo-mcp 켜기 (고성능 Mac에서만)

이 머신의 `.claude/settings.local.json`은 `"expo-mcp@expo-mcp": false`로 플러그인을 끈다.
고성능 Mac에서는 같은 파일(gitignored)을 만들어 `true`로 둔다:

```jsonc
// .claude/settings.local.json (고성능 Mac, gitignored)
{
  "enabledPlugins": { "expo-mcp@expo-mcp": true }
}
```

공유 `.claude/settings.json`은 `extraKnownMarketplaces.expo-mcp` +
`pluginConfigs.expo-mcp`(`app_dir: apps/app`)를 이미 들고 있으므로, 위 한 줄만 켜면
플러그인이 바로 동작한다. enable 플래그를 공유 파일에 두지 않는 이유가 이것 —
**머신마다 켜고 끄는 결정이 다르기 때문**.

---

## Dev build 획득 (사용자 확정: `eas build --local` + 실기기)

큐의 Simulator/실기기 항목은 **개발 빌드(.ipa/.app)**가 있어야 한다. Expo Go로는 불가능하다
(`expo-build-properties` newArch + config plugins(expo-camera/notifications/secure-store) +
reanimated 4.x + custom deploymentTarget 16.4 → Expo Go 호환성 깨짐). 빌드 방식은 확정:

```bash
# 고성능 Mac에서 (SSH 세션에서 실행해도 내부에서 Aqua GUI 세션으로 점프)
scripts/ios-dev-build.sh --profile device --output /tmp/teleprompter-dev.ipa
```

이 스크립트가 처리하는 함정(전부 검증됨, `misty-exploring-whisper.md` plan 기록):
WWDR **G3** 중간 인증서 자동 설치 / SSH(Background)→Aqua(GUI) 세션 재호출(`launchctl asuser`)
/ root 강등(CocoaPods) / root-owned `/tmp/eas-cli-nodejs` 자동 청소. **Credential은 절대 repo에
저장하지 않는다** — `eas build --local`이 빌드 시점에 EAS(SoT)에서 distribution cert +
provisioning profile을 다운로드한다.

> **이 스크립트는 고성능 Mac 전용.** 이 8GB 머신에서 실행 금지(`CLAUDE.md` 정책). 스크립트
> 헤더에도 동일 경고가 박혀 있다.

### `eas build --local` fingerprint 게이트 (해결됨 — PR #560)

`eas build --local`은 격리된 `npx eas-cli-local-build-plugin` 서브프로세스에서 돈다.
`runtimeVersion.policy = fingerprint`이면 부모(CLI)와 서브프로세스의 fingerprint가 서로 달라
"Configure expo-updates build phase"에서 중단됐다 (이전 Q1–Q4 BLOCKED 사유). **PR #560이
이를 해결:** `apps/app/app.config.js`(동적 config)가 `APP_VARIANT === "dev-local"`일 때
`runtimeVersion: "dev-local"`(정적 문자열)을 반환하고, `eas.json`의 `development`/`device`
프로파일에만 `env.APP_VARIANT = "dev-local"`을 박았다. **클라우드 프로파일(preview/production)은
그대로 `policy: fingerprint`** — OTA 무결성 유지. 검증: `APP_VARIANT=dev-local expo config --json`
→ `runtimeVersion: "dev-local"`, env 없이 → `runtimeVersion.policy: "fingerprint"`. 이로써
로컬 dev/simulator 빌드가 fingerprint 게이트 없이 진행된다.

설치:

```bash
xcrun devicectl device install app --device <udid> /tmp/teleprompter-dev.ipa
# 또는 Xcode > Devices and Simulators > 드래그 설치
```

dev server + HMR (실기기/시뮬레이터의 dev client가 Metro에 연결):

```bash
cd apps/app && npx expo start --dev-client   # 웹 디버그의 --web 과 다름
```

### APNs 검증 범위 (확정 사실)

- `eas build --local`이 `aps-environment` entitlement이 박힌 .ipa를 **생성**한다 (위 "iOS `eas
  build --local` — `.ipa` 로컬 빌드 성공" 참조 — 2026-06-06 64GB Mac에서 실측 성공, iPhone 설치 완료).
- **iOS Simulator는 진짜 APNs를 못 받는다** — `getExpoPushTokenAsync()`(`use-push-notifications.ts:25`)가
  Simulator에서 토큰을 안 준다. Simulator push는 `xcrun simctl push`로 payload/handler **로컬
  시뮬레이션**만 가능.
- 진짜 경로 `hook → push-notifier → relay → Expo Push → APNs → iPhone`의 끝단은 **실기기 + 빌드
  설치**가 있어야만 검증된다. 빌드 도구(`--local` vs EAS 클라우드)는 이 부분에 차이 없음.

### iOS `eas build --local` — `.ipa` 로컬 빌드 성공 (실측 2026-06-06, H2 확정)

**64GB Mac에서 `eas build --platform ios --profile device --local`은 `.ipa`를 정상적으로 굽는다.**
2026-06-06에 `/tmp/teleprompter-dev.ipa` (26M, signed, `dev.tpmt.app`)를 실제로 만들어 iPhone 15
Pro에 `xcrun devicectl device install`로 설치까지 완료했다. 이 머신(64GB)은 메모리 천장이 없어
RUN_FASTLANE/gym 네이티브 컴파일까지 완주한다.

**한때 이 큐는 `CALCULATE_EXPO_UPDATES_RUNTIME_VERSION` abort를 "구조적 차단(H1)"으로 기록했으나
그건 오진이었다.** 당시 로그는 이랬다:

```
... (PREBUILD → INSTALL_PODS, "118 total pods installed" 까지 정상 완료) ...
[ABORT] Received termination signal.
[CALCULATE_EXPO_UPDATES_RUNTIME_VERSION]
Error: CommandError: The expected package.json path:
  .../build/apps/app/package.json does not exist
```

**진짜 원인은 H2 — 외부 SIGTERM(빌드를 중간에 죽임)이다 (high confidence).** 진단 워크플로우
(`wfy1so1un`, 4-agent 교차검증) + 실측이 일치한다:
- `INSTALL_PODS`는 정상 **완료**했다 (로그 "Pod installation complete! ... 118 total pods
  installed"). `[ABORT] Received termination signal.`은 그 **후** 외부에서 도착한 SIGTERM이다.
- `[ABORT]`의 signal 핸들러(`@expo/build-tools` `exit.js` → `handleExit()`)가 working dir
  (`build/apps/app/` 포함)을 비동기로 teardown한다. 그 삭제가 빌드 파이프라인의 다음 phase
  (`CALCULATE_EXPO_UPDATES_RUNTIME_VERSION`)와 **동시에** 진행되면서, CALCULATE가 expo-updates
  CLI로 `build/apps/app/package.json`을 읽으려는 순간 이미 지워진 상태였다.
- **즉 package.json은 pod install이 지운 게 아니라 abort teardown이 지웠다.** repo 어디에도
  package.json을 옮기거나 지우는 H1 메커니즘은 없다 (`app.config.js`/`app.json`/pod 스크립트
  grep 0건). 그래서 POST_INSTALL hook으로 package.json을 복원하는 워크어라운드는 **불필요**하다 —
  존재하지 않는 H1을 고치는 처방이다.

**Android가 통과한 건 phase 순서 덕이지 abort 면역이 아니다.** Android builder는
`CALCULATE_EXPO_UPDATES_RUNTIME_VERSION`을 prebuild 직후 어떤 네이티브 스텝보다 먼저 실행해
`runtimeVersion="dev-local"`(정적 문자열, `app.config.js`의 `APP_VARIANT` override)로 즉시
short-circuit한다. iOS는 INSTALL_PODS 후에 이 phase가 와서 abort 창에 더 오래 노출될 뿐이다.

**재현/회피 절차 (16GB+ Mac이 `/verify-native`로 이 큐를 돌 때):**
- `scripts/ios-dev-build.sh --profile device --output /tmp/teleprompter-dev.ipa`를 **백그라운드로
  돌리고 절대 죽이지 말 것.** Ctrl-C / shell timeout / Activity Monitor kill / OOM(저메모리 Mac)
  중 하나라도 INSTALL_PODS~CALCULATE 창에 SIGTERM을 보내면 위 abort가 재현된다. 8GB Mac에서 과거
  abort가 "재현"된 건 메모리 압박으로 인한 OOM kill 또는 수동 중단이 H2를 유발한 것이다.
- 64GB Mac에서는 ~25-30분 완주하면 `.ipa`가 나온다. POST_INSTALL hook 같은 워크어라운드를 새로
  추가하지 말 것.

**doctor는 abort와 무관 (별개 이슈, cloud-safe).** 로컬 빌드는 `eas.json`의
`development`/`device` 프로파일 `env`에 `EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP: "1"`을 둬 doctor
phase를 건너뛴다 (`preview`/`production`은 `env` 없음 → cloud 미접촉). 한편 CI의 `eas-gate`는
`expo-doctor`를 hard-fail로 별도 실행하므로, 설치된 `expo@56.0.8`보다 앞선 패치(56.0.9-line)를
기대하는 doctor의 false-flag 9개는 `apps/app/package.json`의 `expo.install.exclude`로 suppress한다
(doctor-only, lockfile/resolution/cloud 빌드 미접촉 — react/react-dom와 동일 패턴). **SDK 전체
bump는 cloud-unsafe라 금지.**

---

## 큐 항목

각 항목 형식: **전제(prereq) / 정확한 명령(command) / 통과 기준(pass) / 결과 기록(result)**.
`result` 필드는 실행 후 `PASS YYYY-MM-DD (build #NN, 비고)` 또는 `FAIL — 사유` 또는 `BLOCKED — 게이트`로
채운다. 이 문서를 그대로 커밋해서 검증 이력을 남긴다.

---

### Q1. iOS 실기기 — push token 발급 + APNs E2E

- **prereq**: 0번 게이트 전부 + dev build .ipa 설치 + iPhone에서 알림 권한 Allow.
- **command**: `docs/PUSH-NOTIFICATION-TEST.md`의 Test 1–6 전체 (Permission/Elicitation push,
  foreground toast 억제, 멀티 디바이스, dedup, rate limit). 트리거 예:
  ```bash
  tp -p "read the contents of /etc/hosts"          # Test 1: permission push
  tp -p "ask me what language I prefer, then explain"  # Test 2: elicitation push
  ```
- **pass**: 잠금화면 push 도착 + 사운드 + 탭하면 올바른 세션으로 navigate. foreground에서는 system
  push 억제되고 in-app toast(5s auto-dismiss). dedup(60s 내 1건), rate limit(분당 ≤5).
- **result**: **BLOCKED 2026-06-06 — daemon push path 100% 검증됨, production relay가 stale
  바이너리라 `relay.push`를 거부 → 서버측 systemd 수정(SSH) 필요.** 빌드+설치+페어링+push token
  등록+E2EE 왕복은 전부 통과. 진짜 차단은 **앱이 아니라 production relay**다.

  **검증 경로 (synthetic injection):** iPhone 15 Pro를 production relay(`wss://relay.tpmt.dev`)로
  페어링하고 push token이 daemon에 등록됨을 확인(`[PushNotifier] registered push token`,
  E2EE `pushToken` frame 복호화 성공 → 디바이스 crypto 정상). Claude hook을 기다리지 않고
  `Notification` 이벤트 Record를 daemon IPC 소켓(`daemon.sock`, wire v2 = `u32 jsonLen | u32 binLen
  | json`)에 직접 주입해 **실제 production push path를 그대로** 구동했다. daemon측은 완벽:
  `[PushNotifier] notify-eligible event: name=Notification ... tokens=1` →
  `[PushNotifier] sending push notification ...`. 그런데 relay가 매번 거부:
  `[RelayClient] relay error: Unknown message type: relay.push` (token 수만큼 fan-out, 8×).

  **근본 원인 (확정):** production relay가 `relay.push` 지원(commit `fd027ad` / #513, 2026-06-03)
  **이전** 바이너리를 실행 중. 증거: 실행 중 relay가 내뱉는 에러 문자열 `"Unknown message type:"`은
  `fd027ad`에서 `"Unknown or malformed message type:"`로 바뀌었는데 옛 문자열이 나옴 → 바이너리가
  `fd027ad` 이전. `fd027ad` 이후 **deploy-relay.yml이 25회 전부 `success`**로 떴는데도 실행
  바이너리는 stale. 로컬에서 현재 main을 `bun build`하면 `relay.push` 핸들러 + 새 문자열이 분명히
  들어있음(`strings`로 확인) → **빌드는 정상, 실행 중 systemd 서비스가 새 `/usr/local/bin/tp`를
  안 집는다** (deploy는 `sudo mv … && systemctl restart tp-relay` 하지만 `tp-relay`의 ExecStart가
  다른 경로를 가리키는 것으로 추정 — restart는 됨, uptime이 매번 리셋되므로).

  **가시성 갭 수정 (#570, merged `f41c0d9`):** `/health`가 하드코딩 `version: "0.1.5"`만 노출해
  stale 바이너리를 fresh와 구분 못 했다. 이제 `bun build --define`으로 `buildSha`/`buildTime`를
  바이너리에 박고, deploy 후 `/health.buildSha == github.sha`를 검증한다 — 불일치 시 deploy를
  **시끄럽게 실패**시킨다. **검증 완료:** #570 머지가 트리거한 deploy run(`27059107888`)의 새 verify
  step이 곧바로 FAIL — restart 직후(`uptime: 3`) `/health`가 여전히 `"version": "0.1.5"`(옛 필드,
  `buildSha` 없음)를 반환 → 가드가 stale 바이너리를 정확히 잡아냄. 25회 green 뒤에 숨어있던 문제가
  이제 actionable CI 실패로 노출된다.

  **relay 수정 완료 (SSH 불필요 — deploy 워크플로우 키로 자가 진단·수정):** deploy-relay.yml에
  진단 step을 넣어 호스트를 직접 조사한 결과, 추정이 절반만 맞았다 — systemd unit이 드리프트돼
  `ExecStart=/usr/local/bin/**tp-relay**` (deploy가 갱신하는 `/usr/local/bin/**tp**`와 **다른 별개
  파일**)를 실행 중이었다. `/proc/<PID>/exe → /usr/local/bin/tp-relay` 로 확인. deploy는 매번 `tp`만
  fresh하게 유지(on-disk sha 일치 확인)하고 `tp-relay`는 한 번도 안 건드려서, 25회 success 동안
  서비스는 3일 묵은 `tp-relay`(= `relay.push` 이전)를 계속 돌렸다. **수정 (#572):** deploy가 매번
  표준 unit(`ExecStart=/usr/local/bin/tp relay start`, `scripts/deploy-relay.sh`와 동일)을 호스트에
  써넣고 `daemon-reload`+`enable`+`restart` → 호스트가 repo 정의로 수렴(self-heal, 재드리프트 방지).
  **검증 완료:** 수정 deploy(run `27059632309`) success → `/health`가 이제 `buildSha=c7b97db…`
  (배포 HEAD와 일치), `buildTime` 노출, 옛 `version: "0.1.5"` 필드 사라짐, `uptime` 리셋 → **서비스가
  fresh 바이너리를 실행 중**. `relay.push` 거부는 더 이상 없다.

  **남은 한 겹 (사용자 = 실기기):** relay는 고쳐졌으나, daemon을 `tp` 재설치로 재시작한 뒤로 iPhone
  앱이 재연결해 push token을 다시 등록하지 않아 현재 daemon `tokens=0` (token은 daemon 프로세스
  수명 동안만 메모리에 유지, 앱이 (재)연결 시 재전송). 따라서 synthetic injection을 다시 돌려도
  `notify-eligible event ... tokens=0`이라 relay까지 push가 안 나간다. **iPhone 앱을 열어 relay에
  재연결**(token 재등록)시킨 뒤 injection을 재실행하면 `relay.push`가 통과하고 실제 APNs push가
  폰에 도착하는지 확인 가능 → Q1 PASS. 이 마지막 한 겹만 Dave의 실기기 조작이 필요하다.

  (부수 성과: capture-hook.ts 셸 따옴표 버그 #569, /health buildSha 가드 #570, deploy unit 수렴
  #572 — 셋 다 이 진단 중 발견·수정.)

### Q2. iOS 실기기 — keychain / 백그라운드 사이클 / audio

- **prereq**: Q1과 동일 빌드.
- **command**: 페어링 키가 expo-secure-store(Keychain)에 저장·복원되는지(앱 재시작 후 페어링 유지),
  App Switcher background→foreground 왕복 시 relay 재연결 배너 정상, (VoiceButton 네이티브 구현 후)
  audio capture. 현재 `VoiceButton`은 네이티브에서 `null` 반환(TODO) — audio는 구현 전까지 `N/A`.
- **pass**: 앱 강제종료 후 재실행에도 페어링 살아있음. background 진입 후 복귀 시 reconnect.
- **result**: **PARTIAL 2026-06-06 — 빌드+설치 완료, 라이프사이클 거동은 사용자 디버깅 대기.**
  Q1과 동일하게 빌드 차단은 해소됐다: 같은 `.ipa`가 iPhone 15 Pro에 설치됐다 (위 "iOS `eas build
  --local` — `.ipa` 로컬 빌드 성공" — 과거 abort는 외부 SIGTERM/H2 오진). 남은 한 겹: keychain
  저장·복원 / background→foreground relay 재연결은 앱 강제종료·App Switcher 같은 **실기기
  라이프사이클 거동이라 신뢰된 실기기에서 사람이 조작해야 충실히 검증**된다 — **사용자(Dave) 실기기
  디버깅**으로 진행. (audio는 `VoiceButton` 네이티브 미구현이라 여전히 `N/A`.)

### Q3. Android 실기기 — 골든 패스 1회 + 권한 모델

- **prereq**: 0번 게이트 + Android dev build (`eas build --platform android --profile device --local`
  또는 EAS 클라우드 Internal track) 실기기 설치.
- **command**: 페어링(manual paste 또는 QR) → 세션 목록 → Chat 탭(메시지 송수신, Enter-to-send) →
  Terminal 탭(PTY 스트림/ANSI/키 입력) 풀 골든 패스 1회. 권한: network, foreground service 동작 확인.
- **pass**: 페어링·세션·Chat·Terminal 전부 동작. foreground service 알림 표시, network 권한 정상.
- **result**: **PASS 2026-06-05 (Pixel_8 AVD `emulator-5554`, dev-local APK, Maestro v2.2.0)** — 이 64GB
  Mac에서 Android 로컬 dev build를 끝까지 돌려 골든 패스(앱 부팅 → Sessions/Daemons/Settings 탭 왕복)를
  측정했다. 경로: `eas build --platform android --profile development --local --output …apk`
  (`APP_VARIANT=dev-local`, `JAVA_HOME`=openjdk@17, `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`,
  Gradle ~15min, APK 253M) → `adb install` → Metro를 `APP_VARIANT=dev-local`로 띄워(`runtimeVersion`이
  fingerprint hash 아닌 `dev-local`로 광고되어 APK와 일치) deep link
  (`exp+teleprompter://expo-development-client/?url=http://localhost:8082`, `adb reverse tcp:8082`)로 dev
  client 연결 → **`Android Bundled … (1924 modules)`** 번들 실행 → splash(`>_`) → Sessions 렌더. Maestro
  flow(`q3-tabs.yaml`) **전 단계 그린**: Sessions("No active sessions"+"Go to Daemons") ↔ Daemons
  ("No daemons connected" + "Scan QR Code to Pair" + "or enter pairing data manually") ↔ Settings 왕복
  navigate. (페어링 라이브 왕복·Chat/Terminal PTY 스트림은 daemon 페어링이 필요해 QA 범위 밖 — UI 도달성
  까지 확인. foreground service 알림 끝단은 EAS Internal track → 사용자 실기기로 이관.)
  - **버그 발견+수정 (PR #563):** 최초 dev-local APK는 부팅 시 **`DevLauncherErrorActivity` 크래시**
    (`NoClassDefFoundError: expo.modules.kotlin.types.AnyTypeProvider at DomWebViewModule.kt:84`)로 죽었다.
    원인: root `pnpm.overrides`의 `@expo/dom-webview` 핀이 SDK 55 시절(54991bb, iOS Swift 빌드 픽스)에
    `55.0.5`로 박힌 채, app이 Expo SDK 56(6708a4f)으로 올라갈 때 갱신되지 않았다. `55.x` Kotlin 네이티브
    모듈이 참조하는 `AnyTypeProvider`가 `expo-modules-core@56.0.14`에서 제거되어 클래스 로드 실패.
    `@expo/dom-webview`는 transitive(`@expo/log-box`의 LogBox `'use dom'` 오버레이만 로드, 앱은 직접
    `DomWebView`를 렌더하지 않음)라 **type-check·RN-Web e2e·iOS 빌드 어디에도 안 잡히고 Android 네이티브
    빌드에서만** 터졌다. **Fix**: override를 `56.0.5`(expo@56.0.8의 `~56.0.5` 해석값)로 올리고 lockfile
    재생성. **회귀 가드** (`apps/cli/src/manifest-guards.test.ts`): override의 SDK major를 `apps/app`의
    `expo` major에 묶어 향후 SDK bump 시 override가 뒤처지면 즉시 실패. 가드는 override를 `55.0.5`로 되돌리면
    실패함을 확인. 56.0.5로 재빌드한 APK는 위 골든 패스 전부 통과.
  - **iOS 재검증 큐:** dom-webview `56.0.5`가 iOS 네이티브 빌드에서도 컴파일되고 LogBox `'use dom'` 오버레이가
    정상 렌더되는지는 별도 iOS EAS/native 체크로 확인 필요(이번 순회는 Android만). 56.0.5는 SDK 56이 기대하는
    버전이라 회귀 가능성은 낮으나 끝단 미검증.

### Q4. Simulator QA — UI/로직 회귀 (Expo MCP + Maestro)

- **prereq**: 0번 게이트 + **dev build .app**을 Simulator에 설치(Expo Go 아님:
  `eas build --profile development --platform ios --local`로 simulator용 .app 빌드 후
  `xcrun simctl install booted <path.app>`). `development` profile = `simulator: true`. expo-mcp 활성화.
- **command**: Expo MCP 플러그인(`expo-mcp:qa` agent) + Maestro flow로 페어링/세션/Chat/Terminal
  탐색적 QA. push는 여기서 `xcrun simctl push <device> dev.tpmt.app payload.apns`로 payload 렌더/탭
  navigation handler만 확인(진짜 APNs 왕복은 Q1 실기기에서).
- **pass**: Maestro flow 그린, 주요 화면 스냅샷 회귀 없음. simctl push로 notification handler 동작.
- **result**: **PASS 2026-06-05 (build 0.1.19 dev-local, iOS 26.5 Simulator)** — 이 64GB Mac에서
  Simulator dev build `.app` 생성·설치·실행·탐색 전부 성공. 경로: PR #560의 `dev-local` profile로
  fingerprint 게이트 통과 → `eas build --profile development --platform ios --local` → `.app`을
  `QA-iPhone-265`(iOS 26.5)에 `xcrun simctl install` → deep link(`exp+teleprompter://...`)로 dev
  client를 Metro(:8082)에 연결. Maestro v2.2.0(`JAVA_HOME`=openjdk@17) flow로 골든 패스 구동:
  앱 렌더 OK, **Sessions↔Daemons↔Settings 탭 왕복 navigate 그린**(`assertVisible "Sessions"` 통과),
  Daemons 탭에 페어링 진입점("Scan QR Code to Pair" + "or enter pairing data manually") 도달, Settings
  탭 Version `0.1.19` / Updates "Dev build" / Diagnostics 표시 확인. (페어링 라이브 왕복은 QA 범위 밖 —
  UI 도달성까지 확인.)
  - **버그 발견+수정 (PR #561):** 최초 빌드는 **red-screen "Incompatible React versions"** 로 죽었다.
    원인 = 루트 `pnpm.overrides`가 `react@19.2.6`을 강제했으나 `react-native@0.85.3`의 번들 renderer는
    `19.2.3`에 대해 빌드됨 — React는 `react`와 `react-native-renderer` 간 **정확한 버전 일치**를 요구
    하므로 patch 불일치(19.2.6 vs 19.2.3)에서 red-screen. type-check와 RN-Web e2e로는 안 잡힘(네이티브
    renderer에서만 발현). **수정:** 세 곳(루트 override + `apps/app` + `apps/cli`)의 react 핀을 모두
    `19.2.3`으로 정렬 + `apps/cli/src/manifest-guards.test.ts`에 회귀 가드("override.react ===
    app.react") 추가 — override가 다시 app의 react에서 드리프트하면 CI가 잡는다. 이 핀은 SDK 56의
    `bundledNativeModules`/renderer가 기대하는 버전이라 클라우드 빌드에도 동일하게 옳다.
    수정 후 `--clear` 재빌드에서 red-screen 사라지고 위 골든 패스 그린.

### Q5. Linux daemon install — systemd 풀 사이클 (VM)

- **prereq**: Lima/Ubuntu(또는 Debian) VM. 이 항목은 머신 사양과 무관 — 어느 Mac이든 가능하지만 이
  큐에 같이 둔다(고성능 Mac에서 한 번에 처리).
- **command**:
  ```bash
  # VM 안에서 Linux tp 바이너리 설치 후
  tp daemon install            # systemd --user unit 생성/등록/start
  systemctl --user status tp-daemon
  # VM 재부팅 후
  systemctl --user status tp-daemon   # 자동 기동 확인
  ```
  코드 레퍼런스: `apps/cli/src/lib/service-linux.ts` (getUnitDir, `systemctl --user daemon-reload`).
- **pass**: install 후 active(running), 재부팅 후 자동 기동, `tp status`로 페어링/세션 동작.
- **result**: **PASS 2026-06-05** (Lima Ubuntu 24.04 VM, aarch64, systemd 255, `tp-linux_arm64`
  v0.1.46). `tp daemon install` → unit `~/.config/systemd/user/teleprompter-daemon.service`
  생성, `active (running)` + `enabled` (PID 2863, IPC `/run/user/501/daemon.sock` 리스닝). VM
  reboot 후 **수동 start 없이 자동 기동** (새 PID 813, `up 0 minutes`) — Lima guest user는
  `Linger=yes` 기본값이라 headless reboot 에도 user manager 가 떠 `WantedBy=default.target` 가
  발동. `tp status` → "Background daemon: running, Sessions: 0" 정상. `tp daemon uninstall` →
  inactive + unit file removed (대칭성 확인). claude CLI 미설치라 세션 spawn 은 범위 밖 (install/
  systemd 라이프사이클 검증이 이 항목의 목적).

### Q6. Long-running 안정성 — 1시간 soak

- **prereq**: 페어링된 daemon + app(실기기 또는 web). 자동 측정 스크립트 = `scripts/soak.ts`
  (in-process RelayServer + 실 daemon pid RSS 샘플링; `bun run scripts/soak.ts`, 플래그
  `--minutes`/`--round-interval`/`--reconnects`/`--frames`/`--idle-cycles`/`--idle-hold`/`--json`,
  hard failure 시 exit 1).
- **command**: 1시간 동안 daemon RSS 추이 샘플링, relay reconnect 100회, frame round-trip 100회
  latency, WS idle/wake 사이클 5회.
- **pass**: RSS 단조증가(누수) 없음, reconnect 전부 복구, latency p95 안정, idle/wake 후 정상.
- **result**: **PASS 2026-06-03** (이 8GB 개발 머신, `scripts/soak.ts`, 실 daemon pid 89218 추적) —
  머신 사양 무관 항목이라 이 머신에서 이미 실측 완료. 61 라운드 × {reconnect 100, rtt 100}:
  reconnect **6100/6100** (connect p95 ≤0.94ms), frame round-trip **6100/6100** (rtt p95 ≤2.38ms),
  RSS 37.0→30.6MB 범위 29.7~37.0MB (**상승 추세 없음 = 누수 없음**), idle/wake **5/5**
  (95s hold > relay 90s idle, daemon ping이 idle close 차단 실증), relay drop 카운터
  (rate/daemon/backpressure/oversized/authTimeout/eviction) **전부 0**, hard failures **0**.
  → **고성능 Mac은 Q6 건너뜀** (중복 불필요).

### Q7. Windows under WSL — install.sh 풀 사이클

- **prereq**: Windows 머신 + WSL2(Ubuntu/Debian). **고성능 Mac으로는 불가** — 별도 Windows 환경
  필요. 이 큐에는 "별도 환경" 표식으로 남긴다.
- **command**: WSL 안에서 `install.sh` → `tp daemon` → 페어링 → 세션 풀 사이클.
- **pass**: Linux 빌드가 WSL에서 install·daemon·페어링·세션 전부 동작.
- **result**: **PASS 2026-06-05 (bug found+fixed, PR #559)** — Windows 11 + WSL2(Ubuntu)에서 install.sh
  → `tp daemon` → 페어링 → 세션 풀 사이클 실행. **버그 발견+수정:** systemd `--user` daemon은
  `XDG_RUNTIME_DIR=/run/user/<uid>`를 받지만, 대화형 WSL 로그인 셸에서는 이 변수가 **UNSET** → CLI가
  `/tmp/teleprompter-<uid>`로 폴백 → daemon과 CLI의 소켓/락 경로가 갈려 **중복 daemon + SQLITE_BUSY**.
  **수정(PR #559):** `packages/protocol/src/socket-path.ts`에 `resolveRuntimeDir()` 공유 리졸버를 두고
  순서를 XDG → `/run/user/<uid>`(존재 시) → `/tmp` 폴백으로 통일. daemon-lock도 같은 리졸버를 쓰게 해
  소켓과 pid-lock이 항상 같은 디렉터리에 co-locate. 회귀 가드: `socket-path.test.ts`에 "systemd
  /run/user preference" describe + XDG honor 테스트, `daemon-lock.test.ts`는 writable temp dir로 정정.
  수정 후 WSL에서 단일 daemon, SQLITE_BUSY 소멸, 페어링·세션 정상. (이 항목은 별도 Windows/WSL 환경에서
  실행 — 고성능 Mac 범위 밖이지만 이번에 그 환경에서 처리 완료.)

### Q8. libsodium wasm2js init-noise — 네이티브 Hermes 콘솔 확인

- **prereq**: 임의의 dev build 실기기/Simulator 설치 (Q1–Q4 중 아무 빌드든 재활용 — 앱이 부팅해서
  libsodium을 한 번이라도 init하면 충분). Metro/Xcode 콘솔(또는 `idevicesyslog`/Console.app) 접근.
- **command**: 앱을 콜드 스타트해 첫 crypto 연산(페어링 또는 세션 진입 — `ensureSodium()` 경유)을
  트리거하고, 네이티브 콘솔 로그를 관찰한다. RN Web/Bun/Node는 네이티브 WebAssembly가 있어 조용히
  init되므로 이 증상이 안 나온다 — **반드시 네이티브 Hermes에서만 검증 가능** (그래서 큐 항목).
- **pass**: libsodium init 시 다음 두 emscripten 노이즈 라인이 **더 이상 나타나지 않는다**:
  `failed to asynchronously prepare wasm: ...` / `Aborted(...). Build with -sASSERTIONS for more info.`
  (genuine app error/warning은 그대로 통과해야 한다 — 콘솔이 통째로 묵음이 되면 안 됨).
- **result**: **NEEDS-DEVICE (PR #577, merged `f3c654c`)** — 유닛으로는 증명됨
  (`crypto-polyfill-binding.test.ts`가 폴리필이 libsodium require **전에** `console.error`/`.warn`을
  래핑해 두 노이즈 라인은 drop, 진짜 에러는 downstream으로 forward함을 end-to-end로 검증), 그러나
  **끝단(네이티브 Hermes 콘솔에서 라인이 실제로 사라졌는지)은 실기기/Simulator에서만 확인 가능**.
  배경: 직전 시도(PR #573)는 (a) libsodium이 module-eval 시점에 `console.error.bind(console)`로
  에러 sink를 **한 번** 바인딩해서 *나중에* `console.error`를 재할당해도 무효였고, (b) libsodium.js가
  module-local `WebAssembly` 심을 자체 정의해 `globalThis.WebAssembly` 폴리필이 로깅 코드에 도달하지
  못해 실패했다. #577은 노이즈를 **소스(바인딩 시점)**에서 필터링하고 libsodium require 전에 설치하는
  것으로 두 원인을 모두 제거했다 — on-device 확인만 남았다.

---

## 실행 규약 (커맨드가 따르는 규칙)

1. **0번 게이트를 먼저 통과**시키지 못하면 어떤 Q도 시작하지 않는다.
2. 각 Q를 **독립적으로** 실행 — 하나 실패가 나머지를 막지 않는다(Q7 BLOCKED는 정상).
3. 실행 후 해당 Q의 `result` 필드를 **이 문서에 직접 기록**하고 커밋한다(`docs:` prefix).
4. 빌드 산출물(.ipa/.app)은 repo에 커밋하지 않는다. credential도 절대 커밋하지 않는다.
5. 실기기 거동에서 버그 발견 시: 재현 가능한 fix 브랜치 + (가능하면) 회귀 가드. RN Web에서 재현
   가능한 회귀면 `e2e/app-*.spec.ts`도 동봉(`CLAUDE.md` "디버그 중 발견한 UI 버그 처리").
