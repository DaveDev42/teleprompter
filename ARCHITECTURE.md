# Teleprompter Architecture

## 1. 시스템 개요

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Runner    │────▶│   Daemon    │◀───▶│   Relay     │◀───▶│  Frontend   │
│  (per-session)│  IPC │ (long-running)│  WS  │  (ciphertext) │  WS  │ (Expo app)  │
│             │     │             │     │             │     │             │
│ Bun PTY     │     │ Store       │     │ 공식/셀프    │     │ ghostty-web │
│ hooks 수집   │     │ E2EE        │     │ hosted      │     │ Chat UI     │
│             │     │ worktree    │     │             │     │ Voice       │
└─────────────┘     └──────┬──────┘     └─────────────┘     └──────┬──────┘
                           │                                       │
                     N:N 지원: 하나의 Daemon이 여러 Frontend에        │
                     독립 E2EE 세션 키로 동시 서비스.               N:N 지원: 하나의 App이
                     per-frontend sessionKeys via frontendId.     여러 Daemon에 동시 연결.
```

## 2. 모노레포 구조

```
teleprompter/
├── apps/
│   ├── app/                   # @teleprompter/app — Expo (React Native + RN Web)
│   │   ├── app/               # Expo Router
│   │   ├── src/
│   │   │   ├── components/    # UI 컴포넌트
│   │   │   ├── hooks/         # React hooks
│   │   │   ├── stores/        # Zustand stores
│   │   │   ├── lib/           # Relay client (E2EE), secure storage
│   │   │   └── voice/         # OpenAI Realtime API, audio capture/playback
│   │   ├── app.json
│   │   ├── metro.config.js
│   │   ├── tailwind.config.ts # NativeWind
│   │   └── package.json
│   │
│   └── cli/                   # @teleprompter/cli — 통합 CLI (`tp` 바이너리)
│       ├── src/
│       │   ├── index.ts       # 서브커맨드 라우터
│       │   ├── spawn.ts       # self-spawn 유틸 (compiled vs dev)
│       │   └── commands/      # daemon, run, relay, pair, session, status, logs, doctor, upgrade, version, completions
│       └── package.json
│
├── packages/
│   ├── daemon/                # @teleprompter/daemon — Bun 장기 실행 서비스
│   │   ├── src/
│   │   │   ├── session/       # Session 관리
│   │   │   ├── store/         # 로컬 저장소
│   │   │   ├── transport/     # Relay client (E2EE WS client)
│   │   │   ├── worktree/      # git worktree 관리
│   │   │   ├── ipc/           # Runner IPC 서버
│   │   │   ├── pairing/       # 페어링 오케스트레이션 (pending + orchestrator)
│   │   │   └── push/          # Push notification 발송 (push-notifier)
│   │   └── package.json
│   │
│   ├── runner/                # @teleprompter/runner — Bun PTY 관리
│   │   ├── src/
│   │   │   ├── pty/           # Bun.spawn terminal 래퍼
│   │   │   ├── hooks/         # Claude Code hooks 수집
│   │   │   ├── ipc/           # Daemon IPC 클라이언트
│   │   │   └── collector.ts   # io/event Record 생성
│   │   └── package.json
│   │
│   ├── relay/                 # @teleprompter/relay — Bun WebSocket 중계
│   │   ├── src/
│   │   │   ├── relay-server.ts # token-based access control, frame routing, caching
│   │   │   ├── index.ts       # standalone entry point
│   │   │   └── lib.ts         # barrel export
│   │   └── package.json
│   │
│   ├── protocol/              # @teleprompter/protocol
│   │   ├── src/
│   │   │   ├── types/         # 공유 타입 정의
│   │   │   │   ├── record.ts        # Record, RecordKind
│   │   │   │   ├── envelope.ts      # Envelope, FrameType (13-member union)
│   │   │   │   ├── session.ts       # Session, SID, SessionState (primitive types만)
│   │   │   │   ├── session-proto.ts # SessionClientMessage / SessionServerMessage (Frontend↔Daemon)
│   │   │   │   ├── event.ts         # Claude hook event 타입
│   │   │   │   ├── relay.ts         # Relay Protocol v2 메시지 + RELAY_CHANNEL_* 상수
│   │   │   │   ├── control.ts       # control.unpair / control.rename (E2EE __control__)
│   │   │   │   ├── label.ts         # Label tagged union, decodeWireLabel/decodeKxLabelOrKeep
│   │   │   │   └── ipc.ts           # IpcMessage (Runner↔Daemon, CLI pair/session ops)
│   │   │   ├── codec.ts       # framed JSON 인코더/디코더
│   │   │   ├── crypto.ts      # E2EE (X25519, XChaCha20-Poly1305, ratchet)
│   │   │   ├── pairing.ts     # QR pairing bundle, encode/decode
│   │   │   ├── relay-client-guard.ts # zero-trust Client→Relay 검증 (parseRelayClientMessage)
│   │   │   ├── relay-server-guard.ts # Relay→Client 검증 (parseRelayServerMessage)
│   │   │   ├── control-guard.ts      # 복호화된 ControlMessage 검증 (parseControlMessage)
│   │   │   ├── ipc-guard.ts          # IPC 메시지 검증 (parseIpcMessage)
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── tsconfig/              # 공유 TS 설정
│       ├── base.json
│       └── bun.json           # Bun 서비스용
│       # 린트/포맷은 Biome (root biome.json) — ESLint/Prettier 없음
│
├── scripts/
│   ├── build.ts               # 멀티 플랫폼 bun build --compile
│   ├── deploy-relay.sh        # relay 배포 스크립트
│   └── install.sh             # curl-pipe-sh 설치 스크립트
│
├── e2e/                       # Playwright E2E 테스트 — app-*.spec.ts glob (160+ 파일)
│   └── ...                    # 대표 시나리오 목록은 .claude/rules/testing-inventory.md Tier 4 (curated subset)
│
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── release-please-config.json
├── .release-please-manifest.json
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
    │                              ├── Store에 append
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
    │                              ├── Terminal 탭: ghostty-web.write(rawBytes) — ANSI 완벽 재현
    │                              └── Chat 탭: hooks events 전용 (io records 는 Terminal 탭으로만)
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
Daemon (IPC) → Store append → E2EE encrypt → Relay → Frontend
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

Relay Protocol v2 (Daemon/Frontend ↔ Relay):
  relay.register   Daemon token self-registration (proof 기반)
  relay.auth       인증 (frontendId 포함)
  relay.auth.resume HMAC 토큰 fast-path 재연결 (relay 재시작 생존)
  relay.kx         in-band pubkey 교환 (kxKey로 암호화)
  relay.pub        암호화 데이터 publish
  relay.sub/unsub  세션 구독/해제
  relay.frame      암호화 데이터 수신 (frontendId 포함)
  relay.kx.frame   pubkey 교환 수신
  relay.presence   Daemon online/offline + 세션 목록
  relay.push       Daemon → Relay: 대상 frontend 에 Expo push 발송 요청 (token+title+body+interruptionLevel?+data)
                   interruptionLevel = "active" | "time-sensitive" (옵셔널, 미지정 → active).
                   attention-needed 이벤트(PermissionRequest/Notification/Elicitation)는 time-sensitive
                   로 Focus/DND 돌파 + APNs priority 10. 정보성 이벤트는 active (Focus 존중).
  relay.push.register  Frontend → Relay: Expo push token 등록 (sealed + platform). Relay 가 PushSealer 로
                   봉인하여 relay.push.token 으로 Daemon 에 라우팅.
  relay.push.token Relay → Daemon: 봉인된 push token (frontendId + sealed blob + platform). Daemon 이
                   복호화 후 Expo Push API 호출에 사용.
  relay.notification Relay → Frontend: push payload 전달 (앱이 백그라운드일 때 알림)
  relay.ping/pong  keepalive

  control.unpair   E2EE 페어링 해제 알림 (relay.pub on __control__ sid)
                   한쪽이 페어링을 삭제하면 반대편도 자동 삭제
  control.rename   E2EE 페어링 label 변경 알림 (relay.pub on __control__ sid)
                   label은 Label tagged union ({set:true,value} | {set:false}).
                   daemon이 peer 버전별로 wire 형식을 게이팅 (구버전 앱엔 legacy string)
```

## 5. E2EE 아키텍처 (Relay Protocol v2)

### 5.1 키 파생 체계

하나의 pairing secret에서 3개의 독립적인 키가 파생된다:

```
pairing_secret (32B, QR 코드로 공유)
  │
  ├── BLAKE2b(secret‖"relay-auth")     → relay token (인증용, hex)
  ├── BLAKE2b(secret‖"relay-register") → registration proof (self-registration용, hex)
  └── BLAKE2b(secret‖"kx-envelope")   → kxKey (key exchange 암호화용, 32B)
```

### 5.2 페어링 + 연결 시퀀스

```
Daemon                     Relay                     Frontend
  │                          │                          │
  ├── X25519 keypair 생성     │                          │
  ├── pairing secret (32B)   │                          │
  ├── relay token 파생        │                          │
  ├── registration proof 파생 │                          │
  ├── kxKey 파생              │                          │
  │                          │                          │
  ├── QR 표시 ◀──────────────┼────────────────────────── QR 스캔 (offline)
  │   {secret, pk, relay, id}│                          │
  │                          │                          ├── X25519 keypair 생성
  │                          │                          ├── frontendId 생성
  │                          │                          ├── relay token 파생 (동일)
  │                          │                          ├── kxKey 파생 (동일)
  │                          │                          │
  ├── relay.register ────────▶ token→daemonId 등록       │
  ◀── relay.register.ok ─────┤                          │
  ├── relay.auth (daemon) ──▶│ daemon 인증               │
  ◀── relay.auth.ok ─────────┤                          │
  │                          │                          │
  ├── relay.kx ──────────────▶ 반대 role에 forwarding ──▶│ (daemon pubkey, kxKey로 암호화)
  │   (daemon pk broadcast)  │                          │
  │                          │                          ├── relay.auth (frontend, frontendId)
  │                          │◀── relay.auth ────────────┤
  │                          ├── relay.auth.ok ─────────▶│
  │                          │                          │
  │                          │◀── relay.kx ─────────────┤ (frontend pk + frontendId, kxKey로 암호화)
  ◀──────── relay.kx.frame ──┤   반대 role에 forwarding  │
  │                          │                          │
  ├── kxKey로 복호화           │                          │
  ├── frontend pk 추출        │                          │
  ├── per-frontend session   │                          │
  │   keys 파생 (ECDH)       │                          │
  │                          │                          │
  ◀════ E2EE (per-frontend XChaCha20-Poly1305) ════════▶
```

### 5.3 N:N 멀티플렉싱

- **하나의 Daemon ↔ N개 Frontend**: Daemon은 `peers: Map<frontendId, SessionKeys>`로
  frontend별 독립 E2EE 세션 키를 관리. `publishRecord()` 시 각 peer에게 별도 암호화.
- **하나의 App ↔ N개 Daemon**: App은 `pairings: Map<daemonId, PairingInfo>`로
  daemon별 독립 `FrontendRelayClient` 인스턴스를 관리. 각각 독립 relay 연결.
- **Relay 라우팅**: `RelayFrame.frontendId`로 daemon이 O(1) peer lookup.
  Relay는 daemonId별 그룹 내에서 frame을 forwarding.

### 5.4 Pairing 영속화

- **Daemon**: vault SQLite의 `pairings` 테이블에 key pair + pairing secret 저장.
  재시작 시 `reconnectSavedRelays()`로 자동 재연결.
- **Frontend**: expo-secure-store (iOS: Keychain, Android: Keystore, Web: localStorage)에
  `Map<daemonId, PairingInfo>`를 base64-serialized JSON으로 저장.

### 5.5 암호화 프레임 구조

```
┌──────────┬──────────────────────────────┐
│ nonce    │ ciphertext + auth tag        │
│ (24B)    │ (variable, 16B tag appended) │
└──────────┴──────────────────────────────┘
```

libsodium의 `xchacha20poly1305_ietf_encrypt`는 ciphertext에 auth tag를 concatenate하여 반환한다.
전체가 base64로 인코딩되어 Envelope의 필드로 전달된다.
Relay는 이 암호화된 blob만 중계한다. 내용을 알 수 없다.

## 6. Runner PTY 관리

### 6.1 PTY 관리

**`PtyBun`** (macOS/Linux): `Bun.spawn({ terminal })` 네이티브 PTY. `PtyManager` 인터페이스로 추상화되어 있어 Runner 코드는 플랫폼을 직접 참조하지 않는다. Windows 네이티브 실행은 지원하지 않으며, Windows 사용자는 WSL 안에서 Linux 빌드를 실행한다.

### 6.1a Bun.spawn PTY 상세

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
hook 스크립트는 stdin으로 JSON을 받아 파싱한 후, Runner의 HookReceiver에 전달한다.
HookReceiver → Runner → Daemon (IPC) → Store 순서로 event Record가 전파된다.

```typescript
// 개념 설명용 간소화. 실제 구현: packages/runner/src/hooks/capture-hook.ts
// stdin JSON 필드: session_id, hook_event_name, cwd, ...
// Stop 이벤트: last_assistant_message 필드 포함
// PreToolUse: tool_name, tool_input 필드 포함
const hookData = await Bun.stdin.json();
sendToHookReceiver({  // → Runner → Daemon
  kind: "event",
  ns: "claude",
  name: hookData.hook_event_name,
  payload: hookData,
});
```

### 6.3 ANSI 처리 전략

PTY에서 나오는 raw bytes는 ANSI escape 시퀀스(색상, 커서 이동, 대체 화면 버퍼 등)를 포함한다.

```
Terminal 탭: raw bytes → ghostty-web.write(data) — ANSI 완벽 재현, 직접 파싱 불필요
Chat 탭:    io records 미사용 — hooks events 전용 (hooks-only, PR #457에서 PTY 폴백 제거)
```

ghostty-web은 libghostty(Ghostty 터미널 코어)를 WASM으로 컴파일해 Canvas 2D로 렌더링하며, Claude Code의 rich TUI를 완벽하게 재현한다.

## 7. Frontend 아키텍처

### 7.1 상태 관리 (Zustand)

```typescript
// stores/session.ts (개념 스케치)
interface SessionStore {
  sessions: Map<SID, SessionState>;
  activeSession: SID | null;
  // 연결은 항상 pairing 경유 — pairing 번들이 relay URL + daemonId 를 담는다.
  // 프론트엔드가 daemon URL 을 직접 잡는 경로는 존재하지 않는다 (relay-only invariant).
  connect: (pairing: PairingInfo) => void;
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
  GhosttyTerminal.tsx — ghostty-web (libghostty WASM) Canvas 2D 직접 렌더링

iOS/Android:
  GhosttyNative.tsx — react-native-webview 안에서 ghostty-web 을 로드
  (WASM 바이너리를 base64 로 인라인 — null-origin CORS 회피). xterm.js 가 아니다.
  RN ↔ WebView 메시지 브릿지:
    RN → WebView: terminal.write(data), terminal.resize(cols, rows)
    WebView → RN: onData(input), onResize(cols, rows)
```

터미널 컴포넌트는 `apps/app/src/components/`의 `GhosttyTerminal.tsx`(웹 — Canvas 직접)와
`GhosttyNative.tsx`(네이티브 — WebView 안 ghostty-web) 두 파일로 구성된다.

### 7.3 Chat UI 렌더링 파이프라인

```
hooks events ──────▶ Chat 렌더러 (hooks-only — PTY io 는 Terminal 탭 전용)
                        │
                        ├── user message 카드 (UserPromptSubmit: prompt 필드)
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
  경로: $XDG_RUNTIME_DIR/daemon.sock  (또는 /run/user/<uid>/daemon.sock)
  또는: /tmp/teleprompter-{uid}/daemon.sock
```

### 9.2 프로토콜

Runner와 Daemon 간 IPC도 동일한 framed JSON protocol을 사용한다.
Runner는 시작 시 Daemon에 hello 프레임을 보내고, SID를 등록한다.

### 9.3 Backpressure 처리

Bun의 `socket.write()`는 내부 버퍼가 가득 차면 `0`을 반환하고 데이터를 버린다.
PTY 출력 burst 시 데이터 유실을 방지하기 위해 write queue + drain 기반 flow control을 구현한다.

```typescript
// 개념 설명용 간소화 예제. 실제 구현: packages/protocol/src/queued-writer.ts
class QueuedWriter {
  private queue: Uint8Array[] = [];

  write(socket: Socket, data: Uint8Array) {
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

Hook 스크립트는 Claude Code가 별도 프로세스로 실행하므로, Runner의 HookReceiver 소켓에 연결해야 한다.
플랫폼 의존 도구(nc, socat)를 피하고 Bun을 사용한다:

```
Hook 스크립트 → HookReceiver (Runner 프로세스 내 Unix socket) → Runner → Daemon (IPC)
```

HookReceiver 소켓 경로: `/tmp/teleprompter-{uid}/hook-{sid}.sock` (세션별 별도 소켓)

```bash
# 개념 설명용 간소화 예제. 실제 구현: packages/runner/src/hooks/capture-hook.ts
#!/bin/bash
INPUT=$(cat)
echo "$INPUT" | bun -e "
  const data = await Bun.stdin.text();
  const sock = await Bun.connect({
    unix: '${HOOK_SOCKET_PATH}',  // capture-hook.ts가 런타임에 주입
    socket: {
      data() {},
      open(socket) { socket.write(data); socket.end(); },
    },
  });
"
exit 0
```

## 10. 배포

### 10.1 통합 `tp` CLI 바이너리

Runner, Daemon, Relay가 하나의 `tp` 바이너리로 통합된다. 서브커맨드로 역할을 구분한다.
Relay도 `tp relay start` 서브커맨드로 실행된다.

```bash
# 서브커맨드 구조 (대표 예시 — 전체 surface는 CLAUDE.md "CLI Commands" 참조)
tp daemon start [--spawn --sid X --cwd Y]    # daemon 포그라운드 실행
tp run --sid X --cwd Y [--socket-path P]     # daemon이 내부적으로 호출 (internal)
tp relay start [--port 7090]                 # relay server
tp pair new [--relay URL] [--label NAME]     # QR pairing (bare `tp pair` = pair new)
tp session list / delete / cleanup / prune   # 세션 관리
tp status                                    # daemon & 세션 상태 확인
tp logs [session]                            # 세션 로그 테일링
tp doctor                                    # 환경 진단 + relay/E2EE 검증
tp upgrade                                   # 최신 릴리즈 업데이트
tp completions <bash|zsh|fish>               # 셸 자동완성 스크립트
tp version

# 로컬 빌드 (현재 플랫폼)
bun run build:cli:local   # → dist/tp

# 멀티 플랫폼 빌드
bun run build:cli          # → dist/tp-{darwin_arm64,darwin_x64,linux_x64,linux_arm64}

# Self-spawn 메커니즘
# compiled 바이너리: tp daemon start → tp run (같은 바이너리로 Runner spawn)
# dev 모드: bun run apps/cli/src/index.ts daemon start → bun run ... run (fallback)
```

### GitHub Release (Release Please + EAS)

릴리즈 플로우:
1. `release-please.yml` (workflow_dispatch 전용 — push 트리거 없음). 한 dispatch당 한 동작만 수행하므로
   patch 릴리즈는 dispatch 2회가 필요하다:
   - 1차 dispatch → 버전 PR 생성/갱신 (CHANGELOG, package.json 업데이트)
   - PR 머지 후 2차 dispatch → `vX.Y.Z` 태그 push
2. `release.yml` (push: tags `v*` + workflow_dispatch) → darwin-arm64 + linux-x64/arm64 바이너리 빌드,
   GitHub Release 생성, 이어서 Homebrew tap(`DaveDev42/homebrew-tap-release`) formula 갱신.
   (#172 push-event 누락 케이스가 잦아 실무에선 항상 manual dispatch로 트리거)
3. EAS는 release.yml과 분리:
   - `preview.yaml` (TestFlight / Android Internal) — ci.yml `eas-gate` job이 5개 CI job 통과 +
     `apps/app/**`·`packages/protocol/**` 변경 감지 시 main에서 자동 트리거 (`eas workflow:run`).
   - `production.yaml` (App Store / Play Store) — 수동 전용. release.yml이나 어떤 CI 이벤트도 자동 트리거하지 않는다.
   - 두 워크플로우 모두 fingerprint 기반: 동일 fingerprint 빌드가 있으면 OTA update, 없으면 full build 후 store 제출.

```bash
# 설치 (curl-pipe-sh)
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

버전 관리:
- Root `package.json` 단일 버전 → Release Please가 관리 (tp CLI 바이너리 버전)
- `apps/app/app.json` `expo.version` → 사람 버전, 손으로 관리 (release-please는 건드리지 않음)
- OTA runtimeVersion → cloud preview/production: `policy: fingerprint` (네이티브 의존성 해시 기반; JS-only 변경은 같은 runtime, 네이티브 변경 시 자동 격리). 로컬 dev/device 프로파일: `APP_VARIANT=dev-local` 시 `runtimeVersion: "dev-local"` 정적 문자열 override (app.config.js + eas.json development/device 프로파일). 자세한 사항은 `CLAUDE.md` "OTA 정책" 참조.
- 태그 패턴: `v*` (예: `v0.1.19`). release-please-config.json의 `include-component-in-tag: false` 라서 컴포넌트/접두사 없음.

### 10.2 Relay 서버

배포: `deploy-relay.yml` (main push 시 — `packages/relay/**`, `packages/protocol/**`, `packages/daemon/**`, `pnpm-lock.yaml` 경로 변경 시만 자동, 또는 수동 트리거)
- SSH로 원격 서버에 바이너리 전송 → systemd 서비스 재시작 → health check
- 서버 아키텍처 자동 감지 (aarch64/x86_64)

### 10.3 Frontend

```bash
# 웹 빌드
npx expo export --platform web

# iOS/Android 빌드 (EAS)
eas build --platform ios --profile production
eas build --platform android --profile production
```
