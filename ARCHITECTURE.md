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
    │                              ├── Terminal 탭: xterm.js.write(rawBytes) — ANSI 완벽 재현
    │                              └── Chat 탭: strip-ansi → 순수 텍스트 스트리밍 버블
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

Runner는 `claude --settings <json>` 플래그로 hooks 설정을 인라인 주입한다.
`.claude/settings.local.json`을 수정하지 않으므로 사용자 설정과 충돌하지 않는다.

```typescript
// hooks 설정을 JSON으로 구성
const hooksSettings = JSON.stringify({
  hooks: {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: captureScript }] }],
    Stop:         [{ matcher: "", hooks: [{ type: "command", command: captureScript }] }],
    PreToolUse:   [{ matcher: "", hooks: [{ type: "command", command: captureScript }] }],
    PostToolUse:  [{ matcher: "", hooks: [{ type: "command", command: captureScript }] }],
    // ... 모든 이벤트 등록
  },
});

const proc = Bun.spawn(["claude", "--settings", hooksSettings], {
  cwd: worktreePath,
  terminal: {
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data: (term, data) => {
      // io Record 생성 → Daemon에 IPC 전송 (raw bytes 그대로)
      sendToDaemon({ kind: "io", payload: data });
    },
  },
});
```

### 6.2 Hooks 수집

Claude Code hooks는 특정 이벤트 발생 시 지정된 스크립트를 실행한다.
hook 스크립트는 stdin으로 JSON을 받아 파싱한 후, IPC를 통해 Daemon에 event Record를 전달한다.

```typescript
// capture-hook.sh — 모든 이벤트를 공통으로 수집하는 단일 스크립트
// stdin JSON 필드: session_id, hook_event_name, cwd, ...
// Stop 이벤트: last_assistant_message 필드 포함
// PreToolUse: tool_name, tool_input 필드 포함
const hookData = await Bun.stdin.json();
sendToDaemon({
  kind: "event",
  ns: "claude",
  name: hookData.hook_event_name,
  payload: hookData,
});
```

### 6.3 ANSI 처리 전략

PTY에서 나오는 raw bytes는 ANSI escape 시퀀스(색상, 커서 이동, 대체 화면 버퍼 등)를 포함한다.

```
Terminal 탭: raw bytes → xterm.js.write(data) — ANSI 완벽 재현, 직접 파싱 불필요
Chat 탭:    raw bytes → strip-ansi → 순수 텍스트 → Chat 버블 렌더링
```

xterm.js는 VS Code 터미널과 동일한 라이브러리로, Claude Code의 rich TUI를 완벽하게 렌더링한다.

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
hooks events ──────┐
                   ├──▶ Chat 렌더러
PTY raw bytes ─────┘
  └─ strip-ansi        │
                        ├── user message 카드 (UserPromptSubmit: prompt 필드)
                        ├── assistant streaming 버블 (PTY → strip-ansi → 순수 텍스트)
                        ├── assistant final 카드 (Stop: last_assistant_message 필드)
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

### 9.3 Backpressure 처리

Bun의 `socket.write()`는 내부 버퍼가 가득 차면 `0`을 반환하고 데이터를 버린다.
PTY 출력 burst 시 데이터 유실을 방지하기 위해 write queue + drain 기반 flow control을 구현한다.

```typescript
class QueuedWriter {
  private queue: Buffer[] = [];
  private draining = false;

  write(socket: Socket, data: Buffer) {
    if (this.queue.length > 0 || socket.write(data) === 0) {
      this.queue.push(data);
    }
  }

  onDrain(socket: Socket) {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      if (socket.write(chunk) === 0) return; // 다시 drain 대기
      this.queue.shift();
    }
  }
}
```

### 9.4 Hook 스크립트 IPC

Hook 스크립트는 Claude Code가 별도 프로세스로 실행하므로, Daemon의 IPC 소켓에 직접 연결해야 한다.
플랫폼 의존 도구(nc, socat)를 피하고 Bun을 사용한다:

```bash
#!/bin/bash
# capture-hook.sh — Bun 원라이너로 Daemon에 전송
INPUT=$(cat)
echo "$INPUT" | bun -e "
  const data = await Bun.stdin.text();
  const sock = await Bun.connect({
    unix: '/tmp/teleprompter-\$(id -u)/daemon.sock',
    socket: {
      data() {},
      open(socket) { socket.write(data); socket.end(); },
    },
  });
"
exit 0
```

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
