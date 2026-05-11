# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [x] Session Export 대규모 세션 성능 검증 (2026-05-11) — 합성 fixture로 1k / 10k / 30k / 50k records 측정. 50k 한계에서 SQL fetch 37ms + formatMarkdown 158ms = 총 ~200ms, output 6.6MB markdown, heap delta 무시 가능. 현재 50,000 limit은 안전하며 perf 병목 없음.

### v0.1.x 잔여 추적 항목 (해결 완료)
- [x] **passthrough 인터랙티브 INSERT-mode 세션에서 Chat 탭 streaming 끊김** (2026-05-11 v0.1.30, PR #217 fix) — Root cause: INSERT-mode는 hooks event가 발화 안 되는 동안 PTY raw input echo가 io 레코드로 흘러와서 `streamingText`에 누적 → 다음 `UserPromptSubmit`의 `finalizeStreaming`이 그 가비지를 "streaming" 메시지로 commit. **수정**: `chat-store`에 `isAssistantResponding` latch 추가 (UserPromptSubmit에서 open, Stop에서 close). 세션 뷰는 latch가 open일 때만 `appendStreaming` 호출 → INSERT-mode keystroke echo, autocomplete dropdown repaint, 기타 inter-turn UI chatter가 무시됨. 38 unit tests pass (latch 6개 신규 포함).
- [x] **production relay 한정 Sessions empty race** (2026-05-11 v0.1.30, PR #216 fix) — Root cause: resume reconnect 경로에서 daemon의 `onFrontendJoined`가 발화하지 않으므로 `hello` 프레임이 새로 안 오고, 프론트엔드는 `relay.sub`에 `after` 필드를 빼서 relay cache replay도 silent skip → Sessions 탭이 빈 채로 stuck. **수정**: `apps/app/src/lib/relay-client.ts`에서 `__meta__` 와 `__control__` sub 호출에 `after: 0` 추가 → relay가 cached `hello` 프레임을 즉시 replay. Session re-subscribe loop는 의도적으로 그대로 둠 (자체 seq cursor 사용).

---

## 🐛 QA 발견 (2026-05-10 ~ 2026-05-11 end-to-end QA)

`tp → daemon → relay → React Native Web` 전체 플로우 QA 중 발견. 우선순위 순.

### P0 — 차단성 버그 (해결 완료)

- [x] **SQLITE_BUSY: daemon이 살아있으면 모든 CLI 커맨드가 실패** (PR #190, v0.1.22) — `packages/daemon/src/store/schema.ts`의 `journal_mode = DELETE`가 단일-writer rollback journal을 사용해, daemon이 writer lock을 들고 있으면 `tp pair list` / `tp status` / `tp session list` 등 단순 read도 `SQLITE_BUSY`로 즉시 throw. **수정**: `journal_mode = WAL` + `busy_timeout = 5000` + `store.test.ts`에 동시성 회귀 테스트 2개.

### P1 — 사용자 가시 동작 버그

- [x] **`tp pair new` "disconnect" 토스트 오발화** (2026-05-11 v0.1.22 재현 확인 → PR #192 fix) — 페어링 정상 완료 직후에도 "Daemon disconnected — pairing aborted." 에러 메시지가 출력되던 race. `apps/cli/src/commands/pair.ts`의 onClose 핸들러를 `settled` flag로 가드. 정적 회귀 테스트 추가. R5 QA 클린 통과.
- [x] **`resolveTpBinary()`가 brew 경로를 후보에 포함 안 함** (2026-05-11 신규 → PR #192 fix) — `apps/cli/src/lib/paths.ts`가 `process.argv[0]`을 우선 사용해 실제 실행된 binary 위치(brew, ~/.local, dev 모두)를 잡도록 수정. 후보 목록도 `/opt/homebrew/bin/tp`를 맨 앞에 추가. `paths.test.ts` 신규 + R5 QA에서 plist `ProgramArguments[0]=/opt/homebrew/bin/tp` 검증.
- [x] **first-run wizard가 stale `pair.lock`에 막힘** (2026-05-11 PR fix) — `apps/cli/src/lib/pair-lock.ts`의 `stale` TTL을 30s → 10s로 단축. proper-lockfile은 첫 acquire 시도에서 EEXIST → mtime stat → stale 판정 → 자동 cleanup → 재시도까지 한 번에 처리하므로, TTL만 줄이면 crash 후 사용자가 wait해야 하는 시간이 30s → 10s로 단축됨. holder의 update cadence는 `stale/2 = 5s`라 alive holder가 self-evict될 위험은 없음. retry 정책은 변경 없음 (live holder는 fast-fail로 명확히 알림).
- [x] **daemon 다중 spawn / orphan 누적** (PR fix) — `pkill -9` 시 launchd가 자식을 PID 1로 reparent하는 와중에 새 daemon이 spawn돼 동시에 4개 프로세스가 떠 있는 상황을 관찰. **수정**: `packages/daemon/src/daemon-lock.ts`에 pid-file 기반 singleton lock 추가 (`XDG_RUNTIME_DIR/daemon.pid`, exclusive `O_EXCL` create, stale pid auto-cleanup). daemon process(`packages/daemon/src/index.ts`)가 IPC socket 열기 전 lock acquire → 이미 live daemon이 있으면 exit 0. CLI `tp daemon start` 경로도 `checkDaemonLockAlive`로 fast-path check. `tp daemon stop`은 launchd `bootout` / systemd `stop` 먼저 → 그 다음 SIGTERM (respawn 방지). 테스트 15개 추가 (`apps/cli/src/lib/daemon-lock.test.ts`).
- [x] **passthrough 세션 Chat 탭 무반응** (2026-05-11 v0.1.28, PR #208 fix) — Root cause: `apps/cli/src/commands/passthrough.ts`가 `daemon.start()`만 호출하고 `daemon.reconnectSavedRelays()`를 호출 안 함. 결과적으로 relay fan-out 경로가 어두워서 Runner records가 `getRelayClients()` 빈 배열 루프에서 silent drop. **수정**: `tp daemon start` 와 동일하게 `start()` 직후 `await daemon.reconnectSavedRelays()` 호출. 다중 daemon-role WS는 relay의 daemonGroup이 받아주므로 system daemon과 공존해도 안전. R10 QA Test B PASS.
- [x] **stopped session Chat 탭이 historical records 미로드** (2026-05-11 R6 QA 신규 → PR fix) — passthrough `tp -p "..."` 세션이 종료된 후 앱에서 Chat 탭을 열면 "Listening to Claude Code..." 상태로 영영 멈춤. 원인: `packages/daemon/src/transport/relay-manager.ts`의 `addClient` 와 `onFrontendJoined` 가 `state === "running"` 인 세션만 `client.subscribe(sid)` 호출 → frontend 의 `relay.pub <sid>` resume request 가 relay 에서 daemon 으로 forward 되지 않음 (relay 는 sid 에 subscribe 된 peer 에만 frame 을 라우팅). Fix: stopped/error 세션도 subscribe (Runner 가 죽었으니 새 frame 은 안 옴 → relay registry entry 한 줄 비용만 추가). 회귀 테스트 2개 (`addClient` + `buildEvents.onFrontendJoined`) 추가.
- [x] **Sessions 탭이 페어링 직후 비어 보임** (2026-05-11 v0.1.28, PR #209 fix) — Root cause: 같은 daemonId로 재페어링 시 `pairing-store.processScan`이 새 frontendKeyPair를 만들지만 cached resume token은 그대로 둠. 다음 mount에서 `FrontendRelayClient`가 `relay.auth.resume`을 보내고 relay가 accept → `sendKeyExchange()` skip → daemon은 새 frontendId를 모르고 `hello` 미전송 → Sessions tab empty. **수정**: `processScan`에서 persist 직전 `clearResumeToken(daemonId)` 호출. relay-client.ts에 helper export 추가. R10 QA Test A PASS.
- [x] **브라우저 reload 후 Sessions 사라짐** (PR fix) — `session-store`가 in-memory only여서 hard reload 시 `hello` 프레임이 도착하기 전까지 Sessions 탭이 비어 보이던 race. **수정**: `session-store`에 `Map<daemonId, WsSessionMeta[]>` 퍼시스턴트 슬롯 추가 (`secureSet` debounced write-through, `load()` on init). `setSessions(daemonId, sessions)` 시그니처 변경 — daemon별 리스트를 persist하고 flatten해서 `sessions` 필드에 노출. `_layout.tsx`에서 init 시 `loadSessions()` 호출. reload 후 즉시 last-known 세션이 보이고, 첫 `hello` 프레임에서 fresh 리스트로 덮어씀.

### P2 — UX / 가시성

- [x] **`tp doctor` daemon running 상태에서 hang** (2026-05-11 v0.1.26 PR #203 + v0.1.27 PR #206 follow-up) — Root cause: doctor가 자체 daemon-role WebSocket으로 relay에 ping 시도 → daemon이 이미 잡고 있는 outbound WS와 충돌해 hang. **수정 1 (#203)**: doctor가 daemon 실행 시 IPC fast-path로 `doctor.probe` 보내고 daemon의 live RelayClient health를 받음. **수정 2 (#206 follow-up)**: IPC Promise resolve-order race fix — Bun의 `sock.end()`가 close handler를 동기로 firing해서 `resolve(null)`이 `resolve(msg)`보다 먼저 settle하던 race. `settled` flag로 가드 + close 전에 value resolve.
- [x] **앱 "Remove daemon" 버튼 a11y 누락** (확인 결과 이미 해결됨) — `apps/app/app/(tabs)/daemons.tsx`의 Unpair Pressable에 `accessibilityRole="button"` + `accessibilityLabel`이 이미 부여돼 있음. R7 QA 시점의 Playwright 매칭 실패는 다른 원인(라벨 텍스트 mismatch)으로 보이며, 코드 차원에서는 수정 사항 없음.
- [x] **앱 "New Session" / "View Status" 버튼 onPress 미구현** (2026-05-11 신규 → PR fix) — Daemons 카드의 두 Pressable이 모두 핸들러 없는 dead button. Frontend는 daemon에 세션을 spawn할 수 없으므로(아키텍처 invariant — `tp` CLI가 daemon machine에서 실행되어야 함) "New Session" 행동 자체가 불가능. **수정**: 두 버튼을 단일 "View Sessions" 버튼으로 교체, Sessions 탭(`/(tabs)/`)으로 navigate. 오프라인 시에는 "Waiting for daemon to come online..." dim 텍스트 표시.
- [x] **Daemons 탭이 daemon-id를 표시 (label 미반영)** (2026-05-11 신규, fix/daemons-tab-label-display) — 페어링에 `--label "web-qa-r3"` 줬어도 앱 Daemons 탭은 `daemon-mozpo5s5` 형식의 id를 표시. 두 가지 원인: (a) `PendingPairing.begin()`이 `createRelayClient` 호출 시 `label`을 빠뜨려 `broadcastDaemonPublicKey()`가 `label: null`을 전송 → 프론트엔드가 device-name fallback 유지. (b) 프론트엔드가 daemon보다 나중에 연결되면 초기 `relay.kx` broadcast를 놓쳐 label을 받지 못함. **수정**: (a) `pending-pairing.ts` createRelayClient args에 `label` 필드 추가, (b) `relay-manager.ts` `onFrontendJoined` hello 메시지에 `daemonLabel` 포함, (c) 프론트엔드 `relay-client.ts` hello 파싱에서 `onDaemonHello` 호출 추가.
- [x] **Chat 탭 PTY-fallback 버블에 ANSI escape 누출** (2026-05-11 신규, PR #193 fix) — passthrough 세션 SessionEnd 직후 dimmed assistant bubble에 `[>4m[<u78]0;` 같은 raw bytes가 남았음. 원인: `apps/app/src/lib/ansi-strip.ts`의 CSI regex `[0-9;?]*`가 private-prefix bytes (`<`, `>`, `=`, `?`)를 놓침. 수정: CSI 표준 형식 `[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]`로 확장 + OSC ST(`ESC \\`) terminator 지원 + `ESC 7 / 8` cursor save/restore 추가 + 회귀 테스트 6개 (실 captured epilogue 포함).

### P3 — minor

- [x] **`tp pair delete <prefix>`가 label에는 매칭 안 됨** (2026-05-11 PR #194 fix) — `apps/cli/src/commands/pair.ts`의 `matchPairings`에 label 매칭 두 단계 추가: (a) exact label (case-insensitive) — id 매칭이 다 miss했을 때 우선, (b) label substring (case-insensitive) — 마지막 fallback. ID 규칙이 항상 우선이라 기존 동작은 깨지지 않음. `pair.test.ts`에 6 test cases 추가 (label exact / substring / null 무시 / id-우선 / 모호성 ambiguous 에러 / CLI 통합).
- [ ] **Edit tool card에 old_string/new_string diff 미표시** (2026-05-12 R16 QA, v0.1.31 신규 발견) — Chat 탭의 Edit tool PreToolUse 카드가 raw tool_input JSON만 표시하고 `old_string` / `new_string` 필드의 실제 diff는 카드에 노출되지 않음. 사용자는 어떤 변경이 일어났는지 알려면 별도로 Claude 응답 bubble을 봐야 함. **회귀 아님** — 기존 hooks-event 카드 렌더링이 그대로지만 UX 개선 여지 있음. Edit 카드를 인식해서 unified diff 또는 side-by-side로 렌더하는 전용 카드 컴포넌트 추가 필요 (`apps/app/src/components/chat/cards/`).
- [ ] **Bash tool stdout이 카드 body에 inline 표시 안 됨** (2026-05-12 R16 QA, v0.1.31 신규 발견) — Chat 탭의 Bash PostToolUse 카드가 stdout 본문을 카드 안에 inline으로 표시하지 않음. 사용자는 명령 결과를 보려면 별도 카드 expand나 Claude 응답 bubble의 인용을 봐야 함. **회귀 아님** — 기존 디자인 의도일 수 있으나, 짧은 stdout(예: `ls -la` 결과)은 카드 안에 inline 노출하는 게 일반적 expectation. 임계치 기준 (예: 첫 20줄 또는 2KB까지) inline rendering 추가 검토.

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
