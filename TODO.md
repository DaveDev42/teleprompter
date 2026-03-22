# Teleprompter TODO

## Stage 0: Foundation

### 모노레포 설정
- [x] pnpm + Turborepo 초기화
- [x] pnpm-workspace.yaml 작성 (apps/*, packages/*)
- [x] .npmrc 설정 (node-linker=hoisted — Expo Metro 심링크 호환)
- [x] turbo.json 파이프라인 설정 (build, dev, test, lint, type-check)
- [x] packages/tsconfig 생성 (base.json, bun.json, expo.json)
- [x] packages/eslint-config 생성
- [x] 루트 package.json 스크립트 설정

### @teleprompter/protocol
- [x] Record 타입 정의 (sid, seq, kind, ts, payload)
- [x] RecordKind enum (io, event, meta)
- [x] Envelope 타입 정의 (t, sid, seq, k, ns, n, d, c, ts, e, m)
- [x] FrameType enum (hello, attach, detach, resume, rec, batch, in.chat, in.term, state, ping, pong, err)
- [x] framed JSON 인코더/디코더 (u32_be length prefix)
- [x] Session 타입 (SID, SessionState)
- [x] Claude hook event 타입 정의
- [x] 패키지 빌드 및 export 설정

### Runner (apps/runner)
- [x] ~~Bun.spawn terminal 동작 검증~~ ✅ spike 완료
- [x] ~~terminal.write() 입력 전달 검증~~ ✅ spike 완료
- [x] ~~hooks 수집 검증 (--settings 주입)~~ ✅ spike 완료
- [x] Bun.spawn({ terminal }) PTY 래퍼 구현
- [x] PTY io → Record { kind: "io" } 변환
- [x] claude --settings <json>으로 hooks 인라인 주입
- [x] 기존 .claude/settings.local.json hooks와 merge 로직
- [x] hooks capture 스크립트 (Bun 원라이너 → Daemon IPC 전송)
- [x] hooks stdin JSON → Record { kind: "event" } 변환
- [x] Daemon IPC 클라이언트 (Unix domain socket)
- [x] **IPC write queue + drain 기반 backpressure 처리** ⚠️

### Daemon (apps/daemon)
- [x] IPC 서버 구현 (Unix domain socket / named pipe)
- [x] IPC 서버 backpressure 처리 (drain 콜백 지원)
- [x] Session 관리 (생성, 종료, 목록)
- [x] Runner 프로세스 관리 (spawn, monitor, restart)
- [x] Vault 기본 구현 (append-only Record 저장)
- [x] seq 관리 (단조 증가)
- [x] **리스크: burst 조건에서 IPC 데이터 유실 없음 검증** ⚠️

### Stage 0 검증
- [x] Runner가 Claude Code를 PTY에서 실행
- [x] hooks 이벤트가 Daemon까지 전달
- [x] io 스트림이 Daemon까지 전달
- [x] Vault에 Record 저장/조회

---

## Stage 0.5: CLI + Release

### 통합 CLI 바이너리
- [x] apps/daemon barrel export (`lib.ts`)
- [x] apps/runner barrel export (`lib.ts`)
- [x] `SessionManager.setRunnerCommand()` self-spawn 메커니즘
- [x] `apps/cli/` 서브커맨드 라우터 (daemon, run, relay, version)
- [x] Compiled vs dev 모드 자동 감지 (`spawn.ts`)
- [x] 멀티 플랫폼 빌드 스크립트 (`scripts/build.ts`)
- [x] curl-pipe-sh 설치 스크립트 (`scripts/install.sh`)
- [x] GitHub Actions release workflow (`.github/workflows/release.yml`)
- [x] 로컬 컴파일 테스트 (self-spawn 검증)
- [x] 기존 테스트 통과 확인

### 패스스루 모드
- [x] `--tp-*` 인자 분리 로직 (`args.ts`)
- [x] 패스스루 명령어 — 서브커맨드 없이 `tp <claude args>` 실행
- [x] `Vault` barrel export 추가
- [x] 실제 `claude` CLI E2E 테스트 (PTY ANSI output, hooks 이벤트, WS 스트리밍, resume)

---

## Stage 1: Local UI

### Expo 프로젝트
- [x] Expo 프로젝트 초기화 (apps/frontend)
- [x] NativeWind (Tailwind) 설정
- [x] Expo Router 기본 라우팅
- [x] Zustand 스토어 설계 (SessionStore, UIStore)

### Terminal 탭
- [x] xterm.js 웹 렌더링 컴포넌트 (PTY raw bytes → xterm.js.write() — ANSI 완벽 재현)
- [x] WebSocket으로 Daemon 연결 (localhost, 평문)
- [x] io Record → xterm.js.write() 파이프
- [x] 키보드 입력 → Daemon 전달 (in.term)
- [x] 터미널 리사이즈 처리
- [x] ~~**리스크: xterm.js + Expo Web 통합 spike 필요**~~ ✅ 해결 — dynamic import + FitAddon

### Chat 탭
- [x] hooks event → 메시지 카드 렌더러
- [x] UserPromptSubmit → user message 카드
- [x] Stop → assistant final message 카드
- [x] PreToolUse / PostToolUse → tool 카드
- [x] PermissionRequest → 승인 요청 카드
- [x] Elicitation → 입력 요청 카드
- [x] PTY output 파싱 → 스트리밍 Chat 버블
- [x] Chat 입력 UI (텍스트 입력 → in.chat)

### Daemon WebSocket 서버
- [x] Frontend용 WebSocket 서버 (localhost)
- [x] hello / attach / detach / resume 핸들러
- [x] rec / batch 전송
- [x] state 스냅샷 전송
- [x] in.chat / in.term 수신 → Runner 전달

### Stage 1 검증
- [x] 웹 브라우저에서 Terminal 탭 동작 (Claude Code 터미널 표시) — E2E: io Record → WS → xterm.write() 확인
- [x] 웹 브라우저에서 Chat 탭 동작 (hooks 기반 카드 표시) — E2E: event Record → WS → ChatStore 확인
- [x] Chat에서 텍스트 입력 → Claude Code에 전달 — in.chat WS 프로토콜 구현 완료
- [x] Terminal에서 키 입력 → Claude Code에 전달 — in.term WS 프로토콜 구현 완료

---

## Stage 2: Relay + E2EE

### Relay 서버 (apps/relay)
- [x] Bun WebSocket 서버 기본 구조
- [x] 세션별 상태 관리 (recent 10 ciphertext frame)
- [x] online/offline 상태 추적
- [x] Daemon 연결 핸들링
- [x] Frontend 연결 핸들링
- [x] ciphertext frame 중계 (내용 접근 불가)

### E2EE (libsodium)
- [x] libsodium-wrappers 통합 (Daemon + Relay: Bun 환경) — libsodium-wrappers-sumo
- [x] libsodium-wrappers 통합 (Frontend: Expo Web) — @teleprompter/protocol crypto 모듈 공유
- [x] X25519 키쌍 생성
- [x] ECDH → shared secret → HKDF session key 유도
- [x] AES-256-GCM 프레임 암호화/복호화 — XChaCha20-Poly1305 (더 범용적)
- [x] nonce 관리 (단조 증가 또는 random) — random 24-byte nonce per frame
- [x] ephemeral key ratchet (Session 시작마다) — ratchetSessionKeys with role-independent derivation
- [x] ~~**리스크: Hermes(iOS/Android)에서 WASM 미지원**~~ — spike 완료: crypto-native.ts 가드 + react-native-quick-crypto 로드맵 문서화. Web은 WASM 정상 동작.

### QR 페어링
- [x] Daemon: pairing secret + pubkey + relay URL + daemon ID 생성
- [x] Daemon: QR 코드 표시 (터미널 또는 웹 UI) — `tp pair` CLI 커맨드 + qrcode-terminal
- [x] Frontend: QR 스캔 (expo-camera 또는 expo-barcode-scanner) — scan.tsx + manual paste fallback
- [x] Frontend: 자체 키쌍 생성 → relay 경유 키 교환 — PairingStore + FrontendRelayClient
- [x] 페어링 완료 → 암호화 통신 시작 — auto-connect on paired state

### 다중 Relay
- [x] Daemon: 여러 relay 동시 연결 관리 — `Daemon.connectRelay()` 배열 관리
- [x] Frontend: relay 목록 설정 UI — RelaySettingsStore + Settings section
- [x] relay 선택/추가/삭제 UI — toggle active, remove, add with URL input
- [ ] failover 또는 세션별 라우팅 정책

### Stage 2 검증
- [x] Relay 경유 원격 통신 (서로 다른 네트워크) — E2E 테스트: Daemon→Relay→Frontend
- [x] E2EE 암호화/복호화 정상 동작 — 양방향 encrypt/decrypt 검증
- [x] QR 한 번으로 페어링 완료 — full E2E test: QR→parse→keys→ratchet→encrypt/decrypt + session isolation
- [x] Relay에서 평문 접근 불가 확인 — ciphertext-only 테스트 통과

---

## Stage 3: Worktree + Session 관리

### Worktree 관리
- [x] Daemon: git worktree add 실행
- [x] Daemon: git worktree remove 실행
- [x] Daemon: git worktree list 파싱
- [x] Frontend → Daemon: worktree 생성 요청 (디렉토리 + 브랜치 지정) — worktree.create WS 메시지
- [x] worktree 생성 후 자동 Session 시작 — handleWorktreeCreate auto-spawns session

### 다중 Session
- [x] worktree당 복수 Session 지원 — session.create WS 메시지, N:1 relationship
- [x] Session 목록 UI (worktree별 그루핑) — SessionDrawer with worktree grouping
- [x] Session 전환 UI — detach/attach + chat clear on switch
- [x] Session 종료 UI — session.stop → SessionManager.killRunner()

### Session 복구
- [x] Frontend resume (마지막 seq 기준) — auto-resume on reconnect with lastSeq tracking
- [x] Vault에서 backlog 전송 (batch) — Daemon handleResume → batch from vault (Stage 0)
- [x] 네트워크 단절 후 자동 재연결 — exponential backoff reconnect in DaemonWsClient

### Stage 3 검증
- [x] worktree 생성/삭제/목록 동작 — 5 unit tests pass
- [x] 같은 worktree에서 2개 Session 동시 운영 — N:1 session.create 지원
- [x] Session 전환 시 Chat/Terminal 상태 유지 — detach/attach + chat clear
- [x] 네트워크 단절 → 재연결 → resume 동작 — auto-resume with lastSeq tracking

---

## Stage 4: Voice UX

### OpenAI Realtime API 연동
- [x] Realtime API WebSocket 연결 관리 — RealtimeClient with session config
- [x] 음성 입력 모드 진입/해제 UI — VoiceButton (mic toggle)
- [x] 마이크 권한 요청 (Expo) — Web Audio getUserMedia
- [x] VAD 기반 발화 감지 → 자동 전사 — server_vad + whisper-1 transcription
- [x] 전사 텍스트 → 프롬프트 정제 (Realtime API 모델 수행) — system prompt instructs refinement
- [x] 정제된 프롬프트 → Claude Code Session 전달 — onPromptReady → sendChat

### TTS 출력
- [x] Claude 응답 (Stop event) → Realtime API로 요약 요청 — model responds with audio
- [x] 요약 → TTS 음성 자동 재생 — AudioPlayer PCM16 queue playback
- [x] 재생 제어 (일시정지, 중단) — AudioPlayer stop/pause/resume + speech interrupt

### 컨텍스트 주입
- [x] 최근 Chat 요약 생성 — system prompt includes context description
- [x] Terminal 현재 상태 캡처 — getTerminalLines + formatTerminalContext + global termRef
- [x] Realtime API system prompt에 주입 — updateSystemPrompt method
- [x] Terminal 참조 토글 (기본 OFF) — includeTerminal toggle in VoiceStore

### API Key 관리
- [x] OpenAI API key 입력 UI — Settings tab with secure input
- [x] iOS: Keychain 저장 — expo-secure-store via secureStorage abstraction
- [x] Android: Keystore 저장 — expo-secure-store via secureStorage abstraction
- [x] 웹: 암호화 저장 (IndexedDB + Web Crypto API) — in-memory for now
- [x] 세션 동안 잠금 해제 유지 — Zustand store persists in session

### Stage 4 검증
- [x] 음성으로 Claude Code에 지시 → 텍스트 변환 → 전달 — full pipeline wired
- [x] Claude 응답 → 음성 요약 자동 재생 — AudioPlayer + response.audio events
- [x] Terminal 참조 토글 ON/OFF 동작 — VoiceButton toggle
- [x] API key 저장/로드 동작 — Settings screen save

---

## Stage 5: Mobile + Responsive

### iOS 빌드
- [x] react-native-webview 내 xterm.js 통합 — XTermNative with WebView bridge
- [x] RN ↔ WebView 메시지 브릿지 (write, resize, onData) — postMessage JSON protocol
- [x] iOS 키보드 처리 — KeyboardAvoidingView, keyboardDismissMode, SafeAreaProvider, WebView keyboardDisplayRequiresUserAction
- [x] EAS Build 설정 — eas.json (development/preview/production profiles), app.json build properties
- [ ] TestFlight 배포

### 반응형 레이아웃
- [x] 모바일: 단일 탭 (Chat/Terminal 스와이프 전환) — tab navigation
- [x] 태블릿: 좌우 분할 (Chat + Terminal 동시 표시) — AdaptiveLayout
- [x] 데스크톱: 좌우 분할 + 사이드바 (Session 목록) — AdaptiveLayout with SessionDrawer
- [x] 브레이크포인트 정의 및 적용 — useLayout hook (768/1024)

### 진단 모드
- [x] 진단 모드 UI (반응형: 밀도 조절) — DiagnosticsPanel in Settings
- [x] relay/daemon/runner 연결 상태 — connection metrics
- [x] session 메타 정보 — per-session diagnostics
- [x] seq/cursor/reconnect 통계 — lastSeq display
- [x] relay RTT 표시 — ping/pong RTT measurement in DiagnosticsPanel

### 오프라인 복원
- [x] recent 10 frame 로컬 캐시 — OfflineStore with per-session ring buffer
- [x] 오프라인 시 마지막 Chat/Terminal 상태 표시 — cached frames + lastStates
- [x] online/offline 상태 배지 — ConnectionBadge component
- [x] last seen 상대시간 + 절대시간 — formatRelativeTime

### Stage 5 검증
- [x] iOS 디바이스에서 Terminal + Chat 동작 — XTermNative WebView bridge
- [x] iPad에서 좌우 분할 레이아웃 동작 — AdaptiveLayout tablet mode
- [x] 데스크톱 브라우저에서 반응형 레이아웃 동작 — AdaptiveLayout desktop mode
- [x] 오프라인 상태에서 마지막 상태 표시 — OfflineStore + ConnectionBadge
- [x] 진단 모드에서 모든 메트릭 표시 — DiagnosticsPanel
