# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

### Voice
- [ ] `VoiceButton`이 iOS/Android에서 `null` 반환 — 네이티브 오디오 캡처/재생 미구현 (expo-av 등 필요)

### Windows
- [ ] Bun `bun:sqlite` Windows finalizer 지연 — Bun 1.3.12 업그레이드 및 `Store.deleteSession`의 double-GC(`Bun.gc(true) → sleep 50ms → Bun.gc(true)`) 보강에도 불구하고 Windows CI에서 `unlinkRetry`의 모든 retry(1.575s budget)를 소진해도 lock이 풀리지 않는 케이스 확인됨. 실제 timeout 문제가 아니라 lock 자체의 지속성 문제라, retry budget을 키우면 다른 `auto-cleanup` 테스트들이 연쇄 timeout. `store-cleanup.test.ts`의 2개 테스트는 `describe.skipIf(win32)`로 skip 유지. 추가로 `auto-cleanup.test.ts` 전체와 `store-cleanup.test.ts`의 `pruneOldSessions removes error sessions` 테스트도 Windows CI 속도 개선을 위해 skip 확장 (macOS/Linux에서 동일 경로 검증됨). Bun upstream issue [oven-sh/bun#25964](https://github.com/oven-sh/bun/issues/25964) (WAL mode file lock on Windows after close) 해결 시 재시도 — 2026-04 현재 open, assignee/milestone 없음.
- [ ] **`checkForUpdates` Windows CI flake** — `apps/cli/src/lib/check-for-updates.test.ts` 의 두 테스트 (`treats unknown schema version as cache miss`, `writes cache after running so failed network calls still rate-limit`) 가 5초 타임아웃으로 산발적으로 fail. PR #154, #136, #158 에서 재현 — 모두 첫 실행 fail / rerun pass 패턴. Cache write/read 의 fs sleep 가 Windows tmp dir 에서 jitter 발생하는 것으로 추정. Mac/Linux 에서는 안정. 임시 해결: rerun. 근본 해결: 두 테스트의 timeout 을 5s → 10s 로 늘리거나, fs.writeFile 호출을 fakeTimer 로 격리.

### 미검증 항목 (잠재 이슈)
- [ ] Push Notifications 실기기 미검증 — Simulator에서는 push token 생성 불가, 실제 iOS/Android 디바이스에서 E2E 테스트 필요
- [ ] Windows PTY/IPC 실환경 미검증 — CI unit test만 통과, 실제 Windows 환경에서 `tp` passthrough + daemon 동작 E2E 검증 필요 (유저가 Windows 개발 환경 제공 시 진행 예정)
- [ ] Windows install.ps1 실환경 미검증 — PowerShell 설치 스크립트 (v0.1.9 기준), 실제 Windows 기기에서 `irm ... | iex` → `tp version` → `tp upgrade` 플로우 확인 필요 (유저가 Windows 개발 환경 제공 시 진행 예정)
- [ ] Session Export 대규모 세션 성능 미검증 — 10,000+ records 세션에서 export 속도/메모리 사용량 확인 필요 (현재 limit 50,000)

### 발견된 버그

- [x] ~~**Bug #1 (PR #146 QA) — zombie sessions**~~: stopped 세션이 앱 세션 리스트에 배너/상태 표시 없이 살아 있고, Chat 입력이 비활성화되지 않음. ⇒ CLI 정리: PR #150 (`tp session list/delete/prune`, merged). 앱 UI 상태 배너/입력 disable: PR #151 (merged).
- [x] ~~**Bug #2 (PR #146 QA) — Chat 무반응**~~: `sendChat()` optimistic user message 미적용 (`apps/app/src/lib/relay-client.ts:440`) + 세션 진입 시 ChatView 타이머가 kx 완료 전 `resume()` 호출로 drop (`apps/app/app/session/[sid].tsx:131`). ⇒ (a) optimistic bubble: PR #148 (merged). (b) kx-race pending queue: PR #149 (merged).
- [x] ~~**Bug #3 (PR #146 QA) — Terminal blank on stopped**~~: stopped 세션 진입 시 과거 io records replay 가 없어 완전 빈 화면. ⇒ PR #151 fallback 배너 + 안내 (merged).
- [x] ~~**신규 (PR #146 QA) — control.unpair decrypt-fail toast flood**~~: pairing 삭제 시 daemon 이 모든 frontendId 로 암호화 broadcast. 자신의 키가 아닌 frame 의 decrypt fail 이 에러 토스트로 노출됨. ⇒ `sid=__control__` decrypt fail 을 debug 로 격하: PR #147 (merged).

#### QA 관찰 원본 (PR #146 세션 기록)

<details>
<summary>Web Playwright live QA 2026-04-23 — 세부 관찰 / 재현 절차 / 스크린샷 경로</summary>

- [관찰 — web QA 2026-04-23] 데몬이 실제로 4개의 stopped 세션을 보유 확인
  - 재현 절차: `tp status` 실행 → 5개 세션 표시 (1 running, 4 stopped)
  - 증상: session-1776878046400(11m ago), session-1776877958296(6m ago), session-1776759230491(1d ago), session-1776617541450(3d ago)
  - 가설: 앱의 세션 리스트가 daemon에서 받은 전체 세션 목록을 그대로 표시 (running/stopped 구분 UI 없음)

- [관찰 — web QA 2026-04-23] 세션 구독 및 데이터 흐름 분석 (Bug #2 & #3 공통 원인 가설)
  - 재현 절차: 코드 트레이스 (app/_layout.tsx → useRelay → relay-client.ts)
  - 가설: 버그 #2 & #3은 동일 root cause — resume 메시지가 daemon에 도달하지 못하거나 E2EE 해독 실패
  - 코드 위치: `apps/app/src/lib/relay-client.ts:506-510`, `apps/app/src/hooks/use-relay.ts:149-156`, `apps/app/app/session/[sid].tsx:126-134, 138-164`

- [관찰 — web live QA 2026-04-23] Bug #1: 웹에서도 5개 세션 모두 표시됨, running/stopped 색상 구분은 존재
  - 재현 절차: web-qa 페어링 완료 → Sessions 탭 → 5개 세션 모두 목록에 나타남
  - 증상: 세션 뷰 내부에 "stopped" 상태 배너 전혀 없음. stopped 세션 클릭 시 chat 입력창이 그대로 활성화됨
  - 스크린샷: /tmp/qa-live-02-sessions.png

- [관찰 — web live QA 2026-04-23] Bug #2: Chat 무반응 원인 세분화 — optimistic update 없음 + kx-race
  - 재현 절차: web-qa 페어링 → /session/session-1776878046700 직접 이동 → Chat 입력 "HELLO QA TEST" → send 버튼 클릭
  - 증상: `relay.pub {t:"in.chat"}` 프레임은 relay로 정상 전송됨. 전송 후 15초 동안 daemon 으로부터 응답 0개. User message bubble 미표시. Chat 탭 "Listening to Claude Code..." 고정.
  - 가설 (확정):
    1. `sendChat()`이 chat-store에 optimistic user message를 추가하지 않음 (`apps/app/src/lib/relay-client.ts:440`)
    2. 세션 진입 시 새 WS kx 완료 전 500ms timer 가 `resume()` 호출 → `sendEncrypted` 내 `not authenticated` 체크로 drop (`apps/app/app/session/[sid].tsx:131`, `apps/app/src/lib/relay-client.ts:398-399`)
  - 스크린샷: /tmp/qa-live-06-after-30s.png

- [관찰 — web live QA 2026-04-23] Bug #3: Terminal 탭 — running 세션은 정상, stopped 세션은 완전 빈 화면
  - 재현 절차: /session/session-1776878046700 (running) → Terminal 탭 vs /session/session-1776877958296 (stopped) → Terminal 탭
  - 증상: running 세션은 Claude `--help` 스크롤백 정상 렌더링. stopped 세션은 완전 빈 화면 (흰색 커서만).
  - 가설: resume frame 이 dropped 되면 daemon 이 io records 를 재전송하지 않아 Terminal 이 빔.
  - 스크린샷: /tmp/qa-live-06-terminal.png, /tmp/qa-live-07-stopped-terminal.png

- [관찰 — web live QA 2026-04-23] 신규 버그: control.unpair broadcast 시 decrypt flood
  - 재현 절차: web-qa 페어링 → `tp pair delete daemon-moac2h7d -y` → 앱 화면 관찰
  - 증상: daemon 이 15개 frontendId 에 broadcast → 본인 키 아닌 14개 `[FrontendRelay] decrypt failed for sid=__control__` → 각 decrypt fail 이 에러 토스트로 사용자에게 노출됨
  - 스크린샷: /tmp/qa-live-14-after-delete.png

- [관찰 — regression QA 2026-04-23 (after merges)] 5 fix PASS 검증
  - Fix #2-a (PR #148): 옵티미스틱 버블 ~100ms 이내 표시 — `/tmp/qa-regress-fix2a-final.png`
  - Fix #2-b (PR #149): cold navigation 후 ~4s 내 콘텐츠 로드, `relay-client.test.ts` 35 pass (kx-race flush 회귀 테스트 포함)
  - Fix #1/#3 UX (PR #151): "Session ended — read-only view" 배너 + placeholder 교체 + "No terminal output captured..." 폴백 — `/tmp/qa-regress-fix3-stopped-session.png`, `/tmp/qa-regress-fix3-terminal-tab.png`
  - Fix #4 (PR #147): `tp pair delete` 후 decrypt fail 은 `[debug]` 로만 남고 토스트 미발생 — `/tmp/qa-regress-fix4-after-unpair.png`
  - Fix #5 (PR #150): `tp session list/delete/prune` 서브커맨드 정상 동작 (source-daemon 교체 후 end-to-end 확인)

</details>

---

## 🛠 리뷰 기반 구조 개선 (2026-04-20 전체 리뷰)

우선순위 순. 각 항목 말미의 `[group: X]`는 병렬 수행 그룹.

### Phase 1 — 완료 (2026-04-20)
- [x] **CLAUDE.md Tier 1–3 테스트 목록 재동기화** — PR #116. 실제 66개 테스트 파일과 동기화.
- [x] **IPC / relay control 경계 스키마 가드 도입** — PR #120. `parseIpcMessage` / `parseRelayControlMessage` 2개 guard 도입, `daemon.ts` 내 `as unknown as` / `Record<string, unknown>` 전부 제거 (14개 narrowing cast 제거). 50개 guard 테스트 추가.
- [x] **`apps/app/src/lib/relay-client.ts` 단위 테스트** — PR #118. 26개 테스트 (E2EE roundtrip, ECDH, ratchet, WS 상태머신, reconnect 백오프).
- [x] **`apps/app/src/lib/{secure-storage, crypto-native, crypto-polyfill}.ts` 단위 테스트** — PR #119. 21개 테스트. `apps/app/tsconfig.json`에 `*.test.ts` exclude 추가해 bun:test TS2307 해소.
- [x] **zustand 스토어 핵심 로직 테스트** — PR #121. 57개 테스트 (pairing v2→v3 migration, session store multicast, chat streaming). v2 migration 제거 전 안전망 확보.
- [x] **`apps/cli/src/lib/ipc-client-windows.ts` 문서화** — PR #117. 호출 체인과 참고 구현을 주석으로 명시.

### Phase 1 follow-up (land-on-reality)
- [x] **Windows CLI pair flow 실제 구현 (2026-04-20)** — `apps/cli/src/lib/ipc-client-windows.ts`의 스텁 `throw`를 제거하고 실제 Named Pipe 클라이언트로 교체. `packages/runner/src/ipc/client-windows.ts`의 `connectWindows`와 동일한 전략(Bun native pipe → `node:net` fallback). Windows 전용 단위 테스트를 `apps/cli/src/lib/ipc-client-windows.test.ts`에 추가 (`describe.skipIf(process.platform !== "win32")`). `pair-blocking.test.ts`는 Windows에서도 실행되도록 skip을 풀고 Named Pipe 경로 대응을 추가. `pair.test.ts`의 list/delete 스위트는 SQLite 파일 핸들 지속 이슈(위 Windows 섹션의 bun#25964)로 여전히 Windows skip 유지 — IPC와 무관한 별도 문제. `ipc-client.test.ts`의 POSIX 전용 테스트는 `\\.\pipe\...` 경로 요구 때문에 Windows 스킵 유지, 그 대체가 새로 추가한 `ipc-client-windows.test.ts`.

### Phase 2 — 완료 (2026-04-20 ~ 2026-04-21)
`daemon.ts` 1190 → 464 LOC (-61%). 3개 추출 모두 완료, 후속 리뷰-픽스 루프(5-pass) PR #128로 마감.

- [x] **C1: `IpcCommandDispatcher` 추출 (2026-04-20)** — PR #123. `onMessage` + relay control / worktree / session export 라우팅을 `packages/daemon/src/ipc/command-dispatcher.ts`로 분리. B1(PR #120)의 타입드 경계 위에서 cast 재도입 없이 분해.
- [x] **C2: `RelayConnectionManager` 추출 (2026-04-20)** — PR #124. `relayClients` 풀, 연결/재연결, push fan-out, `buildEvents`/`attachHandlers`/`registerClient` DI 지점을 `packages/daemon/src/transport/relay-manager.ts`로 분리.
- [x] **C3: `PairingOrchestrator` 추출 (2026-04-20)** — PR #125. `pendingPairing` 단일 슬롯 상태머신 + `begin`/`cancel`/`promote`/`clearPending`/`stop` lifecycle을 `packages/daemon/src/pairing/pairing-orchestrator.ts`로 분리. RelayClient 생성은 `relayManager`에 위임.
- [x] **Phase 2 review-fix loop (2026-04-21)** — PR #128. 5-pass 리뷰→수정 반복. 핵심 수정: `clearPending`/`stop`에서 orphan RelayClient 명시적 dispose (리소스 누수 차단), `RelayConnectionManager.removePairing`의 concurrent `indexOf` 재조회 race 수정, `toWsSessionMeta` 공유 헬퍼로 중복 제거, `RelayConnectionManager` 전용 테스트 10개 신설.

### Phase 3 — 완료 (2026-04-21)
- [x] **D1: `pairing-store.ts` v2 마이그레이션 제거 (2026-04-21)** — PR #126. `apps/app/src/stores/pairing-store.ts`의 v2→v3 migration 블록을 제거. A4(PR #121) 테스트가 안전망.
- [x] **Windows CLI IPC 실제 구현 (2026-04-21)** — PR #127. `apps/cli/src/lib/ipc-client-windows.ts` Named Pipe 클라이언트 실구현 + `pair-blocking.test.ts` Windows 복원.

---

## 🧹 Simplify Pass (2026-04-21)

3-agent 병렬 리뷰(reuse / quality / efficiency) 결과 도출된 정리 작업. 하위호환성은 신경쓰지 않고 정리 — 채택 그룹 A(안전/명확) + B(범위 있음) 전부 진행.

### 그룹 A — 완료
- [x] **A1: `formatAge` 3중 중복 제거** — `apps/cli/src/lib/format.ts`로 이동 + 테스트.
- [x] **A2: `resolveTpBinary` 3플랫폼 중복 제거** — `lib/paths.ts` 단일화, 플랫폼 모듈에서 re-export.
- [x] **A3: `getConfigDir` 통일** — `lib/paths.ts`로 이동, 5곳 인라인 제거, Windows APPDATA/XDG 일관성 수정.
- [x] **A4: `daemon-status.ts` stale-socket 오탐 수정** — `isDaemonRunning()` connect-probe로 교체 (status 커맨드도 동일 처리).
- [x] **A5: `waitForDaemonReady` 추출** — `ensure-daemon.ts`의 폴링 루프 2중 중복 제거.
- [x] **A6: `SessionState.connected` 제거** — `useAnyRelayConnected()` 파생 훅 도입; N-daemon last-write-wins 버그 수정.
- [x] **A7: relay-client publish helper 통합** — `sendEncrypted`/`broadcastEncrypted`/`sendControl` 내부 helper, ~140줄 축소.
- [x] **A8: `FrameDecoder` O(N²) 수정** — 빈 버퍼일 때 copy 스킵, 핫패스 O(N) 유지.
- [x] **A9: `reconnectSavedRelays` 병렬화** — `Promise.allSettled`로 N× handshake 지연 제거.
- [x] **A10: `QueuedWriter` 큐 크기 제한** — 8 MiB 기본 cap + overflow 플래그.
- [x] **A11: `Store.sessionDbs` LRU 캡** — 32-slot LRU, evict 시 `SessionDb.close()` 호출.
- [x] **A12: CLI dynamic imports** — per-subcommand dynamic import로 `tp version/status` startup cost 제거.
- [x] **A13: `checkForUpdates()` 범위 축소** — `upgrade/doctor/pair/passthrough`만 호출, 나머지 스킵.

### 그룹 B
- [x] **B1: 레거시 `pairing.json` 마이그레이션 제거** — unlink 블록 + 상수 + 테스트 제거.
- [x] **B2: CLI `pair delete`/`pair rename` → daemon IPC 이관 (2026-04-21)** — "daemon must be stopped" 제약 제거. daemon이 running이면 새 `pair.remove`/`pair.rename` IPC를 보내 daemon이 기존 RelayClient로 peer notify + store 업데이트를 한 번에 수행. daemon이 running이 아니면 store를 직접 수정 (fallback). `RelayConnectionManager`에 `renamePairing` 메서드 신설 + `removePairing`이 notify된 peer 수를 반환하도록 시그니처 변경. 프로토콜에 `IpcPairRemove{,Ok,Err}` / `IpcPairRename{,Ok,Err}` 타입 + `parseIpcMessage` guard 확장. 단위 테스트 6 (dispatcher) + 4 (RelayConnectionManager) + 6 (ipc-guard) 추가.
- [x] **B3: IPC 바이너리 프레이밍 (io records) (PR #136)** — `encodeFrame(data, binary?)` + `FrameDecoder`가 `{ data, binary }` 튜플을 반환하도록 codec 확장. 프레임 헤더가 8 bytes(u32 jsonLen + u32 binLen)로 커졌고, binLen=0이면 JSON-only. Runner의 `Collector.ioRecord`는 이제 `{ msg, binary }`를 반환해 PTY 바이트를 base64 인코딩 없이 sidecar로 전송 (~33% 오버헤드 제거). Daemon의 `handleRec`은 binary sidecar가 있으면 그대로 Store에 쓰고, 상위 relay 전송 시에만 한 번 base64 인코딩. IPC만 적용 — WS 경로(Daemon↔Relay)는 여전히 JSON+base64 (별건).
- [x] **B4: Relay 상태 TTL eviction** — offline 1시간 후 `daemonStates` + `recentFrames` evict.
- [x] **B5: `cacheFrame` 배치 업데이트** — Map in-place mutate + 120ms throttled flush; PTY 버스트 시 rerender 폭주 해소.
- [x] **B6: ANSI strip 추출** — `lib/ansi-strip.ts` + 7 단위 테스트.
- [x] **B7: 하드코딩 hex → `tp-*` 토큰** — `lib/tokens.ts`에 palette + `TERMINAL_COLORS` 중앙화.
- [x] **B8: `swallow(err)` helper** — `lib/swallow.ts` 추가. 개별 callsite 전환은 점진적.

---

## Future

- [ ] Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토
- [ ] libghostty 네이티브 RN 모듈 (iOS: Metal, Android: OpenGL) — WebView 제거, GPU 렌더링
- [ ] Expo Go 드롭 → development build 전용 (Apple Watch, 네이티브 crypto, 네이티브 터미널 등)
- [ ] Apple Watch 컴패니언 앱 — 세션 상태 모니터링, 빠른 명령 전송
- [ ] 글로벌 키보드 단축키 (Cmd+K, Cmd+1/2/3 등) — useKeyboard 훅 확장
- [ ] 게임패드(8BitDo 등) 내비게이션 — Web Gamepad API 기반 D-pad 포커스 이동, A/B 버튼 매핑, useGamepad 훅. 네이티브는 MFi/Android InputDevice 모듈 필요
- [ ] 게임패드 음성인식 트리거 — 특정 버튼으로 VoiceButton 토글 (useInputAction 추상화로 키보드/게임패드/음성 통합 액션 시스템)
- [ ] **macOS 바이너리 Developer ID signing + notarization** — 현재 `tp` (bun SEA) 는 Jarred Sumner (bun runtime) 의 서명을 그대로 상속. 사용자가 launchd daemon 을 등록하면 macOS Login Items & Extensions UI 에 "Jarred Sumner" entry 가 표시되는 UX 이슈. 0.x 에서는 S1 (수용) 로 합의했고, 1.0 블로커로 승격 예정. 필요: (a) Apple Developer Program 가입 ($99/yr), (b) release.yml 에 `codesign` + `notarytool` + `stapler` 단계 추가, (c) darwin 바이너리에 자체 Developer ID 서명 후 notarize. 영향 범위는 macOS darwin_arm64/x64 릴리즈 아티팩트만. Linux/Windows 는 무관.
