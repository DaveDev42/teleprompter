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

- `eas build --local`이 `aps-environment` entitlement이 박힌 .ipa를 **생성**한다.
- **iOS Simulator는 진짜 APNs를 못 받는다** — `getExpoPushTokenAsync()`(`use-push-notifications.ts:25`)가
  Simulator에서 토큰을 안 준다. Simulator push는 `xcrun simctl push`로 payload/handler **로컬
  시뮬레이션**만 가능.
- 진짜 경로 `hook → push-notifier → relay → Expo Push → APNs → iPhone`의 끝단은 **실기기 + 빌드
  설치**가 있어야만 검증된다. 빌드 도구(`--local` vs EAS 클라우드)는 이 부분에 차이 없음.

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
- **result**: **BLOCKED 2026-06-05** — dev build `.ipa` 미생성. `scripts/ios-dev-build.sh --profile
  device` (= `eas build --profile device --platform ios --local`) 가 "Configure expo-updates build
  phase" 에서 실패: app.json `runtimeVersion.policy = fingerprint` 라 local build plugin 의 격리된
  `npx eas-cli-local-build-plugin` 서브프로세스가 EAS 서버 fingerprint 를 fetch 할 때 `The bearer
  token is invalid` → local/build runtimeVersion mismatch 로 중단. `eas login` 재인증(sessionSecret
  갱신) + `eas fingerprint:generate` 서버 등록 후에도 동일 — CLI 레벨은 통과하나 격리 서브프로세스
  (`builderEnvironment.env: {}`)에 sessionSecret 가 전파되지 않는다. `EXPO_UPDATES_FINGERPRINT_OVERRIDE`
  우회도 같은 이유로 닿지 않음(`eas.json` `env` 에 박아야 전파). **`.claude/rules/native-build.md` 정책
  상 로컬 iOS 네이티브 빌드는 재시도하지 않는다 — EAS 클라우드 빌드 → TestFlight 로 이관, 실기기 push
  E2E 는 그 빌드로 사용자(Dave)가 검증.** (부수 성과: dev build 가 요구하는 `expo-dev-client` 의존성
  누락 + 잘못된 버전(SDK 56 인데 `~55.x`)을 발견해 `~56.0.18` 로 고침 — 별도 fix 브랜치.)

### Q2. iOS 실기기 — keychain / 백그라운드 사이클 / audio

- **prereq**: Q1과 동일 빌드.
- **command**: 페어링 키가 expo-secure-store(Keychain)에 저장·복원되는지(앱 재시작 후 페어링 유지),
  App Switcher background→foreground 왕복 시 relay 재연결 배너 정상, (VoiceButton 네이티브 구현 후)
  audio capture. 현재 `VoiceButton`은 네이티브에서 `null` 반환(TODO) — audio는 구현 전까지 `N/A`.
- **pass**: 앱 강제종료 후 재실행에도 페어링 살아있음. background 진입 후 복귀 시 reconnect.
- **result**: **BLOCKED 2026-06-05** — Q1 과 동일 dev build `.ipa` 게이트(EAS local-build fingerprint/
  bearer-token). 빌드가 안 나와 keychain/background-cycle 검증 불가. EAS 클라우드 → TestFlight 빌드로
  실기기 검증을 사용자(Dave)에게 이관.

### Q3. Android 실기기 — 골든 패스 1회 + 권한 모델

- **prereq**: 0번 게이트 + Android dev build (`eas build --platform android --profile device --local`
  또는 EAS 클라우드 Internal track) 실기기 설치.
- **command**: 페어링(manual paste 또는 QR) → 세션 목록 → Chat 탭(메시지 송수신, Enter-to-send) →
  Terminal 탭(PTY 스트림/ANSI/키 입력) 풀 골든 패스 1회. 권한: network, foreground service 동작 확인.
- **pass**: 페어링·세션·Chat·Terminal 전부 동작. foreground service 알림 표시, network 권한 정상.
- **result**: **BLOCKED 2026-06-05** — Android dev build 미생성(이번 순회는 iOS 게이트에서 막혀 Android
  로컬 빌드까지 진행 못 함). 동일하게 EAS 클라우드 Internal track → 실기기 검증을 사용자(Dave)에게 이관.

### Q4. Simulator QA — UI/로직 회귀 (Expo MCP + Maestro)

- **prereq**: 0번 게이트 + **dev build .app**을 Simulator에 설치(Expo Go 아님:
  `eas build --profile development --platform ios --local`로 simulator용 .app 빌드 후
  `xcrun simctl install booted <path.app>`). `development` profile = `simulator: true`. expo-mcp 활성화.
- **command**: Expo MCP 플러그인(`expo-mcp:qa` agent) + Maestro flow로 페어링/세션/Chat/Terminal
  탐색적 QA. push는 여기서 `xcrun simctl push <device> dev.tpmt.app payload.apns`로 payload 렌더/탭
  navigation handler만 확인(진짜 APNs 왕복은 Q1 실기기에서).
- **pass**: Maestro flow 그린, 주요 화면 스냅샷 회귀 없음. simctl push로 notification handler 동작.
- **result**: **BLOCKED 2026-06-05** — Simulator용 dev build `.app` 미생성. `eas build --profile
  development --platform ios --local` 이 Q1 과 동일한 expo-updates fingerprint/bearer-token 게이트에
  걸려 `.app` 이 안 나옴 → `xcrun simctl install` 이하 전체 불가. **`.claude/rules/native-build.md`:
  로컬 Simulator/Xcode/네이티브 빌드 재시도 금지** — RN Web dogfood(`pnpm dev:app` + `pnpm dev:pair`)로
  페어링/세션/Chat/Terminal 회귀를 커버하고, 네이티브 전용 거동은 EAS 클라우드 빌드로 이관.

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
- **result**: _(BLOCKED — Windows 환경 필요, 고성능 Mac 범위 밖)_

---

## 실행 규약 (커맨드가 따르는 규칙)

1. **0번 게이트를 먼저 통과**시키지 못하면 어떤 Q도 시작하지 않는다.
2. 각 Q를 **독립적으로** 실행 — 하나 실패가 나머지를 막지 않는다(Q7 BLOCKED는 정상).
3. 실행 후 해당 Q의 `result` 필드를 **이 문서에 직접 기록**하고 커밋한다(`docs:` prefix).
4. 빌드 산출물(.ipa/.app)은 repo에 커밋하지 않는다. credential도 절대 커밋하지 않는다.
5. 실기기 거동에서 버그 발견 시: 재현 가능한 fix 브랜치 + (가능하면) 회귀 가드. RN Web에서 재현
   가능한 회귀면 `e2e/app-*.spec.ts`도 동봉(`CLAUDE.md` "디버그 중 발견한 UI 버그 처리").
