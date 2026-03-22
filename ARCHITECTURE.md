# Teleprompter Architecture

## 1. 시스템 개요

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Runner    │────▶│   Daemon    │◀───▶│   Relay     │◀───▶│  Frontend   │
│  (per-session)│  IPC │ (long-running)│  WS  │  (ciphertext) │  WS  │ (Expo app)  │
│             │     │             │     │             │     │             │
│ Bun PTY     │     │ Vault       │     │ 공식/셀프    │     │ xterm.js    │
│ hooks 수집   │     │ E2EE        │     │ hosted      │     │ Chat UI     │
│             │     │ worktree    │     │             │     │ Voice       │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘
```

## 2. 모노레포 구조

```
teleprompter/
├── apps/
│   ├── frontend/              # Expo (React Native + RN Web)
│   │   ├── app/               # Expo Router
│   │   ├── src/
│   │   │   ├── components/    # UI 컴포넌트
│   │   │   ├── hooks/         # React hooks
│   │   │   ├── stores/        # Zustand stores
│   │   │   ├── services/      # API/WebSocket 서비스
│   │   │   └── utils/
│   │   ├── app.json
│   │   ├── app.config.ts
│   │   ├── metro.config.js
│   │   ├── tailwind.config.ts # NativeWind
│   │   └── package.json
│   │
│   ├── daemon/                # Bun 장기 실행 서비스
│   │   ├── src/
│   │   │   ├── session/       # Session 관리
│   │   │   ├── vault/         # 로컬 저장소
│   │   │   ├── crypto/        # E2EE (libsodium)
│   │   │   ├── relay/         # Relay 연결 관리
│   │   │   ├── worktree/      # git worktree 관리
│   │   │   ├── ipc/           # Runner IPC 서버
│   │   │   └── transport/     # Frontend WebSocket 서버
│   │   └── package.json
│   │
│   ├── runner/                # Bun PTY 관리
│   │   ├── src/
│   │   │   ├── pty/           # Bun.spawn terminal 래퍼
│   │   │   ├── hooks/         # Claude Code hooks 수집
│   │   │   ├── ipc/           # Daemon IPC 클라이언트
│   │   │   └── collector/     # io/event Record 생성
│   │   └── package.json
│   │
│   └── relay/                 # Bun WebSocket 중계
│       ├── src/
│       │   ├── server/        # WebSocket 서버
│       │   ├── session/       # 세션별 상태 (recent 10)
│       │   └── auth/          # 연결 인증 (ciphertext 레벨)
│       └── package.json
│
├── packages/
│   ├── protocol/              # @teleprompter/protocol
│   │   ├── src/
│   │   │   ├── types/         # 공유 타입 정의
│   │   │   │   ├── record.ts  # Record, RecordKind
│   │   │   │   ├── envelope.ts # Envelope, FrameType
│   │   │   │   ├── session.ts # Session, SID
│   │   │   │   └── event.ts   # Claude hook event 타입
│   │   │   ├── codec.ts       # framed JSON 인코더/디코더
│   │   │   ├── crypto.ts      # E2EE 타입 (키, nonce 등)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── tsconfig/              # 공유 TS 설정
│   │   ├── base.json
│   │   ├── bun.json           # Bun 서비스용
│   │   └── expo.json          # Expo용
│   │
│   └── eslint-config/
│       └── index.js
│
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── PRD.md
├── ARCHITECTURE.md
└── TODO.md
```

## 3. 데이터 흐름

### 3.1 PTY io 흐름 (Terminal)

```
Claude Code CLI
    │
    ▼
Bun.spawn({ terminal })     Runner 프로세스
    │
    ├── terminal.data ──────▶ Record { kind: "io", payload: raw_bytes }
    │                              │
    │                              ▼
    │                         Daemon (IPC)
    │                              │
    │                              ├── Vault에 append
    │                              │
    │                              ▼
    │                         E2EE encrypt
    │                              │
    │                              ▼
    │                         Relay (ciphertext 중계)
    │                              │
    │                              ▼
    │                         Frontend (E2EE decrypt)
    │                              │
    │                              ├── Terminal 탭: xterm.js.write(data)
    │                              └── Chat 탭: PTY 파싱 → 스트리밍 버블
    │
    ◀── terminal.write(input) ◀── Frontend 입력 (역방향)
```

### 3.2 Hooks event 흐름 (Chat)

```
Claude Code hooks (stdin JSON)
    │
    ▼
Runner: hooks 수집 스크립트
    │
    ▼
Record { kind: "event", ns: "claude", name: hook_event_name, payload: stdin_json }
    │
    ▼
Daemon (IPC) → Vault append → E2EE encrypt → Relay → Frontend
    │
    ▼
Frontend Chat 탭:
    ├── UserPromptSubmit → user message 카드
    ├── Stop → assistant final message 카드
    ├── PreToolUse → tool pending 카드
    ├── PostToolUse → tool result 카드
    ├── PermissionRequest → 승인 요청 카드
    ├── Elicitation → 입력 요청 카드
    └── 기타 → Activity row / state badge
```

### 3.3 사용자 입력 흐름

```
Frontend Chat 입력
    │
    ▼
Envelope { t: "in.chat", d: user_text }
    │
    ▼
E2EE encrypt → Relay → Daemon (decrypt)
    │
    ▼
Daemon → Runner (IPC)
    │
    ▼
Runner → terminal.write(user_text + "\n")
    │
    ▼
Claude Code PTY에 입력 전달
```

## 4. 프로토콜 상세

### 4.1 Framed JSON

```
┌──────────────┬────────────────────┐
│ u32_be length│  UTF-8 JSON payload │
│   (4 bytes)  │   (length bytes)    │
└──────────────┴────────────────────┘
```

WebSocket 메시지 하나 = 프레임 하나. 로컬 IPC에서도 동일 형식.

### 4.2 Envelope 구조

```typescript
interface Envelope {
  t: FrameType;       // "hello" | "attach" | "rec" | "batch" | ...
  sid?: string;       // Session ID
  seq?: number;       // 단조 증가 시퀀스
  k?: RecordKind;     // "io" | "event" | "meta"
  ns?: string;        // 네임스페이스: "claude" | "tp" | "runner" | "daemon"
  n?: string;         // 이벤트 이름
  d?: unknown;        // payload
  c?: number;         // cursor (resume 시)
  ts?: number;        // Unix timestamp (ms)
  e?: string;         // error code
  m?: string;         // message
}
```

### 4.3 Frame Type 흐름

```
Frontend → Daemon:
  hello     초기 핸드셰이크
  attach    Session 연결
  detach    Session 분리
  resume    마지막 seq 이후 레코드 요청
  in.chat   Chat 입력
  in.term   Terminal 입력
  ping      keepalive

Daemon → Frontend:
  hello     핸드셰이크 응답
  state     Session 상태 스냅샷
  rec       단일 Record
  batch     복수 Record (resume 응답)
  pong      keepalive 응답
  err       에러
```

## 5. E2EE 아키텍처

### 5.1 페어링 시퀀스

```
Daemon                          Frontend
  │                                │
  ├── X25519 keypair 생성           │
  ├── pairing secret 생성 (32B)     │
  │                                │
  ├── QR 표시 ◀─────────────────── QR 스캔
  │   (secret + pubkey +           │
  │    relay URL + daemon ID)      │
  │                                ├── X25519 keypair 생성
  │                                │
  │   relay 경유 키 교환            │
  ◀─────── Frontend pubkey ────────┤
  │                                │
  ├── ECDH(daemon_sk, frontend_pk) │
  │   = shared_secret              │
  │                                ├── ECDH(frontend_sk, daemon_pk)
  │                                │   = shared_secret
  │                                │
  ├── HKDF(shared_secret)          ├── HKDF(shared_secret)
  │   = session_key                │   = session_key
  │                                │
  ◀══════ AES-256-GCM 통신 ═══════▶
```

### 5.2 암호화 프레임 구조

```
┌──────────┬───────────┬──────────────────┐
│ nonce    │ ciphertext│ auth tag         │
│ (24B)    │ (variable)│ (16B)            │
└──────────┴───────────┴──────────────────┘
```

Relay는 이 암호화된 blob만 중계한다. 내용을 알 수 없다.

## 6. Runner PTY 관리

### 6.1 Bun.spawn PTY (macOS/Linux)

```typescript
const proc = Bun.spawn(["claude", "--session", sid], {
  cwd: worktreePath,
  terminal: {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data: (term, data) => {
      // io Record 생성 → Daemon에 IPC 전송
      sendToDaemon({ kind: "io", payload: data });
    },
  },
  env: {
    ...process.env,
    // Claude Code hooks 설정
    CLAUDE_CODE_HOOKS_DIR: hooksDir,
  },
});
```

### 6.2 Hooks 수집

Claude Code hooks는 특정 이벤트 발생 시 지정된 스크립트를 실행한다.
Runner는 hooks 디렉토리에 수집 스크립트를 배치하고, stdin으로 전달되는 JSON을 파싱하여 event Record를 생성한다.

```typescript
// hooks/PreToolUse.sh → hooks/PreToolUse.ts (bun)
// stdin: { tool_name, tool_input, ... }
const hookData = await Bun.stdin.json();
sendToDaemon({
  kind: "event",
  ns: "claude",
  name: "PreToolUse",
  payload: hookData,
});
```

## 7. Frontend 아키텍처

### 7.1 상태 관리 (Zustand)

```typescript
// stores/session.ts
interface SessionStore {
  sessions: Map<SID, SessionState>;
  activeSession: SID | null;
  connect: (daemonUrl: string) => void;
  attachSession: (sid: SID) => void;
  sendChat: (text: string) => void;
  sendTerminal: (data: Uint8Array) => void;
}

// stores/voice.ts
interface VoiceStore {
  isListening: boolean;
  transcript: string;
  startVoiceMode: () => void;
  stopVoiceMode: () => void;
}
```

### 7.2 Terminal 렌더링

```
웹:
  xterm.js 직접 사용 (DOM 렌더링)

iOS/Android:
  react-native-webview 내부에 xterm.js 임베드
  RN ↔ WebView 메시지 브릿지:
    RN → WebView: terminal.write(data), terminal.resize(cols, rows)
    WebView → RN: onData(input), onResize(cols, rows)
```

### 7.3 Chat UI 렌더링 파이프라인

```
hooks events ──┐
               ├──▶ Chat 렌더러
PTY parsing ───┘
                     │
                     ├── user message 카드 (UserPromptSubmit)
                     ├── assistant streaming 버블 (PTY 파싱, 진행 중)
                     ├── assistant final 카드 (Stop)
                     ├── tool pending/result 카드 (PreToolUse/PostToolUse)
                     ├── permission 카드 (PermissionRequest)
                     ├── elicitation 카드 (Elicitation)
                     └── activity badge (기타 이벤트)
```

## 8. 음성 UX 아키텍처

```
┌─────────────────────────────────────────────────┐
│  Frontend                                        │
│                                                  │
│  ┌──────────┐    ┌───────────────────┐           │
│  │ 마이크    │───▶│ OpenAI Realtime   │           │
│  │ (VAD)    │    │ API (WebSocket)   │           │
│  └──────────┘    │                   │           │
│                  │ STT + 정제 + TTS  │           │
│  ┌──────────┐    │                   │           │
│  │ 스피커    │◀───│ system prompt:    │           │
│  │ (TTS)    │    │  - Chat 요약      │           │
│  └──────────┘    │  - Terminal 상태  │           │
│                  └─────────┬─────────┘           │
│                            │                     │
│                     정제된 프롬프트               │
│                            │                     │
│                            ▼                     │
│                  ┌─────────────────┐             │
│                  │ Claude Code     │             │
│                  │ Session 입력    │             │
│                  └─────────────────┘             │
└─────────────────────────────────────────────────┘
```

## 9. IPC 상세

### 9.1 Runner → Daemon

```
macOS/Linux: Unix domain socket
  경로: $XDG_RUNTIME_DIR/teleprompter/daemon.sock
  또는: /tmp/teleprompter-{uid}/daemon.sock

Windows: Named pipe
  경로: \\.\pipe\teleprompter-daemon-{uid}
```

### 9.2 프로토콜

Runner와 Daemon 간 IPC도 동일한 framed JSON protocol을 사용한다.
Runner는 시작 시 Daemon에 hello 프레임을 보내고, SID를 등록한다.

## 10. 배포

### 10.1 Daemon + Runner 바이너리

```bash
# 빌드
bun build ./apps/daemon/src/index.ts --compile --outfile teleprompter-daemon
bun build ./apps/runner/src/index.ts --compile --outfile teleprompter-runner

# 크로스 컴파일
bun build --compile --target=bun-linux-x64 ...
bun build --compile --target=bun-darwin-arm64 ...
bun build --compile --target=bun-windows-x64 ...
```

### 10.2 Relay 서버

```bash
# 단일 바이너리 또는 Docker
bun build ./apps/relay/src/index.ts --compile --outfile teleprompter-relay

# Docker
FROM oven/bun:latest
COPY apps/relay/ .
CMD ["bun", "run", "src/index.ts"]
```

### 10.3 Frontend

```bash
# 웹 빌드
npx expo export --platform web

# iOS 빌드
eas build --platform ios

# Android 빌드
eas build --platform android
```
