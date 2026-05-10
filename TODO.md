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

- [x] **`tp pair new` "disconnect" 토스트 오발화** (2026-05-11 v0.1.22 재현 확인 → PR #192 fix) — 페어링 정상 완료 직후에도 "Daemon disconnected — pairing aborted." 에러 메시지가 출력되던 race. `apps/cli/src/commands/pair.ts`의 onClose 핸들러를 `settled` flag로 가드. 정적 회귀 테스트 추가. R5 QA 클린 통과.
- [x] **`resolveTpBinary()`가 brew 경로를 후보에 포함 안 함** (2026-05-11 신규 → PR #192 fix) — `apps/cli/src/lib/paths.ts`가 `process.argv[0]`을 우선 사용해 실제 실행된 binary 위치(brew, ~/.local, dev 모두)를 잡도록 수정. 후보 목록도 `/opt/homebrew/bin/tp`를 맨 앞에 추가. `paths.test.ts` 신규 + R5 QA에서 plist `ProgramArguments[0]=/opt/homebrew/bin/tp` 검증.
- [x] **first-run wizard가 stale `pair.lock`에 막힘** (2026-05-11 PR fix) — `apps/cli/src/lib/pair-lock.ts`의 `stale` TTL을 30s → 10s로 단축. proper-lockfile은 첫 acquire 시도에서 EEXIST → mtime stat → stale 판정 → 자동 cleanup → 재시도까지 한 번에 처리하므로, TTL만 줄이면 crash 후 사용자가 wait해야 하는 시간이 30s → 10s로 단축됨. holder의 update cadence는 `stale/2 = 5s`라 alive holder가 self-evict될 위험은 없음. retry 정책은 변경 없음 (live holder는 fast-fail로 명확히 알림).
- [ ] **daemon 다중 spawn / orphan 누적** — `pkill -9` 시 launchd가 자식을 PID 1로 reparent하는 와중에 새 daemon이 spawn돼 동시에 4개 프로세스가 떠 있는 상황을 관찰. 소켓 bind는 1개만 잡히지만 fd/메모리 leak. spawn 전 기존 PID 검사 + lockfile, 또는 `tp daemon stop`이 launchd unload 우선 처리.
- [ ] **passthrough 세션 Chat 탭 무반응** — passthrough로 시작한 세션을 React Native Web Chat 탭에서 열면 Claude 응답이 streaming되지 않음. Terminal 탭에서 클로드의 INSERT-mode 에디터로 진입하는 시나리오에서 재현. hooks event 발화 vs PTY 파싱 hybrid 경로 중 어느 쪽에서 끊기는지 trace 필요. **(2026-05-11 update)**: passthrough `-p` 모드 (one-shot prompt) 시나리오에서는 정상 작동 확인 — Chat에 "Count 1 to 20 + QA_BEACON_OK_R3" 지시 → 응답 streaming + final 정상. 인터랙티브 INSERT 모드에서만 재현되는 듯.
- [x] **stopped session Chat 탭이 historical records 미로드** (2026-05-11 R6 QA 신규 → PR fix) — passthrough `tp -p "..."` 세션이 종료된 후 앱에서 Chat 탭을 열면 "Listening to Claude Code..." 상태로 영영 멈춤. 원인: `packages/daemon/src/transport/relay-manager.ts`의 `addClient` 와 `onFrontendJoined` 가 `state === "running"` 인 세션만 `client.subscribe(sid)` 호출 → frontend 의 `relay.pub <sid>` resume request 가 relay 에서 daemon 으로 forward 되지 않음 (relay 는 sid 에 subscribe 된 peer 에만 frame 을 라우팅). Fix: stopped/error 세션도 subscribe (Runner 가 죽었으니 새 frame 은 안 옴 → relay registry entry 한 줄 비용만 추가). 회귀 테스트 2개 (`addClient` + `buildEvents.onFrontendJoined`) 추가.
- [ ] **Sessions 탭이 페어링 직후 비어 보임 (production relay 한정)** — 로컬 relay에서는 정상이지만 `wss://relay.tpmt.dev` 페어링 시 sessions 탭이 빈 채로 남는 케이스 관찰. presence 메시지 race 또는 frame replay 윈도우 (cacheSize=10) 부족 의심. **(2026-05-11 update)**: 같은 production relay로 v0.1.22 페어링 시에는 즉시 세션 표시됨. 재현 조건이 더 좁을 수 있음 (예: 다중 daemon 동시 페어링, 또는 페어링 직후 빠른 탭 전환).
- [ ] **브라우저 reload 후 Sessions 사라짐** — 페어링 후 정상 표시되던 세션 목록이 hard reload 시 비어 보임. relay-client.ts의 `relay.sub after=...` 재구독 경로가 storage hydration보다 먼저 일어나는 race 가능성.

### P2 — UX / 가시성

- [ ] **`tp doctor` daemon running 상태에서 hang** — daemon 실행 중에 `tp doctor` 실행 시 끝나지 않고 멈춤. relay 연결 진단 단계가 daemon이 잡고 있는 outbound WS 와 충돌하는 듯. doctor가 IPC ping으로 daemon에 위임하거나 별도 short-lived probe 사용.
- [x] **앱 "Remove daemon" 버튼 a11y 누락** (확인 결과 이미 해결됨) — `apps/app/app/(tabs)/daemons.tsx`의 Unpair Pressable에 `accessibilityRole="button"` + `accessibilityLabel`이 이미 부여돼 있음. R7 QA 시점의 Playwright 매칭 실패는 다른 원인(라벨 텍스트 mismatch)으로 보이며, 코드 차원에서는 수정 사항 없음.
- [x] **앱 "New Session" / "View Status" 버튼 onPress 미구현** (2026-05-11 신규 → PR fix) — Daemons 카드의 두 Pressable이 모두 핸들러 없는 dead button. Frontend는 daemon에 세션을 spawn할 수 없으므로(아키텍처 invariant — `tp` CLI가 daemon machine에서 실행되어야 함) "New Session" 행동 자체가 불가능. **수정**: 두 버튼을 단일 "View Sessions" 버튼으로 교체, Sessions 탭(`/(tabs)/`)으로 navigate. 오프라인 시에는 "Waiting for daemon to come online..." dim 텍스트 표시.
- [ ] **Daemons 탭이 daemon-id를 표시 (label 미반영)** (2026-05-11 신규) — 페어링에 `--label "web-qa-r3"` 줬어도 앱 Daemons 탭은 `daemon-mozpo5s5` 형식의 id를 표시. relay kx 후 label broadcast 흐름이 빠지거나 frontend store에 매핑이 없는 듯. `apps/app/src/stores/pairing-store.ts` 또는 daemon presence handler 확인.
- [x] **Chat 탭 PTY-fallback 버블에 ANSI escape 누출** (2026-05-11 신규, PR #193 fix) — passthrough 세션 SessionEnd 직후 dimmed assistant bubble에 `[>4m[<u78]0;` 같은 raw bytes가 남았음. 원인: `apps/app/src/lib/ansi-strip.ts`의 CSI regex `[0-9;?]*`가 private-prefix bytes (`<`, `>`, `=`, `?`)를 놓침. 수정: CSI 표준 형식 `[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]`로 확장 + OSC ST(`ESC \\`) terminator 지원 + `ESC 7 / 8` cursor save/restore 추가 + 회귀 테스트 6개 (실 captured epilogue 포함).

### P3 — minor

- [x] **`tp pair delete <prefix>`가 label에는 매칭 안 됨** (2026-05-11 PR #194 fix) — `apps/cli/src/commands/pair.ts`의 `matchPairings`에 label 매칭 두 단계 추가: (a) exact label (case-insensitive) — id 매칭이 다 miss했을 때 우선, (b) label substring (case-insensitive) — 마지막 fallback. ID 규칙이 항상 우선이라 기존 동작은 깨지지 않음. `pair.test.ts`에 6 test cases 추가 (label exact / substring / null 무시 / id-우선 / 모호성 ambiguous 에러 / CLI 통합).

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
