# Local Verification Queue (네이티브 트랙)

이 문서는 **네이티브 트랙 검증 항목**(iOS/Android 실기기, Simulator QA, soak, WSL 등 —
RN Web 으로 검증할 수 없는 항목)의 단일 출처(SoT)다. 이 64GB M1 Max 개발 머신에서 직접
실행 가능하다 (`.claude/rules/native-build.md` 참조 — 과거의 "8GB 머신 → 16GB+ Mac 이관"
전제는 머신 교체로 폐기됨). 일상 검증은 여전히 RN Web 이 기본값이고, 이 큐는 네이티브
거동을 명시적으로 확인해야 할 때만 순회한다.

`/verify-native` 슬래시 커맨드가 이 문서를 읽어 순회한다 — **이 문서가 SoT, 커맨드는 얇은 래퍼**다.
항목을 추가/수정할 때는 이 문서만 고치면 커맨드가 자동으로 따라온다.

---

## 0. 고성능 Mac 1회 셋업 (큐 진입 전 게이트)

아래가 **모두** 충족되기 전에는 어떤 항목도 시작하지 않는다. 하나라도 빠지면 그 항목은 `blocked`로
남기고 사유를 기록한다.

| 게이트 | 확인 명령 | 통과 기준 |
|---|---|---|
| 머신 사양 | `sysctl hw.memsize` | ≥ 16 GB (이 머신 = 64GB M1 Max) |
| 정식 OS | `sw_vers` | Developer Beta 아님 (실기기 trust 깨짐 방지) |
| expo-mcp 활성화 | `.claude/settings.local.json` | `"expo-mcp@expo-mcp": true` |
| JDK 17–21 | `java -version` | Maestro 호환 (OpenJDK 26 ❌ — 반복 크래시) |
| Xcode + 시뮬레이터 런타임 | `xcrun simctl list runtimes` | iOS 런타임 1개 이상 설치 |
| eas-cli 인증 | `eas whoami` | 로그인됨 (`eas login` 1회) |
| Apple Team / bundleId | (레퍼런스) | Team `MU784AJZSW`, bundleId `dev.tpmt.app` |
| 실기기 trust | iPhone USB 연결 후 Xcode Devices | "Trusted" (pairing: unsupported ❌) |

### expo-mcp 켜기 (머신별 결정)

이 머신의 `.claude/settings.local.json`(gitignored)은 `"expo-mcp@expo-mcp": true`로
플러그인을 켠다. 새 머신을 셋업할 때는 같은 파일을 만들어 켜고 끈다:

```jsonc
// .claude/settings.local.json (gitignored, 머신별)
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

> **로컬 빌드는 백그라운드로 돌리고 절대 죽이지 말 것** — 중간 SIGTERM 이 CALCULATE phase
> abort 를 유발한다 (`.claude/rules/native-build.md` H2 설명).

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
- **result**: **PASS 2026-06-07 (build #59, sealed Path X #579 `33b8375` — end-to-end APNs 실기기 도착 확인).**
  iPhone 15 Pro(`FFB34007-…`)에 #579 sealed-token dev build(`dev.tpmt.app` v0.1.19 **build 59**,
  `/tmp/teleprompter-dev-579.ipa`)를 `xcrun devicectl device install`로 설치 → 앱을 열어 relay 재연결 →
  daemon 로그에 **`[PushNotifier] registered sealed push token for frontend 24f0d6fc… (ios)`** 확인
  (Path X: 앱이 cleartext `relay.push.register` → relay가 `tpps1.` blob으로 seal → daemon은 sealed만
  보관, plaintext 0 접촉). `Notification` Record를 `daemon.sock`(wire v2)에 주입해 production push path를
  구동: daemon `notify-eligible event ... tokens=1` → `sending push notification ... level=time-sensitive`
  (sealed blob 발신, 더 이상 plaintext `token` 아님). relay는 `relay.push`를 수락·unseal·Expo Push 호출
  **에러 0건** (`Unknown message type` / `PUSH_UNSEAL_FAILED` 없음, `/health` `unknownTypeDrops=0`,
  buildSha `33b8375`). **Dave 실기기 육안 확인: 잠금화면 push 도착 + 사운드 + (time-sensitive) — Q1 통과.**
  이로써 진짜 경로 `hook→push-notifier→relay→unseal→Expo Push→APNs→iPhone`의 끝단이 sealed Path X로
  실증됐다.

  ---

  **History — 2026-06-06 BLOCKED (stale production relay, 이후 #572로 해소):** daemon push path 100%
  검증됐으나 production relay가 stale 바이너리라 `relay.push`를 거부했었다. 빌드+설치+페어링+push token
  등록+E2EE 왕복은 전부 통과. 진짜 차단은 **앱이 아니라 production relay**였다.

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

  **재순회 2026-06-07 (`/verify-native Q1`, still BLOCKED — 동일 한 겹):** 머신 게이트 Q1 부분집합
  재확인 — 64GB RAM, `eas whoami` = davedev42, iPhone 15 Pro `available (paired)`
  (`FFB34007-…`), dev `.ipa` 잔존(`/tmp/teleprompter-dev.ipa`, 26M), 앱 설치됨
  (`dev.tpmt.app` v0.1.19 build 58). **JDK 26 은 Q1 게이트가 아님** (Maestro/Android 전용 —
  Q1 은 iOS 실기기 push). relay-side 차단(`Unknown message type: relay.push`)은 #572 이후 해소
  상태 그대로다 (로그의 그 에러 라인들은 전부 2026-06-06 stale-relay 시절의 과거 기록). daemon 은
  이제 **sealed push token (Path X, #579 merged `33b8375`) 바이너리**로 02:11 재시작됨 — Path X 는
  back-compat 라 구버전 production relay 에는 plaintext `token` 으로 폴백(비-`tpps1.` blob),
  고쳐진 relay 가 그대로 수락한다. `devicectl device process launch dev.tpmt.app` 로 폰에서 앱을
  **원격 콜드 런치**까지 성공했으나(Metro `:8082` `--dev-client` 떠 있음), 35s 대기 후에도 새
  daemon 로그에 `[PushNotifier] registered push token` 이 안 찍힘 — dev-client 콜드 런치만으로는
  relay connect → kx → 알림권한 → token 재등록 플로우가 완주되지 않음(사람 조작 없이는 launcher
  단계에 머묾). **즉 차단은 변함없이 "Dave 가 폰에서 앱을 직접 열어 token 재등록 + 잠금화면 push
  도착/사운드/탭-navigate 를 눈으로 확인"** 이라는 물리·인간 단계다 — 이 세션에서 화면·사운드·탭은
  검증 불가. 추가로 폰의 앱(build 58)은 Path X 이전 빌드라 새 `relay.push.register` 이중 전송을
  안 함 — sealed 경로 end-to-end 까지 보려면 #579 이후 dev build 재설치가 필요(back-compat plaintext
  경로는 build 58 로도 검증 가능).

  **재순회 2026-06-07 (2차, `/verify-native Q1` — PASS, 한 겹 해소):** 위 "남은 한 겹"을 닫았다.
  #579 sealed dev build를 로컬에서 굽고(`/tmp/teleprompter-dev-579.ipa`) iPhone 15 Pro에 build 59로
  설치 → Dave가 앱을 직접 열어 relay 재연결·token 재등록(`registered sealed push token … 24f0d6fc…`,
  `tokens=1`) → `Notification` injection으로 push 발사 → daemon `sending push notification …
  level=time-sensitive`(sealed) → relay 수락·unseal·Expo Push **에러 0** → **잠금화면 push가 폰에 도착**
  (Dave 육안 확인). 맨 위 result 줄로 승격. JDK 26은 끝까지 Q1 게이트가 아니었다(iOS 실기기 push).

### Q2. iOS 실기기 — keychain / 백그라운드 사이클 / audio

- **prereq**: Q1과 동일 빌드.
- **command**: 페어링 키가 expo-secure-store(Keychain)에 저장·복원되는지(앱 재시작 후 페어링 유지),
  App Switcher background→foreground 왕복 시 relay 재연결 배너 정상, (VoiceButton 네이티브 구현 후)
  audio capture. 현재 `VoiceButton`은 네이티브에서 `null` 반환(TODO) — audio는 구현 전까지 `N/A`.
- **pass**: 앱 강제종료 후 재실행에도 페어링 살아있음. background 진입 후 복귀 시 reconnect.
- **result**: **PASS 2026-06-07 (build #59, sealed Path X #579 `33b8375` — keychain 영속 + bg→fg 재연결 실기기 확인).**
  iPhone 15 Pro(`FFB34007-…`)의 build 59에서 Dave가 라이프사이클 거동을 직접 조작·확인:
  - **Test 1 (keychain 영속성):** App Switcher로 앱 **강제종료 후 콜드 런치** → 재페어링 없이 Daemons
    목록의 페어링이 그대로 복원됨(expo-secure-store/Keychain). Dave 육안 확인 = 페어링 유지. (콜드 런치는
    로컬 Keychain의 페어링 목록을 먼저 렌더하므로 daemon 측 재연결 로그는 이 단계에서 필수 아님 — 영속성
    SoT는 frontend의 페어링 복원.)
  - **Test 2 (background→foreground 재연결):** 홈 제스처로 백그라운드 → ~15s 대기 → 앱 복귀 시 relay
    재연결. **daemon 로그 교차 확인:** `[RelayClient] key exchange completed with frontend 24f0d6fc…` +
    `[PushNotifier] registered sealed push token … 24f0d6fc… (ios)` (재연결 후 kx 재수행 + sealed token
    재등록). Dave 육안 = 재연결됨.
  - **Test 3 (audio):** `VoiceButton` 네이티브 미구현 → `N/A`.

  빌드+설치는 Q1과 동일 빌드(build 59)로 충족. 마지막 물리·인간 게이트(강제종료·App Switcher 조작)를
  닫아 PARTIAL → PASS.

  ---

  **History — PARTIAL 2026-06-06 (빌드+설치 완료, 라이프사이클은 사용자 디버깅 대기):**
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
  - **Sessions 화면 변경 네이티브 재검증 노트 (RN Web 은 PASS):** Sessions 탭 세 변경이 RN Web 에서 검증
    완료 — (a) cwd 표시가 home 아래는 `~/...` 축약, 그 외는 절대 경로(PR #586, `formatCwd`), (b) reconnect
    시 세션 목록 자동 갱신 + 헤더 Refresh 버튼/pull-to-refresh(PR #584), (c) Refresh 버튼이 in-flight 동안
    `aria-busy` 로 진행 상태를 보조기기에 알림(PR #588 — web 은 명시 spread, 네이티브는 `accessibilityState.busy`).
    셋 다 순수 JS/RN 로직이라 네이티브에서 동일 동작이 기대되지만 끝단 미검증. (c)는 **live dogfood 로 daemon
    연결 경로 PASS** — paired daemon(`daemon-mpbjjuvj`, production relay) 실세션에서 Refresh 클릭 시 web
    `aria-busy` 가 `false→true(~1150ms)→false` 토글(stuck-true 없음, adversarial verifier 독립 확인). CI
    (daemon-free)는 `sent===0` short-circuit 으로 idle `aria-busy="false"` 만 검증 가능 — `true` 발화는 daemon
    연결 시에만 일어남. **다음 Android(Q3)/iOS(Q1·Q2) 빌드 골든 패스 순회 시 함께 eyeball:** 세션 행 제목이
    `~/...`(또는 절대 경로)로 뜨는지(basename 만 아님), reconnect/Refresh 후 목록이 갱신되는지, Refresh 탭 시
    네이티브 `accessibilityState.busy`(VoiceOver/TalkBack "busy"/스피너)가 in-flight 동안 켜졌다 꺼지는지.
    RN Web 회귀 가드: `e2e/app-session-row-cwd-display.spec.ts`, `e2e/app-session-row-edit-time-accessible-name.spec.ts`,
    `e2e/app-sessions-refresh.spec.ts`(CI, idle false), `e2e/app-sessions-refresh-live.spec.ts`(local, true→false 토글).

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
- **result**: **PASS 2026-06-07 (재확인 — Lima Ubuntu VM, systemd 257, aarch64, `tp-linux_arm64` v0.1.46).**
  `tp daemon install` → unit `~/.config/systemd/user/teleprompter-daemon.service` 생성,
  `active (running)` + `enabled` (PID 8801, IPC `/run/user/501/daemon.sock` 리스닝). `Linger=yes`
  확인(headless reboot 자동 기동 조건). **VM reboot 후 수동 start 없이 자동 기동** (새 PID 968,
  `up 0 minutes`, socket 재생성) — `WantedBy=default.target` 발동. `tp status` → "Background daemon:
  running, Sessions: 0" 정상. `tp daemon uninstall` → unit not-found + unit file 제거 + socket
  사라짐 (대칭성 확인). claude CLI 미설치라 세션 spawn 은 범위 밖 (install/systemd 라이프사이클 검증이
  이 항목의 목적). 6/5 이후 main 커밋이 전부 docs-only라 6/5 빌드 바이너리로 재확인 충분.

  **History — PASS 2026-06-05** (Lima Ubuntu 24.04 VM, aarch64, systemd 255, `tp-linux_arm64`
  v0.1.46). `tp daemon install` → unit 생성, `active (running)` + `enabled` (PID 2863). VM reboot
  후 수동 start 없이 자동 기동 (새 PID 813). uninstall 대칭성 확인.

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
  → 원래 **고성능 Mac은 Q6 건너뜀** (머신 사양 무관 항목, 중복 불필요)이었으나,
  아래 재실측으로 한 번 더 확인.
- **re-verify**: **PASS 2026-06-07** (이 64GB M1 Max Mac, `scripts/soak.ts --minutes 60 --json`,
  실 daemon pid 19826 추적). 60 라운드 × {reconnect 100, rtt 100}: reconnect **6000/6000**
  (connect p95 ≤4.0ms), frame round-trip **6000/6000** (rtt p95 ≤1.5ms), RSS 66.0→64.0MB
  (peak 66.0MB, Δ **−3%** = 누수 없음), idle/wake **5/5** (95s hold > relay 90s idle —
  daemon stale→offline 후 정상 reconnect, sub-ms wake), relay drop 카운터 전부 **0**,
  hard failures **0**. → `SOAK PASS`.

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
- **result**: **PASS 2026-06-07 (build #59, sealed Path X #579 — 네이티브 Hermes 콘솔 라이브 확인).**
  iPhone 15 Pro build 59(= #577 `f3c654c` 폴리필 포함, 6/7 17:44 빌드 시 HEAD `1c96573` > `33b8375`(#579)
  > `f3c654c`(#577))에서 Dave가 앱을 **강제종료 → 콜드 런치**해 첫 crypto init(`ensureSodium()`, 페어링
  목록 E2EE 복호화 경유)을 트리거. Metro dev-client 로그(`apps/app/.expo/dev/logs/start.log`) 전수
  분석 결과 **두 emscripten 노이즈 라인(`failed to asynchronously prepare wasm` / `Aborted(...)` as
  warn)이 0건** — build #58 시절 로그엔 콜드 스타트마다 반복됐는데 build #59 이후엔 완전히 사라졌다.
  유일하게 남은 `WebAssembly.RuntimeError: Aborted(...). Build with -sASSERTIONS` 라인은 `level: error`의
  **uncaught promise rejection**(RN 글로벌 핸들러 경로, console.error/warn 아님)이고 #577 **이전**
  (build #58, 6/6)부터 동일하게 존재한 **genuine error라 회귀 아님** — #577 기준 "genuine error는 그대로
  통과(콘솔 통째 묵음 금지)"에 정확히 부합(폴리필이 오버블록하지 않았다는 증거). 끝단 on-device 확인 완료
  → NEEDS-DEVICE → PASS.

  ---

  **History — NEEDS-DEVICE (PR #577, merged `f3c654c`):** 유닛으로는 증명됨
  (`crypto-polyfill-binding.test.ts`가 폴리필이 libsodium require **전에** `console.error`/`.warn`을
  래핑해 두 노이즈 라인은 drop, 진짜 에러는 downstream으로 forward함을 end-to-end로 검증), 그러나
  **끝단(네이티브 Hermes 콘솔에서 라인이 실제로 사라졌는지)은 실기기/Simulator에서만 확인 가능**.
  배경: 직전 시도(PR #573)는 (a) libsodium이 module-eval 시점에 `console.error.bind(console)`로
  에러 sink를 **한 번** 바인딩해서 *나중에* `console.error`를 재할당해도 무효였고, (b) libsodium.js가
  module-local `WebAssembly` 심을 자체 정의해 `globalThis.WebAssembly` 폴리필이 로깅 코드에 도달하지
  못해 실패했다. #577은 노이즈를 **소스(바인딩 시점)**에서 필터링하고 libsodium require 전에 설치하는
  것으로 두 원인을 모두 제거했다 — on-device 확인만 남았다.

### Q9. libsodium init unhandled rejection — 네이티브 Hermes 트래커 재등록 fix

- **prereq**: dev build 실기기 + Metro dev-client(`apps/app/.expo/dev/logs/start.log`). 앱이 부팅해
  daemon 에 reconnect → ECDH/세션 복호화로 `ensureSodium()`(libsodium init)을 트리거하면 충분.
- **command**: 앱을 콜드 런치해 첫 crypto 를 트리거하고, baseline byte offset 이후 `start.log` 신규
  라인에서 `WebAssembly.RuntimeError` / `Aborted(` / `Cannot assign to read-only property` /
  `Uncaught (in promise` 4개 시그니처를 grep. Fast Refresh(소스 변경)로 모듈을 재실행한 뒤에도
  동일 검사를 반복(트래커가 reload 에 clobber 되는지 검증).
- **pass**: 네 시그니처 모두 **0건** (fresh launch + Fast Refresh 후 모두). genuine rejection 은 그대로
  LogBox/console 로 surface 돼야 함(과잉 묵음 금지).
- **result**: **PASS 2026-06-08 (PR #591 `11404fd`, A/B on-device 결정 검증).**
  iPhone 15 Pro, Metro :8081 dev-client. **트래커 재등록 빌드**(머지된 mechanism —
  `HermesInternal.enablePromiseRejectionTracker` last-call-wins 재호출, `onUnhandled` 가
  `isLibsodiumInitRejection` 만 drop, 나머지는 `ExceptionsManager` 로 위임): fresh launch = 네 시그니처
  **0/0/0/0**, Fast Refresh(소스 변경으로 HMR 재실행, 릴레이 reconnect→ECDH 재실행 동반) 후에도 **0/0/0/0**
  → 트래커가 reload 에 clobber 되지 않음을 입증. **대조군 `RN$handleException` 빌드**(workflow
  `wf_0f537a63-980` 가 선택한 sink-filter fix 를 verbatim 적용): 같은 기기에서 콜드 런치 시
  `[client:error] Uncaught (in promise, id: 0) WebAssembly.RuntimeError: Aborted(Error: WebAssembly is
  not available on this runtime)...` 가 **leak (1건)** — RN 0.85.3 New Arch 에서 `global.RN$handleException`
  는 native `defineReadOnlyGlobal` 로 박힌 read-only 슬롯이라 JS 재할당이 **silent no-op** 이기 때문.
  ⇒ workflow 의 verdict("RN$handleException sink 유지, 트래커 재등록 거부")는 **틀렸다** — stale commit
  body(91b50b5 pre-fix)를 근거로 삼았고 `RN$handleException` 가 writable 이라는 전제가 온디바이스에서
  반증됨. 머지된 트래커 fix 가 정답으로 확정.

### Q10. on-device 콘솔 시그니처 검증 도구 (expo-mcp `verify_on_device`) — false-clean 구조적 차단

이 항목은 Q8/Q9 처럼 **손으로 `start.log` 을 tail** 하던 방식을 **expo-mcp 의 `verify_on_device`** 로
대체한다. 핵심: 디바이스가 dev-server 번들이 아니라 **embedded FILE 번들** 로 폴백하면 `start.log` 의
콘솔 출력이 깨끗한 실행과 byte 단위로 동일해져 `0/0/0/0/0` **false-clean** 이 난다 (Q9 의 wf_0f537a63
오판도 같은 계열). 새 도구는 PASS 를 **file-bundle/stale/fix-미실행 디바이스가 충족할 수 없는** 전제에
게이트한다 — CDP `/json/list` 의 non-synthetic Hermes 페이지 존재 + reload 전달 + **fresh post-reload
execution context + nonce 왕복** + 캡처 ≥1 entry. 하나라도 실패하면 distinct reason 으로 `FAIL`
(handler 가 `isError=(verdict!=='PASS')` 로 protocol-enforce), 절대 조용한 clean pass 가 안 난다.

- **prereq**: expo-mcp PR(`feat: verify_on_device …`) 머지 + `pnpm build` 된 dist. 앱에 `[tp-app boot]`
  boot-marker(이 chore PR) 가 들어가 있어야 `present` 시그니처로 캡처 윈도를 검증할 수 있다. dev build
  실기기/Simulator 가 **dev-server 번들** 로 떠 있어야 한다 (FILE 번들이면 도구가 그걸 잡아 FAIL).
- **command** (standing self-check 3종):
  1. **POSITIVE (dev bundle)**: `start_session({target:'ios-simulator'})` → `verify_on_device({reload:true,
     signatures:[5 standing + boot-marker present]})` → `verdict:'PASS'`, `fresh_execution_proved:true`.
  2. **NEGATIVE (file bundle, 핵심)**: dev-server 프로젝트를 닫아 EXDevLauncher 가 embedded FILE 번들로
     폴백하게 한 뒤 같은 호출 → `verdict:'FAIL'`, `reason:'device_not_on_dev_bundle'` (clean pass 가 아니어야
     함 — 이게 Q9 false-clean 트랩이 loud FAIL 로 전환됐다는 증거).
  3. **A/B dogfood (eae7590)**: pre-fix(`eae7590~1`) 에서 `deep-import-deprecation`(`Deep imports from the
     'react-native' package are deprecated`) = `present` → `FAIL`; fixed(HEAD) 에서 = `absent` → `PASS`.
     **양 leg 모두 `fresh_execution_proved:true`** 여야 "경고가 사라졌다" 가 false-clean 이 아님을 보장.
- **pass**: 세 self-check 가 각각 PASS/FAIL/(FAIL→PASS) 로 기대대로 판정. 특히 NEGATIVE leg 가
  `device_not_on_dev_bundle` FAIL 을 내야 게이트가 non-fakeable 임이 입증된다.
- **result**: **PASS 2026-06-10 (실기기 iPhone dev-client `dev.tpmt.app`, Metro :8081, 라이브 MCP 도구로 수행).**
  선행 차단 이슈 1건 해결 후 수행: 도구가 CDP debugger WS 를 `Origin: http://localhost:<port>` 로 열어
  Expo 의 `localhost`→`127.0.0.1` 정규화(`UrlCreator.getDefaultHostname`)와 `isMatchingOrigin()` strict
  host 비교가 어긋남 → `createDebugMiddleware` 가 `socket.terminate()` → CDP 트래픽 0 에서 close 1006.
  expo-mcp PR #14(`aa51885`, origin → `127.0.0.1`) 로 수정. 3종 결과:
  1. **A/B dogfood (eae7590)**: **Leg A**(pre-fix WT) `deep-import-deprecation` `expect:present` → PASS
     (matched 2, 출처 `crypto-polyfill.ts 251:12` 그대로 캡처, boot-marker 2, 나머지 4 absent 시그니처 0).
     **Leg B**(eae7590 cherry-pick -n) 같은 시그니처 `expect:absent` → PASS (matched 0, boot-marker 2,
     5 absent 전부 0). 양 leg 모두 `fresh_execution_proved:true, nonce_echoed:true, captured_entries:10` —
     같은 하네스의 live 채널에서 2→0 전환이 관측돼 false-clean 아님.
  2. **NEGATIVE**: 세션을 :8082 로 재기동(로드된 앱은 :8081 고정 → 구조적으로 attach 불가) 후 동일 호출
     → `verdict:FAIL, reason:device_not_on_dev_bundle`, 조용한 clean pass 없음. embedded FILE 번들 폴백
     대신 device-absent 변형으로 수행 — 게이트가 검사하는 상태(`/json/list` 에 non-synthetic Hermes
     페이지 부재)는 동일.
  3. **POSITIVE** 는 1번 Leg A/B 가 겸함 (dev bundle attach + reload 전달 + fresh context + nonce 왕복 +
     캡처 ≥1 전부 충족).
  순수-함수 레이어(`cdp-verify.ts`)는 18 assertion self-check(`pnpm test`) 로 false-clean 게이트
  (empty page list → `device_not_on_dev_bundle`, stale → `no_fresh_execution`, empty capture →
  `empty_capture`) 가 회귀 가드됨.

### Q11. native crypto (react-native-quick-crypto) — on-device E2EE interop 검증

PR3 (`refactor(app): enable native crypto on Hermes ...`) 가 `USE_NATIVE_CRYPTO` 를 켜서 native
Hermes 의 E2EE provider 를 libsodium-wrappers(wasm2js) → react-native-quick-crypto(JSI) 로 교체했다.
이 항목이 PASS 해야 PR3 draft 를 머지한다 (**merge gate**). 유닛 레벨에서는
`apps/app/src/lib/crypto-provider-native.test.ts` 가 cross-implementation oracle (BoringSSL X25519 +
blakejs vs libsodium) 로 kx/KDF 를, libsodium-backed mock 으로 AEAD 레이아웃을 검증했지만, **진짜
RNQC native AEAD (xchacha20-poly1305 JSI) ↔ Bun daemon libsodium 상호 복호화는 온디바이스에서만
증명 가능**하다. 참고: 이 PR 로 Q8/Q9 가 검증했던 wasm2js 워크어라운드(콘솔 필터·WebAssembly
스텁·rejection 트래커 재등록)는 **제거됨** — libsodium 이 native 에서 아예 evaluate 되지 않으므로
해당 증상 자체가 구조적으로 소멸 (Q8/Q9 의 result 는 당시 기록으로 유지).

- **prereq**: `USE_NATIVE_CRYPTO=true` 가 포함된 **새 dev build** — RNQC 는 native 모듈 + config
  plugin 이라 fingerprint runtimeVersion 이 바뀐다. 기존 빌드(≤#59) 재사용 불가, OTA 불가, FULL
  빌드 필요 (`scripts/ios-dev-build.sh --profile device` 또는 EAS development). 로컬 daemon
  (libsodium, Bun) + relay 정상 동작, 기존 페어링 1개 이상.
- **command**: (1) 앱 콜드 런치 → 기존 페어링 daemon reconnect (relay.auth → kx ECDH → 세션 키
  파생) → Sessions 목록 E2EE 복호화 확인. (2) 세션 진입해 Chat/Terminal 프레임 양방향 송수신
  (daemon=libsodium 암호화 ↔ app=RNQC 복호화, 그리고 역방향). (3) 신규 페어링 1건 (`tp pair new` →
  URL paste → kx 완료). (4) DiagnosticsPanel crypto self-test 실행 (keyGen/encDec). (5) expo-mcp
  `verify_on_device` 로 `[tp-app boot]` present + crypto 에러 시그니처 (`crypto-provider-native`,
  `E2EE crypto failed`, `WebAssembly.RuntimeError`, `Aborted(`) absent 확인.
- **pass**: (a) reconnect/신규 페어링/세션 데이터 송수신 전부 정상 (양방향 상호 복호화), (b)
  DiagnosticsPanel self-test 전 항목 ok, (c) verify_on_device `verdict:PASS` +
  `fresh_execution_proved:true` 로 boot-marker present·에러 시그니처 absent, (d) 콜드 런치
  체감 지연 회귀 없음 (wasm2js init 제거로 오히려 개선 기대).
- **result**: **PASS 2026-06-11 (iPhone 17 Pro Simulator iOS 26.2, dev build, 2 real bugs
  found & fixed)**. 검증 중 실버그 2건 발견 — 이 항목이 merge gate 가 아니었다면 둘 다 프로덕션
  으로 나갔다:
  - **FAIL #1 — `BLSALLOC_SODIUM`**: RNQC 를 bare 등록하면 XChaCha20-Poly1305 가 native 빌드에
    libsodium 없이 컴파일되어 `Cipher.update(...): libsodium must be enabled (BLSALLOC_SODIUM)`
    로 모든 AEAD 가 런타임 실패. fix = `app.json` plugins 를
    `["react-native-quick-crypto", { "sodiumEnabled": true }]` 로 (commit `6d4f773`) + native
    재빌드. 단위 oracle 은 구조적으로 못 잡음 (bun:test AEAD 는 libsodium-backed).
  - **FAIL #2 — RNQC one-shot cipher contract**: RNQC 의 XChaCha cipher 는 Node 스트리밍이 아닌
    one-shot — `update()` 는 버퍼만 하고 **빈 버퍼**를 반환, `final()` 이 전체 ct/pt 를 반환
    (`XChaCha20Poly1305Cipher.cpp`). Node 식으로 update() 출력만 쓰면 **모든 E2EE 프레임이
    16-byte tag 만 담겨** daemon 이 `ciphertext cannot be decrypted using that key` 로 거부.
    fix = provider 가 update()‖final() 출력을 concat (양방향), 단위 mock 도 one-shot 의미론으로
    재작성해 blind spot 구조적 폐쇄 (이전 mock 은 틀린 스트리밍 계약을 검증하고 있었음).
  - 최종 PASS 증거: (a) 신규 페어링 `✓ Paired q11-sim (daemon-mq90027d)` CLI 정상 종료 +
    daemon.log `key exchange completed` + `pairing pp-mq90027e-dpr21f completed` + sealed push
    token 등록 2건 (app→daemon AEAD) + Sessions 목록 렌더/pull-to-refresh 라이브 갱신
    (daemon→app AEAD) — 양방향 상호 복호화 증명. (b) DiagnosticsPanel self-test: Platform
    hermes, Sodium Init OK (150ms), Key Gen OK (0ms), Encrypt/Decrypt OK (2ms), E2EE Active.
    (c) verify_on_device 대체 — expo-mcp `start_session` 이 이 머신에서 고장이라 Metro 로그
    직접 검증으로 동등 증거 확보: `[tp-app boot] engine=hermes dev=true` present, 에러 시그니처
    (`crypto-provider-native`, `E2EE crypto failed`, `WebAssembly.RuntimeError`, `Aborted(`,
    `BLSALLOC_SODIUM`) absent. (d) 콜드 런치 정상 (full bundle 10221ms/2043 modules, crypto
    에러 0건). 절차 메모: Maestro 는 RN 버튼 텍스트를 못 보는 경우가 많아 point-tap 사용,
    Expo dev-tools 기어 버블이 탭을 가로채므로 swipe 로 이동 후 진행.
  - **실기기 addendum — PASS 2026-06-11 (Dave-iPhone15Pro, iOS 26, device dev build)**:
    PR3 브랜치에서 `scripts/ios-dev-build.sh --profile device` 로 .ipa 로컬 빌드 →
    `xcrun devicectl device install app` 설치 → 딥링크 콜드 런치 → Metro 연결. 증거:
    (a) 폰에서 스트리밍된 boot marker `[tp-app boot] engine=hermes dev=true` ×2 (Metro 로그),
    (b) daemon 재시작 후 폰 frontend 가 kx 재수행 — daemon.log `key exchange completed with
    frontend 24f0d6fc...` + `registered sealed push token ... (ios)` ×4 (app=RNQC 암호화 →
    daemon=libsodium 복호화 성공 증명), (c) 에러 시그니처 (`BLSALLOC_SODIUM`,
    `handleMessage threw`, `encrypt failed`, `crypto-provider-native`) 0건. Simulator PASS 와
    합쳐 RNQC native AEAD ↔ Bun daemon libsodium 양방향 상호 복호화가 실기기에서도 확정.
  - **운영 팁 — dev client 가 launcher 홈에서 대기하는 문제**: 신규 설치 후 plain launch 는
    dev client launcher 홈에서 멈춘다 (Metro 자동 연결 안 됨). 딥링크로 런치하면 launcher 를
    건너뛰고 즉시 Metro 에 붙는다:
    `xcrun devicectl device process launch --terminate-existing --device <UDID>
    --payload-url "tp://expo-development-client/?url=http%3A%2F%2F<mac-ip>%3A8081" dev.tpmt.app`
    (scheme 은 app.json 의 `tp`; 폰 잠금 상태면 FBSOpenApplicationErrorDomain error 7 — 잠금
    해제 후 재시도).

---

## 실행 규약 (커맨드가 따르는 규칙)

1. **0번 게이트를 먼저 통과**시키지 못하면 어떤 Q도 시작하지 않는다.
2. 각 Q를 **독립적으로** 실행 — 하나 실패가 나머지를 막지 않는다(Q7 BLOCKED는 정상).
3. 실행 후 해당 Q의 `result` 필드를 **이 문서에 직접 기록**하고 커밋한다(`docs:` prefix).
4. 빌드 산출물(.ipa/.app)은 repo에 커밋하지 않는다. credential도 절대 커밋하지 않는다.
5. 실기기 거동에서 버그 발견 시: 재현 가능한 fix 브랜치 + (가능하면) 회귀 가드. RN Web에서 재현
   가능한 회귀면 `e2e/app-*.spec.ts`도 동봉(`CLAUDE.md` "디버그 중 발견한 UI 버그 처리").
