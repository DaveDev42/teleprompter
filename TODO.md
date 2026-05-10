# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [ ] Session Export 대규모 세션 성능 미검증 — 10,000+ records 세션에서 export 속도/메모리 사용량 확인 필요 (현재 limit 50,000)

---

## 🐛 QA 발견 (2026-05-10 ~ 2026-05-11 end-to-end QA)

`tp → daemon → relay → React Native Web` 전체 플로우 QA 중 발견. 우선순위 순.

### P0 — 차단성 버그 (해결 완료)

- [x] **SQLITE_BUSY: daemon이 살아있으면 모든 CLI 커맨드가 실패** (PR #190, v0.1.22) — `packages/daemon/src/store/schema.ts`의 `journal_mode = DELETE`가 단일-writer rollback journal을 사용해, daemon이 writer lock을 들고 있으면 `tp pair list` / `tp status` / `tp session list` 등 단순 read도 `SQLITE_BUSY`로 즉시 throw. **수정**: `journal_mode = WAL` + `busy_timeout = 5000` + `store.test.ts`에 동시성 회귀 테스트 2개.

### P1 — 사용자 가시 동작 버그

- [ ] **`tp pair new` "disconnect" 토스트 오발화** (2026-05-11 v0.1.22 재현 확인) — 페어링 정상 완료 직후에도 "Daemon disconnected — pairing aborted." 에러 메시지가 출력됨. 실제 페어링은 DB에 정상 저장되며 앱에서도 정상 인식. `apps/cli/src/commands/pair.ts:170-174` onClose 핸들러가 resolve와 race. resolve 시 onClose unhook 또는 race-free flag로 가드.
- [ ] **`resolveTpBinary()`가 brew 경로를 후보에 포함 안 함** (2026-05-11 신규) — `apps/cli/src/lib/paths.ts:20` candidates에 `~/.local/bin/tp`, `/usr/local/bin/tp`만 있고 `/opt/homebrew/bin/tp`가 없음. brew(`davedev42/tap/tp`) 사용자가 `tp daemon install` 실행 시 plist `ProgramArguments`가 `~/.local/bin/tp` (없거나 stale 빌드) 또는 `process.argv[0]` (bun runtime) 을 가리켜 launchd가 잘못된 binary로 daemon을 spawn함. brew 경로를 candidates 맨 앞에 추가하거나 macOS에서 우선순위 부여.
- [ ] **first-run wizard가 stale `pair.lock`에 막힘** — daemon crash / pkill 후 `~/.config/teleprompter/pair.lock.lock` 디렉터리가 남아 있고, pairing이 0개라서 첫 실행 시 `showFirstRunPairing()`이 자동 `tp pair new` 호출 → "Another `tp pair new` is already running" 으로 즉시 실패. proper-lockfile `stale: 30000ms`가 디렉터리 lock에는 효과적으로 작동하지 않는 것으로 보임. wizard 진입 전 stale lock 정리 단계 또는 lock TTL을 더 짧게.
- [ ] **daemon 다중 spawn / orphan 누적** — `pkill -9` 시 launchd가 자식을 PID 1로 reparent하는 와중에 새 daemon이 spawn돼 동시에 4개 프로세스가 떠 있는 상황을 관찰. 소켓 bind는 1개만 잡히지만 fd/메모리 leak. spawn 전 기존 PID 검사 + lockfile, 또는 `tp daemon stop`이 launchd unload 우선 처리.
- [ ] **passthrough 세션 Chat 탭 무반응** — passthrough로 시작한 세션을 React Native Web Chat 탭에서 열면 Claude 응답이 streaming되지 않음. Terminal 탭에서 클로드의 INSERT-mode 에디터로 진입하는 시나리오에서 재현. hooks event 발화 vs PTY 파싱 hybrid 경로 중 어느 쪽에서 끊기는지 trace 필요. **(2026-05-11 update)**: passthrough `-p` 모드 (one-shot prompt) 시나리오에서는 정상 작동 확인 — Chat에 "Count 1 to 20 + QA_BEACON_OK_R3" 지시 → 응답 streaming + final 정상. 인터랙티브 INSERT 모드에서만 재현되는 듯.
- [ ] **Sessions 탭이 페어링 직후 비어 보임 (production relay 한정)** — 로컬 relay에서는 정상이지만 `wss://relay.tpmt.dev` 페어링 시 sessions 탭이 빈 채로 남는 케이스 관찰. presence 메시지 race 또는 frame replay 윈도우 (cacheSize=10) 부족 의심. **(2026-05-11 update)**: 같은 production relay로 v0.1.22 페어링 시에는 즉시 세션 표시됨. 재현 조건이 더 좁을 수 있음 (예: 다중 daemon 동시 페어링, 또는 페어링 직후 빠른 탭 전환).
- [ ] **브라우저 reload 후 Sessions 사라짐** — 페어링 후 정상 표시되던 세션 목록이 hard reload 시 비어 보임. relay-client.ts의 `relay.sub after=...` 재구독 경로가 storage hydration보다 먼저 일어나는 race 가능성.

### P2 — UX / 가시성

- [ ] **`tp doctor` daemon running 상태에서 hang** — daemon 실행 중에 `tp doctor` 실행 시 끝나지 않고 멈춤. relay 연결 진단 단계가 daemon이 잡고 있는 outbound WS 와 충돌하는 듯. doctor가 IPC ping으로 daemon에 위임하거나 별도 short-lived probe 사용.
- [ ] **앱 "Remove daemon" 버튼 a11y 누락** — Daemons 화면 삭제 버튼에 `accessibilityRole="button"` 부재. Playwright `getByRole('button')` 매칭 실패 + 스크린리더 경험 저하.
- [ ] **앱 "New Session" 버튼 onPress 미구현** (2026-05-11 신규) — `apps/app/app/(tabs)/daemons.tsx:123` 근처 Pressable에 핸들러가 없어 클릭해도 아무 동작 없음. 의도가 daemon별 새 세션 trigger라면 IPC `session.start` 또는 새 페어링 시작 흐름과 연결 필요.
- [ ] **Daemons 탭이 daemon-id를 표시 (label 미반영)** (2026-05-11 신규) — 페어링에 `--label "web-qa-r3"` 줬어도 앱 Daemons 탭은 `daemon-mozpo5s5` 형식의 id를 표시. relay kx 후 label broadcast 흐름이 빠지거나 frontend store에 매핑이 없는 듯. `apps/app/src/stores/pairing-store.ts` 또는 daemon presence handler 확인.

### P3 — minor

- [ ] **`tp pair delete <prefix>`가 label에는 매칭 안 됨** — daemon-id prefix만 매칭. `tp pair list`에 label이 표시되므로 사용자는 label로 지울 거라 기대. label substring 매칭 또는 명확한 에러 메시지.

### 2026-05-11 v0.1.22 end-to-end QA 결과 (참고)

`brew install davedev42/tap/tp` (0.1.22) → `tp daemon install` (launchd) → Expo dev server (`http://localhost:8081`) → Playwright로 페어링 → passthrough 세션 spawn → 세션 진입 → Chat에 "Count 1 to 20, then reply with exactly: QA_BEACON_OK_R3" 지시. 결과:

- Chat UI: 사용자 bubble + Claude 응답 ("1, 2, 3, ... 20\n\nQA_BEACON_OK_R3") 모두 정상 렌더링 (`/tmp/qa-r3-08-beacon-result.png`).
- Terminal UI: ghostty-web canvas에 동일 PTY 출력 정상 렌더링 (`/tmp/qa-r3-09-terminal.png`).

핵심 사용자 흐름은 동작. 위 P1/P2 항목들은 보조 흐름/UX 문제로, 한 PR씩 차례로 수정 예정.

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
- [ ] **macOS 바이너리 Developer ID signing + notarization** — 현재 `tp` (bun SEA) 는 Jarred Sumner (bun runtime) 의 서명을 그대로 상속. 사용자가 launchd daemon 을 등록하면 macOS Login Items & Extensions UI 에 "Jarred Sumner" entry 가 표시되는 UX 이슈. 0.x 에서는 S1 (수용) 로 합의했고, 1.0 블로커로 승격 예정. 필요: (a) Apple Developer Program 가입 ($99/yr), (b) release.yml 에 `codesign` + `notarytool` + `stapler` 단계 추가, (c) darwin 바이너리에 자체 Developer ID 서명 후 notarize. 영향 범위는 macOS darwin_arm64 릴리즈 아티팩트만 (x64 는 PR #185 에서 drop). Linux 는 무관.
