# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Chat / Terminal UI (dogfood 라운드에서 발견)
- [x] **터미널이 UTF-8 입력 시 깨짐 + 연쇄로 claude 입력 차단** — `apps/app/app/session/[sid].tsx`의 `handleData()`가 `btoa(data)`를 직접 호출, 한글/이모지/멀티바이트 UTF-8에서 `InvalidCharacterError` 발생 → React 컴포넌트 throw → ghostty-web unmount → daemon 측 PTY는 입력을 못 받음. PR #455 (encodeUtf8Base64 헬퍼) 로 해결.
- [x] **Chat UI 가 PTY raw 출력을 그대로 노출 (실사용 불가 수준)** — `[sid].tsx`의 PTY io 핸들러가 `stripAnsi`만 거쳐 `streamingText`에 누적. **결정: hooks-only 로 완전 전환** — Stop 이벤트의 `last_assistant_message` 가 canonical 응답이므로 PTY 폴백 자체를 제거. PR #457 로 해결.
- [x] **Chat auto-scroll 이 사용자 스크롤 의도를 무시** — 사용자가 위로 스크롤해 과거 메시지를 읽는 중에도 새 메시지가 도착하면 강제로 하단으로 끌어내림. `onScroll`로 bottom 100px 이내일 때만 (`isNearBottomRef`) 자동 스크롤. PR #457 로 해결.
- [x] **`tp --resume` 세션이 첫 메시지 보내기 전까지 history 비어보임** — `client.resume(sid, 0)` 가 `sid` 변경 시점 1회만 호출되어 relay kx 가 안 끝나면 backfill 영구히 미도착. relay `connected` 시그널에 의존해 resume 재시도. PR #457 로 해결.
- [x] **Sessions bulk-delete 에 "Select all" 토글 부재** — 다중 선택 삭제 UI 에 전체 선택 액션이 없어 한 화면 분량 이상의 세션을 지우려면 일일이 체크해야 함. `e2e/app-sessions-bulk-delete.spec.ts` / `e2e/app-sessions-bulk-delete-a11y.spec.ts` 회귀 가드에도 select-all 케이스 추가 필요. PR #458 로 구현.

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — TestFlight/Internal 빌드를 실기기에 올려 push token 발급 + E2E 를 검증해야 한다 (로컬 Simulator 는 안 띄움 — CLAUDE.md "iOS 빌드 & 검증 워크플로우"). 사용자 디버깅 위임.
- [x] **N:N 다중 daemon/frontend 회귀** — 2 daemon × 1 frontend 회귀는 PR #444 `e2e/app-multi-daemon-nxn.spec.ts` 로 커버. 2 daemon × 2 frontend (페어링 4개, independent E2EE keys, daemon kill 격리) 는 PR #456 `e2e/app-multi-daemon-2x2.spec.ts` 로 완료.
- [ ] **Linux daemon install** — systemd unit 생성/등록/start 경로는 코드만 검토. Lima/Ubuntu VM에서 `tp daemon install` → `systemctl status` → 재부팅 후 자동 기동까지 직접 확인 필요. (VM 준비 30분 + 검증 30분)
- [x] **passthrough claude 서브커맨드 wiring 검증** — #438에서 fake `claude` 바이너리 기반 integration test 17건 (9 utility subcommands × argv-verbatim + exit code 0/1/7/42 + "claude not found" 메시지) 추가. `forwardToClaudeCommand`을 `Promise<number>` 반환으로 리팩터링하여 테스트 가능하게 함.
- [x] **Long-running 안정성 (1시간 soak)** — daemon 메모리 RSS 추이, relay reconnect, frame round-trip latency, WS idle/wake cycle. **측정 스크립트** (`scripts/soak.ts` — in-process RelayServer + 실 daemon pid RSS 샘플링, `bun run scripts/soak.ts` 로 1h soak, `--minutes`/`--round-interval`/`--reconnects`/`--frames`/`--idle-cycles`/`--idle-hold`/`--json` 플래그, hard failure 시 exit 1). **2026-06-03 실측 1h SOAK PASS** (default cadence, 실 daemon pid 89218 추적): 61 라운드 × {reconnect 100, rtt 100} → reconnect **6100/6100** (connect p95 ≤0.94ms), frame round-trip **6100/6100** (rtt p95 ≤2.38ms), RSS 37.0→30.6MB 범위 29.7~37.0MB (**상승 추세 없음 = 누수 없음**), idle/wake **5/5** (95s hold > relay 90s idle, wake 0.5~2.4ms — daemon ping이 idle close 차단 실증), relay drop 카운터(rate/daemon/backpressure/oversized/authTimeout/eviction) **전부 0**, hard failures **0**.
- [ ] **iOS 실기기 검증** — push token, audio capture (VoiceButton 구현 후), keychain 실 거동, App Switcher background/foreground 사이클은 실기기에서만 정확하다. TestFlight 빌드 → 사용자 실기기 디버깅으로 검증 (로컬 Simulator 안 띄움).
- [ ] **Android 실기기 QA** — Web/iOS 위주로만 진행, Android QA round 자체가 없음. 페어링/세션/Chat/Terminal 전체 골든 패스 1회 + 권한 모델 (network, foreground service) 확인 필요. Internal track 빌드 → 실기기 디버깅으로 검증 (로컬 에뮬레이터 안 띄움).

### 인프라 한계로 미검증 (별도 환경 필요)
- [ ] **Windows under WSL** — exit 분기 코드 (`process.platform === "win32"`)만 검증. 실제 WSL Ubuntu에서 install.sh → tp daemon → 페어링 → 세션 풀 사이클은 Windows 머신 없이는 검증 불가.

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
- [ ] **Rank 9** — `noUncheckedIndexedAccess` + `noPropertyAccessFromIndexSignature` 전역 활성화
  - 9A `noPropertyAccessFromIndexSignature` (TS4111, ~2277 sites — 대부분 `*-guard.ts` 의 untrusted-key
    bracket access) — base.json + app tsconfig 에 활성화, tsc-guided codemod (`scripts/codemod-ts4111.ts`) 로 변환 (이 PR)
  - 9B `noUncheckedIndexedAccess` (TS2532/18048/2345 등 ~180 sites — `arr[i]!` vs guard 판단 필요) — 후속 PR

---

## 🌟 Future (v0.x 이후 / 별도 트랙)

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
