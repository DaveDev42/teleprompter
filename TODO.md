# Teleprompter TODO

## 🔧 미비한 점 — 현재 남아있는 이슈

> **재작성 컨텍스트 (ADR-0001):** 아래 완료된 항목들은 Expo 스택 기준이다.
> Expo 앱(`apps/app`)은 제거됨. Chat/Terminal UI 이슈는 Swift 재작성(Phase 3)에서 재구현 예정.

### Chat / Terminal UI (Expo 스택 완료 이력 — 재작성 대상)
- [x] **터미널이 UTF-8 입력 시 깨짐** — Expo 스택에서 PR #455로 해결. Swift 재작성 시 재구현.
- [x] **Chat UI 가 PTY raw 출력을 그대로 노출** — hooks-only 전환 완료 (PR #457). Swift 앱도 동일 설계 적용 예정.
- [x] **Chat auto-scroll 이 사용자 스크롤 의도를 무시** — PR #457로 해결.
- [x] **`tp --resume` 세션이 첫 메시지 보내기 전까지 history 비어보임** — PR #457로 해결.
- [x] **Sessions bulk-delete 에 "Select all" 토글 부재** — PR #458로 구현.
- [x] **Sessions 리스트가 resume-reconnect 후 stale** — PR #584로 해결.
- [x] **Session row 제목이 cwd basename 만 표시** — PR #586로 해결 (`formatCwd` 로직).
- [x] **Sessions Refresh 버튼이 in-flight 상태를 보조기기에 알리지 않음** — PR #588로 해결.

### Voice (Expo 스택 완료 이력 — 재작성 대상)
- [x] `VoiceButton` 네이티브 오디오 — Expo 스택에서 react-native-audio-api 0.12.2로 구현 (2026-06-11). Swift 재작성 시 AVFoundation/Swift Concurrency 기반으로 재구현 예정 (Phase 3).
- [x] **온디바이스 voice 백엔드 + 선택형 토글 (2026-06)** — `VoiceBackend` 프로토콜 seam 뒤로 두 백엔드: (a) **온디바이스(오프라인)** = `SFSpeechRecognizer` STT(`requiresOnDeviceRecognition` 지원 시 강제, 무음 타이머 VAD) + **Foundation Models** refine/요약(iOS 26+, `SystemLanguageModel.default.availability` 게이트 + 원문 transcript fallback) + `AVSpeechSynthesizer` TTS, **API 키 불필요**, (b) **OpenAI Realtime**(키 필요, 기존 `RealtimeClient`을 `RealtimeClientBackend` 어댑터로 무변경 보존). Settings 토글(Auto/On-device/OpenAI), 키 없으면 온디바이스 기본값. `VoiceConnectionStatus` 상태머신은 `VoiceStore`가 단독 소유 — `onRefinedPrompt`에서 `.listening` 복원(processing 멈춤 over-fit 수정). `VoiceButton` 게이팅 = 온디바이스 가용 OR 키 존재. `NSSpeechRecognitionUsageDescription` 추가. macOS+iOS smoke 8/8 + XCTest 98/98 green. (실기기 STT 턴 QA = 후속 — Sim/macOS는 마이크 없음.)

### Post-merge correctness audit — #683 voice + #684 shortcuts (2026-06)
- [x] **머지 후 적대적 정합성 감사 → 6개 confirmed 버그 수정 (2026-06)** — #683/#684 머지 직후 4-lens(state-machine / integration-wiring / platform-availability / focus-input-safety) 적대적 감사 워크플로(각 finding 독립 3인 회의·다수 반박 시 기각, 25 에이전트). 7 candidate→7 confirmed→0 기각. 수정(6개 distinct):
  - **voice gen-guard 2건** — `VoiceStore.onRefinedPrompt`에 형제 핸들러와 동일한 `generation == gen` 가드 추가 (dispose 후 버퍼된 OpenAI `response.text.done`가 stale 프롬프트 재전송 + `.idle`→listening 부활하던 레이스 차단); 소스단 belt-and-suspenders로 `RealtimeClient.handleMessage` 상단 `guard !disposed`. `OnDeviceVoiceClient.handleRecognition`에 `gen` 파라미터 추가(task 생성 시점 캡처) — `rearm()`가 generation을 bump한 뒤 옛 recognitionTask의 늦은 `isFinal` 콜백이 utterance를 2번 commit하던 중복 제출 차단.
  - **AVAudioEngine tap 데이터 레이스** — 오디오 렌더 스레드의 tap 클로저가 `@MainActor` 격리 `self.request`를 cross-thread로 읽던 것을 로컬 강참조 `req` 캡처로 교체(UAF/레이스 제거; `removeTap`가 전달 경계 보장).
  - **`hasActiveDetail` 라이프사이클 레이스** — bare `Bool`(인스턴스별 onAppear/onDisappear 토글)을 `AppNavigationModel`의 depth 카운터(`activeDetailCount`, `detailAppeared/Disappeared`)로 전환 — ⌘[/⌘] 세션 전환 시 appear-before-disappear 순서가 플래그를 stuck-false로 남겨 macOS 세션 커맨드 전부 비활성화하던 것 해소.
  - **ShortcutHelpSheet iOS 도달 불가** — ⌘/가 `MacCommands`(macOS 전용)에만 배선돼 iOS/iPadOS/visionOS에서 도움말 시트가 dead였음 → `RootView.tabNavShortcuts`에 hidden ⌘/ 버튼 추가.
  - **터미널 first-responder가 focus 게이트 우회** — SwiftTerm view(UIView/NSView)가 키스트로크를 받는데 `composerHasFocus`(SwiftUI `@FocusState`)에 반영 안 돼 ⌘[/⌘]/⌘K가 라이브 PTY 키 입력을 가로채던 것 → `terminalPaneActive` + `inputCapturing`(=`composerHasFocus || terminalPaneActive`) 2-tier 게이트. 이동 chord(⌘[/⌘]/⌘K)는 `inputCapturing` 게이트, 페인 전환(⌃⌘C/⌘T)은 `composerHasFocus`만 게이트(터미널 탈출용 escape hatch 보존). macOS/iOS 양쪽 동일 적용.
  - 검증: macOS smoke 8/8 + iOS smoke 8/8 + XCTest 104/104(98+6 TpCore), 적대적 재검증 6/6 PASS(no regression).

### 미검증 항목 (완료)
- [x] **Push Notifications 실기기** — APNs push token 발급 + 알림 왕복 E2E 실기기 검증 완료 (2026-06-07, build #59).
- [x] **N:N 다중 daemon/frontend 회귀** — 2×1 및 2×2 N:N 회귀 테스트 완료.
- [x] **Linux daemon install** — Lima Ubuntu VM에서 systemd 풀 사이클 검증 완료 (Q5 PASS 2026-06-07).
- [x] **passthrough claude 서브커맨드 wiring 검증** — integration test 17건 완료 (#438).
- [x] **Long-running 안정성 (1시간 soak)** — 2026-06-03 실측 1h SOAK PASS. (`scripts/soak.ts`)
- [x] **iOS 실기기 검증 (Expo)** — Q1·Q2 PASS 2026-06-07. Swift 재작성 후 Simulator 검증으로 전환.
- [x] **Android QA (Expo)** — Q3 PASS 2026-06-05 (Pixel_8 AVD). Android 재작성은 Phase 3 이후 별도 결정.

### 인프라 한계로 미검증 (완료)
- [x] **Windows under WSL** — Q7 PASS 2026-06-05. 상세는 `docs/local-verification-queue.md` Q7.

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

## 🌟 재작성 트랙 (ADR-0001)

- [x] **Phase 2: Rust `tp-core` + Swift FFI** — codec/crypto/pairing Rust 구현 + UniFFI xcframework, Swift 앱에 링크, encode→encrypt→decrypt→decode 라운드트립 Simulator 검증 (완료)
- [x] **Phase 3: Swift 앱 기능 parity** — pairing(QR/manual), relay client(WS), 세션 CRUD, Chat(hooks-only rich rendering + composer), 터미널(SwiftTerm 인터랙티브 — 입력/resize/scrollback), Notifications/UX(toasts·live regions·shortcuts), Voice(AVFoundation + OpenAI Realtime, mic→PCM16 24kHz→WS→playback + terminal-context). 옛 Expo 컴포넌트 전부 네이티브 대응 (유일 예외 `UpdateBanner` = EAS OTA 제거로 의도적 폐기). Tranche A–G 전부 머지 (#665/#666 Voice). (완료)
  - [x] **Phase 3 parity 정정 감사 (2026-06)** — Tranche A–G 머지 후에도 *unwired/오결선* 으로 실제 동작이 깨져 있던 39건을 멀티에이전트 감사로 적발(Expo baseline `93ee41d` 대조, 적대적 재검증 39 confirmed / 10 rejected) 후 전수 수정. Batch A–E 머지(#671–#675): Chat composer 미표시·user 버블 미렌더(`PrePrompt`→`UserPromptSubmit`)·세션 ghost row·daemon 재시작 시 E2EE 영구 단절(kx 재교환)·auto-reconnect 부재·inbound control 무시·dead banner·stub diagnostics 등. smoke(boot/encrypt happy path)로는 못 잡는 UI 결선 버그였음. SoT = `docs/native-parity-audit-2026-06.md`. (완료)
  - [x] **Chat/Terminal pane UX rework (2026-06)** — pane 컴포넌트/UX 재작업. (1) 공유 입력-라인 chrome(`SessionComposerChrome`) + **입력 의미론 분리** 2종 컴포저: `ChatComposer`(멀티라인 prompt + voice + autocorrect) vs `TerminalComposer`(raw keystroke/제어시퀀스 전달 + **실용 키-row** ⎋⇥⌃↑↓←→ /-~|: + Ctrl-arm + autocorrect off). (2) `SessionDetailView` **탭 전용** 전환(`.page` 스와이프 pager 제거 — 채팅 세로 스크롤/터미널 pan 제스처 충돌 해소, Expo와 동일하게 탭-only), cross-fade. (3) `DiagnosticsView` **relay-URL 그룹핑** — GLOBAL(relay 무관: build/platform/tp-core/crypto/session 합계) vs relay endpoint별 섹션(그 relay의 daemon WS/E2EE/RTT), 페어링 0개 친절한 빈 상태. (4) QR 카메라 미가용 안내를 Simulator/macOS 별로 명확화. macOS+iOS smoke 8/8 + XCTest 98/98 green.
- [ ] **Phase 4: 백엔드 Rust 이관** — [ADR-0003](docs/adr/0003-phase4-backend-rust-migration.md) **Accepted (2026-06-17, Dave)**, staged dual-run cutover. **진행 상태 (실제): 전 조각(relay/CLI/runner/daemon) 포팅 완료 + #4 flip 구현 완료(PR #922, soak-merge 대기). 잔여 = #4 soak-merge → #5 Bun 삭제 캐스케이드.**
  - [x] **Stage 0 — 메시지 타입 골든벡터** ✅ (`tp-proto`, 106-케이스 green, 2026-06-18)
  - [x] **Stage 1 — relay** ✅ **프로덕션 라이브** (`tp-relay` 12k LOC axum/tokio, Step 2–8c 완료 → live cutover #716, `relay.tpmt.dev` = Rust relay, **TS relay 퇴역**, 10k soak 하니스)
  - [x] **CLI 전체 포팅** ✅ (Amendment 2, `tp-cli` 4k LOC, tranche 0–5 + #5 hard-swap → dogfood `tp` = Rust 바이너리, Bun `tpd` blob 로 daemon/passthrough 트램폴린)
  - [x] **runner** (`packages/runner`, 763 LOC, PTY + hooks) ✅ **포팅 완료** (`tp-runner`, inc1~4 머지 #882/#883/#884/#890, dual-run seam `TP_RUNNER_BIN` + 실 claude 파리티 게이트 `TP_E2E_RUNNER_BIN`). **#4 flip 완료**(PR #922, `db83b32a`, soak-merge 대기): daemon 이 `tp_proto::locate_tp_runner()` 로 Rust `tp-runner` 를 기본 spawn(`["bun","run"]` placeholder 제거).
    - [x] **증분 1 — 스캐폴딩 + 순수 조각 + PTY spike** ✅ — `rust/tp-runner` 크레이트(workspace member), byte-exact `capture_hook_command`(golden) + `build_settings`(hook 머지), `collector`(io = 바이너리 사이드카 `payload="" `/event = base64), **portable-pty PTY spike**(spawn/read/write/resize/kill + reader-thread hop, echo/cat 라운드트립 통과 → **ADR §6.1 "최대 기술 미지수" 해소**). 12 테스트 green, workspace clippy(`all=deny`)·fmt clean. `main.rs` 는 아직 프로덕션 미결선(비-제로 exit).
    - [x] **증분 2 — async 오케스트레이션** ✅ — tokio 단일스레드 런타임. `ipc`(framed codec, into_split writer/reader task, decode-throw teardown + inbound allowlist ack/input/resize + overflow→close 불변식) + `hooks`(UnixListener, sid traversal 가드, per-conn accumulate + **1 MiB UTF-8 바이트 cap** + atomic stale-socket 제거 + mode-0700 parent) + `socket`(XDG/`/run/user/<uid>`/`/tmp` writer-semantics 런타임 dir) + `wire`(hello/bye — pid 생성 가드 + reason signal/exit disambiguation, TS key-order byte-exact) + `runner::run`(`select!` 루프: io/hook→rec, ack/input/resize, PTY exit/IPC close/SIGINT·SIGTERM→bye, graceful bye-flush tick) + `main.rs` argv 파싱(`--sid/--cwd/--socket-path/--worktree-path/--cols/--rows -- <claude args>`, dim clamp, sid fallback) + `tokio::signal` 130/143 매핑. **E2E 통합 테스트**(스텁 daemon + `TP_RUNNER_CLAUDE_BIN` 가짜 claude → hello→io rec(binary sidecar)→bye reason=exit 검증). 27 테스트 green(23 lib + 3 argv + 1 e2e), workspace clippy(`all=deny`)·fmt clean. **cutover 없음** — daemon 은 여전히 Bun runner(`tpd run`) spawn.
    - [x] **증분 3 — daemon `TP_RUNNER_BIN` seam + wire-parity 게이트** ✅ (PR #884, main=`1c85560e`) — opt-in `TP_RUNNER_BIN`(절대 경로) 이 CLI 의 runner command 를 세션별로 Rust `tp-runner` 단일-요소 argv 로 바꾼다 (`resolveRunnerBinOverride` → `resolveRunnerCommandWithOverride`; 잘못된 경로 = fail-loud, 조용한 Bun fallback 없음; relay-originated `session.create` 엔 안 닿음 — daemon 프로세스 env 전용). 양쪽 runner 에 `TP_RUNNER_CLAUDE_BIN` seam (Bun runner.ts:108 + Rust runner.rs:113) 으로 differential 하니스가 같은 가짜 claude 를 구동. **wire-parity 게이트** (`runner-parity.test.ts`): Bun/Rust 두 runner 를 같은 fake claude(고정 stdout·exit 7)로 돌려 프로덕션 `FrameDecoder` 로 프레임 캡처 → hello/bye 를 pid/ts 제외 byte-equal + **JSON 키 순서**(placeholder 재직렬화) equal, io 는 `payload=""` 사이드카 불변식 + concat 바이트스트림 byte-equal 로 검증 (Rust 바이너리 미빌드 시 SKIP). **cutover 없음** — 기본은 여전히 Bun runner. 세부 케이스: `runner-bin.test.ts`(5) + `spawn.test.ts`(override) + `session-manager.test.ts`(단일-요소 argv shape) + `runner.test.ts`(claude-bin seam).
    - [x] **증분 4 — 실 claude 파리티 *증명* 게이트 (Scope B) ✅ 머지** — default flip 은 #4(아래 별도 항목)에서 완료. `runner-parity.test.ts`(fake claude byte-exact)가 결정론 레이어라면, 이 게이트는 **실 claude 세션을 Rust `tp-runner` 로 구동**해 실전 파리티를 증명한다. **핵심 발견**: 실 claude E2E 세션은 daemon 의 `SessionManager` 가 아니라 **holder(`real-daemon-pair.ts`)가 `tp run` 으로 직접 spawn** 하는 standalone 프로세스라 inc3 seam(daemon-spawn 전용)이 무효 → holder 에 자체 `runnerCmd()` 추가(4개 spawn 사이트 경유; Rust runner 는 `run` 서브커맨드 없이 동일 argv). 배선: `TP_E2E_RUNNER_BIN=1`(다른 claude 게이트와 직교) → `build_rust_runner_bin`(release) → env-prefix `TP_RUNNER_BIN="$REAL_RUNNER_BIN"`(리터럴 assignment) holder 주입 → holder 가 `RUNNER_PARITY_BIN=<path>` emit → `assert_runner_parity` 가 positive proof + 세션 DB `kind='io'` rows≥1 어서션. committed 로컬 프레임-diff 하니스 `scripts/runner-parity-real-claude.ts`(`TP_RUNNER_PARITY_REAL_CLAUDE=1`). **CI backstop**: ci.yml `test` job 이 `cargo build --release --bin tp-runner` 로 `runner-parity.test.ts` SKIP→RUN 상시화. **cutover 없음** — `resolveRunnerCommand()` 미변경, 기본 Bun. SoT = `.claude/rules/native-testing.md` (`TP_E2E_RUNNER_BIN` 섹션).
    - [x] **증분 5 (flip, task #4) — 기본 runner+daemon 을 Rust 로 cutover** ✅ **구현 완료** (PR #922, `db83b32a`, N× clean 실 claude E2E soak 통과 후 merge). 실제 배선: (a) `build.ts`+`install.sh`+`release.yml` 이 `libexec/tp/tp-runner`+`tp-daemon`+`tp-relay` 를 이미 출하(#906/#898), (b) `tp_proto::locate_tp_runner()` + tp-cli `locate_tp_daemon()`(resolver 를 tp-proto 로 이동해 daemon+cli 공유 SoT), (c) plain cargo bin 은 codesign 불필요(dry-run 으로 exit-137 없음 실증 — tpd 블롭만 codesign), (d) homebrew-tap formula push 완료(`17c3e422`), (e) daemon `manager.rs default_runner_command` 가 `locate_tp_runner()` 로 Rust runner 를 기본 spawn + Rust CLI 의 background/foreground/service daemon 경로가 `locate_tp_daemon()` 으로 exec (`TP_RUNNER_BIN_DEFAULT` env-주입 방식이 아니라 resolver 직접 호출). **소크 커버리지 갭**: soak holder 는 runner 를 standalone spawn 하지 daemon 의 `SessionManager.spawn_runner` 새 경로를 안 탐 → dogfood+수동 커버.
  - [x] **daemon** (`packages/daemon`, 5.4k LOC, session/store/relay-client/pairing/push/worktree) ✅ **포팅 완료** (`tp-daemon`, inc1~6 머지 #892~#897): store(rusqlite, 포맷 동결) → ipc/session/worktree → relay-client → pairing/push/relay-manager → dispatcher + shipping `[[bin]]` + `TP_DAEMON_BIN` dual-run seam. flip-prep A1(#898, `locate_tp_daemon` + release 아티팩트) + A2(`TP_E2E_DAEMON_BIN` 파리티 게이트). **#4 flip 완료**(PR #922, `db83b32a`, soak-merge 대기): `ensure_daemon.rs` background + `commands/daemon.rs::start` foreground/service 둘 다 `locate_tp_daemon()` → Rust daemon. CI-결정론 differential 파리티 = 5× `*-rust-parity.test.ts`(store/worktree/transport/push/ipc).
  - 참고: `tp-core`(crypto+codec+pairing)는 Phase 2 에서 byte-exact 완료(앱에 링크). **PTY 크레이트 spike 는 증분 1 에서 portable-pty 로 확정·해소**. store(rusqlite 포맷 동결)·worktree 리스크는 daemon 포팅에서 해소됨. **남은 것 = #4 soak-merge + #5 Bun 삭제 캐스케이드** (`packages/*`+`apps/cli` 소스 삭제 → toolchain 제거 → 문서 정리).
- [x] **Phase B: Apple 멀티플랫폼 확장 (ADR-0002)** — visionOS 완전 경험(B2: destination + spatial UX + 하니스) + watchOS 제한 경험(B3: 별도 타깃). B0 toolchain 게이트 PASS, B1 xcframework visionOS 슬라이스 완료, B2 visionOS UX 완료(#668), B3 watchOS 별도 타깃 완료(#669 — 7-slice xcframework, TeleprompterWatch 타깃, 4-platform smoke 전부 green: iOS 8/8 · macOS 8/8 · visionOS 8/8 · watchOS 7/7).

## 🚀 배포 트랙 (TestFlight CI/CD — ADR-0004)

- [x] **5-플랫폼 TestFlight CI/CD 배포 (ADR-0004 + Amendment 1/2, 2026-06-28)** — EAS Submit 제거(ADR-0001) 후 **Apple 공식 도구만으로**(fastlane/EAS/Xcode Cloud 없이) TestFlight 배포 경로 복원. `macos-26` 러너에서 archive+서명+export 후 App Store Connect 업로드. **iOS / iPadOS / macOS / visionOS / watchOS 5플랫폼 전부 internal TestFlight 배포 완료** (build 1601, `internalBuildState=IN_BETA_TESTING` ASC 실측 확인). 토폴로지: 독립 ASC 레코드 3개(iOS/macOS/visionOS, 동일 번들 `dev.tpmt.app`) + iPadOS는 iOS `.ipa` device-family + **watchOS는 iOS `.ipa` companion 임베드**(`Payload/Teleprompter.app/Watch/`, 별도 watchOS 레코드 없음 — Apple 정식 경로 WWDC19 §208). 빌드 절반=하니스(`TP_PLATFORM=<plat> scripts/ios.sh archive`, `resolve_archive_params` 분기), 업로드 절반=워크플로(`altool --upload-app --type {ios|macos|visionos}` + ASC API 키 .p8). 트리거=`workflow_dispatch` ONLY(#125). SoT=`.github/workflows/testflight.yml` + `docs/adr/0004-*` + `.claude/rules/ci-workflows.md`.
  - **해결한 ASC 검증 이슈 (점진적 파이프라인 narrowing)**: 서명 매핑(archive+export 2단계, project.yml `[config=Release][sdk=…]` specifier + temp ExportOptions provisioningProfiles dict) → macOS installer cert(#809 exit-70) → orientation 90474(#807) → 아이콘 alpha 90717 + watch CFBundleIconName 90713(#808) → macOS App Sandbox 90296 + LSApplicationCategoryType 90242(#810) → visionOS solidimagestack back-layer @2x 90967(#810) → **CFBundleVersion 리터럴 bake 버그**(#811 — explicit INFOPLIST_FILE이 `CURRENT_PROJECT_VERSION` 리터럴 "1"을 구워넣어 archive-time `TP_BUILD_NUMBER` override를 무력화 → ASC duplicate-version 거부; `$(CURRENT_PROJECT_VERSION)` 변수 참조로 수정, 세 플랫폼 공통 잠재 버그였음).
  - **stdout 규율**: `cmd_archive` stdout이 CI에 `IPA=$(…archive)`로 캡처되므로 `cmd_gen`(xcodegen)/`build-xcframework`(uniffi-bindgen) stdout을 stderr로 redirect(#806).
- [x] **TestFlight CD 자동 dispatch (PR #798)** — 첫 수동 업로드 이후 `release.yml`의 `testflight` job이 release+bump-tap 성공 후 `gh workflow run testflight.yml --ref <tag> -f tag=<tag>`로 같은 태그를 별도 run으로 자동 dispatch(TestFlight 실패가 CLI release를 red로 만들지 않게 격리).
- [ ] ~~**External TestFlight (Beta App Review)**~~ — **보류 (사용자 지시 2026-07-06): 필요할 때 Dave 가 직접 지시.** 능동 추진 안 함. (참고: internal 은 완료, external 확장은 첫 빌드 Beta App Review 제출 `externalBuildState=READY_FOR_BETA_SUBMISSION` 필요.)

## 🌟 Future (Phase 3 이후 / 별도 트랙)

- [x] ~~Claude Code channels 양방향(output 구독) 지원 시 Chat UI 통합 재검토~~ — **포기 (사용자 결정 2026-07-06).** 추진 안 함.
- [x] Apple Watch 컴패니언 앱 — `TeleprompterWatch` 별도 타깃으로 구현(ADR-0002 B3, #669) + iOS `.ipa` companion으로 TestFlight 배포(ADR-0004 Amendment 2). 제한 경험(7마커, 입력 송신 미구현). 세션 모니터링/빠른 명령 확장은 후속.
- [x] **글로벌 키보드 단축키 (2026-06)** — `AppNavigationModel.shared` seam(분리돼 있던 RootView/MacRootView tab selection 통합)으로 macOS(`.commands`) + iPadOS(hidden `.keyboardShortcut` 버튼) 양쪽 배선: ⌘1/2/3 탭 이동, ⌃⌘C(Chat)/⌘T(Terminal) pane 전환, ⌘[/⌘] 세션 prev/next, ⌘K 퀵 스위처. `ShortcutHelpSheet`가 광고만 하고 미배선이던 단축키들을 실제 동작화(= 시트가 거짓말을 멈춤) + 미문서화 단축키(⌘F Find, ⌘⇧C, ⌘⌫) 보강 + footer 정정. ⌘C는 시스템 Copy 보존 위해 ⌃⌘C로 강등, 입력 중/세션 미오픈 시 session 단축키 비활성(`composerHasFocus`/`hasActiveDetail` 게이트, pane 전환·dismiss 시 focus 리셋). macOS+iOS smoke 8/8 + XCTest 98/98 green.
- [x] **게임패드(8BitDo/Xbox/PlayStation) MFi 내비게이션 (2026-06)** — 옛 Expo 웹 브리지(`gamepad-input-mapper.ts`/`use-gamepad-nav.ts`, PR #624)를 네이티브로 이관. 2계층: 순수 `GamepadInputMapper`(값 타입 `GamepadSnapshot`/`GamepadNavAction`, `diff(prev:next:)` 엣지 트리거, 0.5 스틱 임계, D-pad∪스틱 병합, 결정적 emit 순서)는 TS 소스 1:1 포팅(W3C down-positive-Y 컨벤션 보존, 12개 TS 테스트→11 XCTest 메서드로 포팅) + 글루 `GamepadCoordinator`(`@MainActor @Observable`, GCController connect/disconnect 관찰, iOS/visionOS=CADisplayLink·macOS=Timer 틱, 패드 식별 baseline으로 connect-press 팬텀 엣지 차단, GC→snapshot 읽을 때 Y 반전). 매핑: LB/RB=탭 순환(wrap, 디테일 열려있으면 억제), A=포커스된 세션 열기(SessionListView 로빙 `@FocusState`→`SessionNavigator.pendingSid` 푸시), B=터미널 탈출(→Chat)→디테일 pop 우선순위 체인, D-pad/스틱=Sessions 리스트 로빙 포커스(터미널 활성 시 B만 동작). `AppNavigationModel`에 `requestBack()`/`sessionBack` 인텐트 추가. watch 타깃은 화이트리스트라 새 `Sources/Gamepad/*` 자동 제외. 검증: 4-lens 적대적 리뷰(1 major canImport 가드 누락 수정 + 2 minor 문서화) → macOS build + iOS smoke 8/8 + visionOS build + XCTest 109/109(98+6 TpCore+5 gamepad) green.
- [ ] 터미널 렌더러 엔진 최종 결정 — libghostty (불안정 C API) vs SwiftTerm (Metal 아님) — Dave 결정 필요 (Phase 3 착수 전)
