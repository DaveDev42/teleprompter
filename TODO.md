# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Chat / Terminal UI (dogfood 라운드에서 발견)
- [x] **터미널이 UTF-8 입력 시 깨짐 + 연쇄로 claude 입력 차단** — `apps/app/app/session/[sid].tsx`의 `handleData()`가 `btoa(data)`를 직접 호출, 한글/이모지/멀티바이트 UTF-8에서 `InvalidCharacterError` 발생 → React 컴포넌트 throw → ghostty-web unmount → daemon 측 PTY는 입력을 못 받음. PR #455 (encodeUtf8Base64 헬퍼) 로 해결.
- [x] **Chat UI 가 PTY raw 출력을 그대로 노출 (실사용 불가 수준)** — `[sid].tsx`의 PTY io 핸들러가 `stripAnsi`만 거쳐 `streamingText`에 누적. **결정: hooks-only 로 완전 전환** — Stop 이벤트의 `last_assistant_message` 가 canonical 응답이므로 PTY 폴백 자체를 제거. PR #457 로 해결.
- [x] **Chat auto-scroll 이 사용자 스크롤 의도를 무시** — 사용자가 위로 스크롤해 과거 메시지를 읽는 중에도 새 메시지가 도착하면 강제로 하단으로 끌어내림. `onScroll`로 bottom 100px 이내일 때만 (`isNearBottomRef`) 자동 스크롤. PR #457 로 해결.
- [x] **`tp --resume` 세션이 첫 메시지 보내기 전까지 history 비어보임** — `client.resume(sid, 0)` 가 `sid` 변경 시점 1회만 호출되어 relay kx 가 안 끝나면 backfill 영구히 미도착. relay `connected` 시그널에 의존해 resume 재시도. PR #457 로 해결.
- [x] **Sessions bulk-delete 에 "Select all" 토글 부재** — 다중 선택 삭제 UI 에 전체 선택 액션이 없어 한 화면 분량 이상의 세션을 지우려면 일일이 체크해야 함. `e2e/app-sessions-bulk-delete.spec.ts` / `e2e/app-sessions-bulk-delete-a11y.spec.ts` 회귀 가드에도 select-all 케이스 추가 필요. PR #458 로 구현.
- [x] **Sessions 리스트가 resume-reconnect 후 stale** — relay resume 경로는 kx 를 건너뛰므로 daemon 의 `onFrontendJoined` hello 가 재발화 안 됨 → 앱이 reconnect 했는데 세션 목록이 옛 상태로 남음. `requestSessionList()` 가 매 (re)connect 시 + 헤더 Refresh 버튼(testID `sessions-refresh-button`) + pull-to-refresh 로 `__control__` `hello` 를 보내 daemon 이 full 목록을 targeted E2EE 로 재전송하게 함. PR #584 로 해결, live dogfood 로 auto-catch-up + manual Refresh 양쪽 PASS.
- [x] **Session row 제목이 cwd basename 만 표시** — `/tmp` → `tmp`, 모든 `~/Projects/<x>` → `<x>` 로 축약돼 서로 다른 디렉터리가 같은 라벨로 뭉개짐. **결정: home 아래는 `~/...` 축약, 그 외는 절대 경로** (`formatCwd` in `apps/app/src/lib/session-ux.ts` — daemon 이 home 경로를 전송 안 하므로 POSIX 관례 `/Users/<n>`·`/home/<n>`·`/root` 로 prefix 추론). 같은 Sessions 화면 adversarial 감사에서 부수로 발견한 2건(edit-mode `selectedCount` push-race 과다 카운트, edit-mode 체크박스 a11y 시각 누락)도 동반 수정. PR #586, live dogfood PASS (실세션 6개 `~/Projects/github.com/teleprompter` 렌더 확인). 회귀: `e2e/app-session-row-cwd-display.spec.ts` + `e2e/app-session-row-edit-time-accessible-name.spec.ts`.
- [x] **Sessions Refresh 버튼이 in-flight 상태를 보조기기에 알리지 않음** — Refresh(testID `sessions-refresh-button`)가 ~1.2s 스피너를 도는 동안 `aria-busy` 가 없어 스크린리더 사용자에게 "진행 중" 신호가 안 감. RN Web `Pressable` 은 `accessibilityState.busy` 를 web DOM `aria-busy` 로 변환 안 하므로 `Platform.OS === "web"` 가드로 명시 spread (네이티브는 `accessibilityState.busy` 가 커버). WCAG 4.1.2. PR #588, **live dogfood PASS** — paired daemon(`daemon-mpbjjuvj`, production relay)에 연결된 실세션 6개에서 Refresh 클릭 시 `aria-busy` 가 `false→true(~1150ms)→false` 로 토글됨을 50ms 폴링으로 포착(stuck-true 없음, 콘솔 에러 0), adversarial verifier 가 독립 PASS 확인. CI(daemon-free)는 `sent===0` short-circuit 으로 `aria-busy="false"` idle 만 검증 가능 — `true` 발화는 daemon 연결 경로에서만 일어나므로 live dogfood + daemon-backed `e2e/app-sessions-refresh-live.spec.ts` 로만 보장됨. 회귀: `e2e/app-sessions-refresh.spec.ts`(CI, idle false) + `e2e/app-sessions-refresh-live.spec.ts`(local, true→false 토글).

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [x] **Push Notifications 실기기** — APNs push token 발급 + 알림 왕복 E2E 실기기 검증 완료. Q1 PASS 2026-06-07 (build #59, sealed Path X #579 `33b8375` — end-to-end APNs 실기기 도착 확인). 상세는 `docs/local-verification-queue.md` Q1.
- [x] **N:N 다중 daemon/frontend 회귀** — 2 daemon × 1 frontend 회귀는 PR #444 `e2e/app-multi-daemon-nxn.spec.ts` 로 커버. 2 daemon × 2 frontend (페어링 4개, independent E2EE keys, daemon kill 격리) 는 PR #456 `e2e/app-multi-daemon-2x2.spec.ts` 로 완료.
- [x] **Linux daemon install** — Lima Ubuntu VM에서 `tp daemon install` → systemd 풀 사이클 직접 검증. Q5 PASS 2026-06-07 (재확인 — Lima Ubuntu VM, systemd 257, aarch64, `tp-linux_arm64` v0.1.46). 상세는 `docs/local-verification-queue.md` Q5.
- [x] **passthrough claude 서브커맨드 wiring 검증** — #438에서 fake `claude` 바이너리 기반 integration test 17건 (9 utility subcommands × argv-verbatim + exit code 0/1/7/42 + "claude not found" 메시지) 추가. `forwardToClaudeCommand`을 `Promise<number>` 반환으로 리팩터링하여 테스트 가능하게 함.
- [x] **Long-running 안정성 (1시간 soak)** — daemon 메모리 RSS 추이, relay reconnect, frame round-trip latency, WS idle/wake cycle. **측정 스크립트** (`scripts/soak.ts` — in-process RelayServer + 실 daemon pid RSS 샘플링, `bun run scripts/soak.ts` 로 1h soak, `--minutes`/`--round-interval`/`--reconnects`/`--frames`/`--idle-cycles`/`--idle-hold`/`--json` 플래그, hard failure 시 exit 1). **2026-06-03 실측 1h SOAK PASS** (default cadence, 실 daemon pid 89218 추적): 61 라운드 × {reconnect 100, rtt 100} → reconnect **6100/6100** (connect p95 ≤0.94ms), frame round-trip **6100/6100** (rtt p95 ≤2.38ms), RSS 37.0→30.6MB 범위 29.7~37.0MB (**상승 추세 없음 = 누수 없음**), idle/wake **5/5** (95s hold > relay 90s idle, wake 0.5~2.4ms — daemon ping이 idle close 차단 실증), relay drop 카운터(rate/daemon/backpressure/oversized/authTimeout/eviction) **전부 0**, hard failures **0**.
- [x] **iOS 실기기 검증** — push token (Q1) + keychain 실 거동 / background→foreground 사이클 (Q2) 실기기 검증 완료. Q1·Q2 PASS 2026-06-07 (build #59, sealed Path X #579 `33b8375`). audio capture 는 VoiceButton 네이티브 구현 후 별도 검증 (위 Voice 항목이 추적). 상세는 `docs/local-verification-queue.md` Q1·Q2.
- [x] **Android QA — 골든 패스 + 권한 모델** — 페어링/세션/Chat/Terminal 골든 패스 1회 + 권한 모델 검증 완료. Q3 PASS 2026-06-05 (Pixel_8 AVD `emulator-5554`, dev-local APK, Maestro v2.2.0) — 에뮬레이터 수행 (실기기 아님). Android 실기기(Internal track) 라운드는 공개 release 전 선택 항목으로 남음. 상세는 `docs/local-verification-queue.md` Q3.

### 인프라 한계로 미검증 (별도 환경 필요)
- [x] **Windows under WSL** — Windows 11 + WSL2(Ubuntu)에서 install.sh → tp daemon → 페어링 → 세션 풀 사이클 검증 완료. Q7 PASS 2026-06-05 (검증 중 버그 발견 + 수정, PR #559). 상세는 `docs/local-verification-queue.md` Q7.

---

## 🔒 Type-safety debt (null/sentinel → tagged union + 런타임 guard 전환)

전 코드베이스에서 `null`/`undefined`/string-sentinel 을 찾아 tagged/discriminated union 으로 교체하고,
zero-trust 경계(파싱·복호화·IPC·SQLite)를 런타임 guard 로 강화하는 작업. 우선순위 Rank 1→9.

- [x] **Rank 1** — `parseControlMessage` guard + daemon `decryptAndDispatch` control plane 강화 (PR merged)
- [x] **Rank 2** — `parseRelayServerMessage` guard + daemon/app relay-client exhaustive switch (PR merged)
- [x] **Rank 3** — frontend `handleFrame` 복호화 E2EE payload guard (`parseRelayDataMessage` + control checks) (PR merged)
- [x] **Rank 4** — runner/CLI IPC + hook-socket parse 를 `parseIpcMessage` guard 경유 (PR merged)
- [x] **Rank 5** — SQLite Blob/key row 를 libsodium key 생성 전 validate (PR merged)
- [x] **Rank 6** — pairing-store label + active-daemon 을 tagged union 으로 (PR merged)
- [x] **Rank 7** — session/voice store 의 null/sentinel state → discriminated union
  - 7a session-store: `ActiveSession` + `RelayState` union (PR #525)
  - 7b voice-store: `VoiceConnectionState` + `VoiceKeyState` union (PR #524, 테스트 격리 후속 PR #528)
- [x] **Rank 8** — magic sentinel → union
  - 8a RTT `-1` sentinel → `Rtt = { measured: true; ms } | { measured: false }` (PR #526)
  - 8b resume-token role → `ResumeTokenPayload` daemon/frontend tagged union, wire byte-compat 유지 (PR #527)
  - 8c **worktree-path = DEFER** — `SessionMeta.worktreePath` 는 wire-serialized 필드인데 버전 협상 채널이 없고
    소비자가 display-only 라, 빈-문자열/undefined 를 union 으로 바꾸면 cross-version app 이 깨질 위험만 크고
    얻는 안전성은 작다. protocol 버전 협상이 들어오면 재검토.
- [x] **Rank 9** — `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` 전역 활성화
  - 9A `noPropertyAccessFromIndexSignature` (TS4111, ~2277 sites — 대부분 `*-guard.ts` 의 untrusted-key
    bracket access) — base.json + app tsconfig 에 활성화, tsc-guided codemod (`scripts/codemod-ts4111.ts`) 로 변환 (PR #529)
  - 9B `noUncheckedIndexedAccess` (TS2532/18048/2345 등) — base.json + app tsconfig 에 활성화. ~64 index-access
    site 를 판단 처리: provably-in-bounds 는 `arr[i]!` (bound 주석), genuinely-possibly-undefined 는 guard/narrow/default.
    **부수로 진짜 latent bug 한 건 발견·수정**: `decodePairingData` 가 relay-length byte 직전에서 정확히
    잘린 페어링 payload 를 reject 하지 않고 bogus `PairingData` 로 silently decode 하던 버그 (`o === buf.length`
    일 때 `relayLen` 이 `undefined` → `o + undefined = NaN` → `NaN > buf.length === false` 로 bounds check
    통과). `relayLen === undefined` guard 추가 + 회귀 테스트 (`pairing.test.ts` "rejects a payload truncated at
    the relay-length byte") sabotage-verify 완료.

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [x] Expo Go 드롭 → development build 전용 — 사실상 기드롭 상태를 2026-06-11 공식화. `expo-dev-client` 상시 의존성 + `eas.json` dev 프로파일 `developmentClient: true` + reanimated 4.x/deploymentTarget 16.4 로 Expo Go 호환 이미 불가, 모든 네이티브 검증 (큐 Q1–Q4, Q8–Q10) dev build 수행, 소스에 Expo Go 분기 없음. 이로써 libghostty 네이티브 / react-native-quick-crypto / Apple Watch 가 unblock. 상세는 `.claude/rules/native-build.md` "Native Build (Expo Go 드롭 완료)".
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
