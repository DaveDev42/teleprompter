# Teleprompter Architecture

## 1. 시스템 개요

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Runner    │────▶│   Daemon    │◀───▶│   Relay     │◀───▶│    App      │
│  (per-session)│  IPC │ (long-running)│  WS  │  (ciphertext) │  WS  │ (Swift app) │
│             │     │             │     │             │     │             │
│ Rust        │     │ Store       │     │ 공식/셀프    │     │ SwiftUI     │
│ portable-pty│     │ E2EE        │     │ hosted      │     │ Chat UI     │
│ hooks 수집   │     │ worktree    │     │             │     │ Terminal    │
└─────────────┘     └──────┬──────┘     └─────────────┘     └──────┬──────┘
                           │                                       │
                     N:N 지원: 하나의 Daemon이 여러 Frontend에        │
                     독립 E2EE 세션 키로 동시 서비스.               N:N 지원: 하나의 App이
                     per-frontend sessionKeys via frontendId.     여러 Daemon에 동시 연결.
```

모든 컴포넌트(Runner/Daemon/Relay/CLI)는 Rust (`rust/` 워크스페이스), 앱은 Swift/SwiftUI (`ios/`) —
Bun/TypeScript 백엔드는 "#5 zero-Bun cascade" PR6(#933)에서 전량 삭제, Bun/Node 툴체인은 PR7(#935)에서
제거 완료 (ADR-0001/0003).

## 2. 모노레포 구조

`rust/` 워크스페이스가 백엔드/CLI 유일 구현이다 ("#5 zero-Bun cascade" PR6(#933)에서 Bun/TypeScript
소스(`packages/*`, `apps/cli`) 전량 삭제, PR7(#935)에서 Bun/Node 툴체인 자체를 제거). 앱은 `ios/`
(Swift/SwiftUI).

```
teleprompter/
├── ios/                        # Swift(SwiftUI) 앱 — Apple 멀티플랫폼 단일 타깃 (iOS/iPadOS/macOS/visionOS)
│                                #   + 별도 TeleprompterWatch 타깃 (watchOS)
│   ├── project.yml             # XcodeGen 스펙 (SoT — .xcodeproj는 생성물, gitignore)
│   ├── Sources/                # Swift 소스
│   ├── Tests/                  # XCTest
│   ├── UITests/                # XCUITest (TeleprompterUITests 타깃)
│   └── Generated/              # UniFFI 바인딩 (gitignored, 재현 가능)
│
├── rust/                       # Rust 워크스페이스 (백엔드/CLI 전체 — 유일 구현)
│   ├── Cargo.toml              # workspace (resolver 2)
│   ├── build-xcframework.sh    # 7-slice xcframework 빌드 + UniFFI 바인딩 생성
│   ├── tp-core/                # wire codec + E2EE crypto(AEAD/KDF/crypto_kx/ratchet) + pairing
│   │   └── src/                #   lib.rs(UniFFI FFI) / codec.rs / crypto.rs / pairing.rs / error.rs
│   │       # tests/wire_vectors.rs — TS 시절 골든벡터 교차검증 (byte-exactness SoT)
│   │
│   ├── tp-proto/                # 메시지 타입 parity (host-only rlib)
│   │   └── src/                 #   label.rs / control.rs / ipc.rs / relay_client.rs / keypair.rs / socket_path.rs
│   │       # tests/message_vectors.rs — TS 가드 교차검증
│   │
│   ├── tp-cli/                  # `tp` 바이너리 — clap 라우터 + passthrough terminal-proxy
│   │   └── src/                 #   commands/{daemon,run,relay,pair,session,status,logs,doctor,upgrade,version,completions}
│   │
│   ├── tp-daemon/                # 장기 실행 서비스
│   │   └── src/                  #   session/ (세션관리) · store/ (로컬 저장소) · transport/ (Relay client)
│   │                              #   worktree/ (git worktree) · ipc/ (Runner IPC 서버) · pairing/ · push/
│   │
│   ├── tp-runner/                # 세션당 프로세스
│   │   └── src/                  #   pty.rs(portable-pty) · settings.rs(hook 주입) · collector.rs(io/event Record)
│   │                              #   socket.rs(IPC/hook 소켓 경로) · hooks.rs(HookReceiver) · runner.rs(select! 루프)
│   │
│   ├── tp-relay/                 # WebSocket relay ([lib] tp_relay + [[bin]] tp-relay)
│   │   └── src/main.rs           #   THIN 바이너리 — 설정은 SharedState::from_env()
│   │
│   ├── tp-loopback/              # smoke 하니스용 in-process relay + 가짜 daemon peer
│   └── tp-e2e-holder/            # 로컬 실-claude E2E holder (dev 전용, 격리 daemon/relay/claude 구동)
│
├── scripts/
│   ├── ios.sh                  # 로컬 Apple 멀티플랫폼 하니스 (rust→gen→build→install→launch→smoke/test)
│   ├── build-bundle.sh         # release 번들 조립 (cargo 4-bin → tp-<suffix>.tar.gz)
│   └── install.sh              # curl-pipe-sh installer (GitHub Releases)
│
├── version.txt                 # 단일 버전 SoT (release-please `release-type: simple`)
├── release-please-config.json
├── .release-please-manifest.json
├── CLAUDE.md
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
portable-pty spawn          Runner 프로세스 (Rust, rust/tp-runner/src/pty.rs)
    │
    ├── reader thread ──────▶ Record { kind: "io", payload: raw_bytes }
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
    │                         Swift 앱 (E2EE decrypt)
    │                              │
    │                              ├── Terminal 탭: 터미널 렌더러(SwiftTerm)에 rawBytes 전달
    │                              └── Chat 탭: hooks events 전용 (io records 는 Terminal 탭으로만)
    │
    ◀── pty.write(input) ◀── 앱 입력 (역방향)
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
Runner → pty.write(user_text + "\r")   # 인터랙티브 claude TUI는 "\r"에만 제출, "\n"은 입력창에 남고 미제출
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

와이어 상의 논리적 필드 집합은 다음과 같다(필드명 SoT는 `.claude/rules/protocol.md`):

```
t   FrameType   "hello" | "attach" | "rec" | "batch" | ...
sid string?     Session ID
seq number?     단조 증가 시퀀스
k   RecordKind? "io" | "event" | "meta"
ns  string?     네임스페이스: "claude" | "tp" | "runner" | "daemon"
n   string?     이벤트 이름
d   unknown?    payload
c   number?     cursor (resume 시)
ts  number?     Unix timestamp (ms)
e   string?     error code
m   string?     message
```

**Rust 쪽에는 이 11필드를 전부 갖는 단일 struct 가 없다** — 신뢰 경계별로 별도 타입이다:
- **Runner ↔ Daemon IPC**: `IpcMessage` enum (`rust/tp-proto/src/ipc.rs`, `#[serde(tag = "t")]`, `Hello`/`Rec`/`Bye`/`Ack`/`Input`/`Resize` 포함 다수 variant), `RecordKind`/`Namespace` 서브 enum 포함.
- **App(Frontend) ↔ Daemon (relay 경유 control 메시지)**: 타입 없는 `serde_json::Value` 를 `"t"` 문자열로 매치 (`rust/tp-daemon/src/ipc/command_dispatcher.rs` `"hello"`/`"attach"`/`"detach"`/`"resume"`/`"ping"`/`"state"`/`"batch"`/`"err"` 등; `in.chat`/`in.term` 입력은 `rust/tp-daemon/src/transport/relay_client.rs` 가 `InputKind::Chat|Term` 으로 매핑).
- **Relay ↔ Client**: `RelayClientMessage`(`rust/tp-proto/src/relay_client.rs`, client→relay) + relay 서버 메시지 enum(`rust/tp-relay/src/messages.rs`, relay→client).
- **바깥 framing codec** (`u32_be length + JSON` 래핑, payload 구조와 무관): `rust/tp-core/src/codec.rs` 의 `encode_frame`/`FrameDecoder`.
```

### 4.3 Frame Type 흐름

```
앱 → Daemon:
  hello     초기 핸드셰이크
  attach    Session 연결
  detach    Session 분리
  resume    마지막 seq 이후 레코드 요청
  in.chat   Chat 입력
  in.term   Terminal 입력
  ping      keepalive

Daemon → 앱:
  hello     핸드셰이크 응답
  state     Session 상태 스냅샷
  rec       단일 Record
  batch     복수 Record (resume 응답)
  pong      keepalive 응답
  err       에러

Relay Protocol v2 (Daemon/앱 ↔ Relay):
  relay.register   Daemon token self-registration (proof 기반)
  relay.auth       인증 (frontendId 포함)
  relay.auth.resume HMAC 토큰 fast-path 재연결 (relay 재시작 생존)
  relay.kx         in-band pubkey 교환 (kxKey로 암호화)
  relay.pub        암호화 데이터 publish
  relay.sub/unsub  세션 구독/해제
  relay.frame      암호화 데이터 수신 (frontendId 포함)
  relay.kx.frame   pubkey 교환 수신
  relay.presence   Daemon online/offline + 세션 목록
  relay.push       Daemon → Relay: 대상 앱에 push 발송 요청 (token+title+body+interruptionLevel?+data)
                   interruptionLevel = "active" | "time-sensitive" (옵셔널, 미지정 → active).
                   attention-needed 이벤트(PermissionRequest/Notification/Elicitation)는 time-sensitive
                   로 Focus/DND 돌파 + APNs priority 10. 정보성 이벤트는 active (Focus 존중).
  relay.push.register  앱 → Relay: push token 등록 (sealed + platform). Relay 가 PushSealer 로
                   봉인하여 relay.push.token 으로 Daemon 에 라우팅.
  relay.push.token Relay → Daemon: 봉인된 push token (frontendId + sealed blob + platform). Daemon 이
                   복호화 후 APNs push API 호출에 사용.
  relay.notification Relay → 앱: push payload 전달 (앱이 백그라운드일 때 알림)
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
  │   {secret, pk, relay, id,│                          │  (QR v4: +pairingId, +hostname)
  │    pairingId, hostname}   │                          │
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

- **하나의 Daemon ↔ N개 Frontend**: Daemon(Rust, `rust/tp-daemon/src/transport/relay_client.rs`)은
  `peers: HashMap<frontendId, FrontendPeer>`(`FrontendPeer` 가 `SessionKeys` 보유)로 frontend별
  독립 E2EE 세션 키를 관리. `publish_record()` 시 각 peer에게 별도 암호화.
- **하나의 App ↔ N개 Daemon**: Swift 앱은 daemon별 독립 pairing/relay 연결을 관리 (구조체명은
  `ios/Sources/` 참조).
- **Relay 라우팅**: relay frame의 `frontendId`로 daemon이 O(1) peer lookup.
  Relay는 daemonId별 그룹 내에서 frame을 forwarding.

### 5.4 Pairing 영속화

- **Daemon**: vault SQLite의 `pairings` 테이블(`rust/tp-daemon/src/store/`)에 key pair + pairing
  secret 저장. 재시작 시 `reconnect_saved_relays()`(`rust/tp-daemon/src/daemon.rs`)로 자동 재연결.
- **Swift 앱**: Keychain에 페어링 정보를 daemon별로 저장 (구현 완료 — 상세는 `ios/Sources/`).

### 5.5 암호화 프레임 구조

```
┌──────────┬──────────────────────────────┐
│ nonce    │ ciphertext + auth tag        │
│ (24B)    │ (variable, 16B tag appended) │
└──────────┴──────────────────────────────┘
```

libsodium의 `xchacha20poly1305_ietf_encrypt`와 동일한 레이아웃(ciphertext에 auth tag를
concatenate)을 Rust `tp-core`(`rust/tp-core/src/crypto.rs`, `chacha20poly1305` crate)가 구현한다.
전체가 표준 base64(URL-safe 아님)로 인코딩되어 Envelope의 필드로 전달된다.
Relay는 이 암호화된 blob만 중계한다. 내용을 알 수 없다.

### 5.6 Pairing Confirmation (PCT) + 버전 게이트 (WS v3 / QR v4, #49)

`relay.kx` 는 정적 `pairingSecret` 파생 kxKey 로만 복호되므로 그 자체엔 freshness binding 이
없다 — hostile relay 가 캐시한 옛 kx broadcast 를 재생하면 앱이 잘못된 daemon 으로 오인할 수 있다.
**Pairing Confirmation Tag (PCT)** 는 이 kx epoch 이 실제로 살아있는 상대와 성립했음을 증명한다:

- **PCT 계산**: kx 완료 후 확립된 **per-frontend 세션키**에 도메인 분리 BLAKE2b 를 적용
  (`derive_pairing_confirmation_tag`, `rust/tp-core/src/crypto.rs` — TS/Swift 와 byte-exact
  골든벡터 교차검증). daemon 은 frontend-role 세션키로, 앱은 자기 세션키로 각각 계산 → 동일 tag 로 수렴.
- **전달**: daemon 이 `hello` 프레임에 per-frontend `pct` (base64) 를 실어 보낸다 (auto-hello +
  on-demand `case "hello"` 두 빌더 모두). 앱은 자기 PCT_app 과 대조한다.
- **승격 판정 (§1.3 4셀)**: 입력 = `hello.d.pct` (present/absent) + `effectiveV = max(이번
  epoch 의 kx-advertised v, 저장된 `minAdvertisedV` floor)`.
  1. `pct` 일치 → **COMMITTED (confirmed)**.
  2. `pct` 불일치 → **FAILED** (tamper/replay).
  3. `pct` 부재 & `effectiveV < 3` → **COMMITTED (legacy, confirmed=false)** — 진짜 구 daemon.
  4. `pct` 부재 & `effectiveV ≥ 3` → **FAILED** (v≥3 daemon 이 pct 를 빠뜨림 = downgrade 신호).
- **`minAdvertisedV` floor**: v≥3 증거를 한 번이라도 본 페어링은 device-local floor 를 3 이상으로
  올려, 재생된 v=2 kx 로도 `effectiveV < 3` 이 될 수 없게 한다 (wire 무변경 replay 방어).

**버전 게이트 의미론**: `WS_PROTOCOL_VERSION`(`rust/tp-daemon/src/transport/relay_client.rs`)은
daemon(`broadcast_daemon_public_key()`)과 앱이 kx 페이로드 `v` 로 광고하는 값이다. **v3** 부터 위 PCT + QR v4 를 뜻한다.
`pct` 는 additive-optional 이므로 (구 앱은 무시, 구 daemon 은 미발신) **강한 handshake 게이트는 없다** —
위 §1.3 승격 판정 표(`effectiveV` + floor)가 유일한 판별 지점이다. QR **v4** 번들은 랜덤 UUID
`pairingId` (재페어 시 새 값) + `hostname` (표시 라벨)을 추가한다; 디코더는 v2/v3/v4 를 모두 수용하고,
legacy(v2/v3)는 `pairingId` 를 daemonId 파생 결정론 UUID(`derive_legacy_pairing_id`)로 채운다.

## 6. Runner PTY 관리

### 6.1 PTY 관리

**`portable-pty`** (wezterm crate, macOS/Linux): `rust/tp-runner/src/pty.rs`. `PtySystem::openpty(size)`
로 `PtyPair{master, slave}`를 얻고, `slave.spawn_command(cmd)`로 claude 프로세스를 스폰한다.
`master.try_clone_reader()`가 반환하는 **blocking** `Read`는 전용 reader 스레드가 읽어 `on_data`
콜백을 호출한다(Bun의 async `data()` 콜백 표면과 동등 — "reader-task hop"). `master.take_writer()`/
`master.resize()`로 입력·리사이즈, `child.clone_killer()`로 kill. 종료 시 waiter 스레드가
reader-done rendezvous 채널을 `READER_DRAIN_GRACE=200ms`로 bounded-wait해 reader/waiter 순서
레이스를 닫는다. Windows 네이티브 실행은 지원하지 않으며, Windows 사용자는 WSL 안에서 Linux 빌드를
실행한다.

### 6.1a hooks 설정 주입 상세

Runner는 `claude --settings <json>` 플래그로 hooks 설정을 인라인 주입한다(`rust/tp-runner/src/settings.rs`).
`.claude/settings.local.json`을 수정하지 않으므로 사용자 설정과 충돌하지 않는다. 16개 알려진 hook
이벤트(`HOOK_EVENTS`) 각각에 tp capture 커맨드 엔트리를 병합하고, 기존 프로젝트 설정의 알 수 없는
이벤트 키/비-hooks 필드는 그대로 보존한다.

```rust
// rust/tp-runner/src/settings.rs (개념 요약 — 실제 구현은 build_settings/capture_hook_command)
pub const HOOK_EVENTS: [&str; 16] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure",
    "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
    "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
    "Elicitation", "ElicitationResult",
];

// 각 이벤트에 병합되는 훅 엔트리: {matcher:"", hooks:[{type:"command", command, timeout:10}]}
// command 자체는 hook 프로세스가 HookReceiver 유닉스 소켓에 stdin JSON을 전달하는
// 짧은 `bun -e '<script>'` one-liner(capture_hook_command) — Runner 프로세스 자체는
// Rust 이지만, hook 스크립트 인터프리터로 bun 이 여전히 필요하다(claude 가 실행하는
// 별도 자식 프로세스, Runner 바이너리와 무관).

let settings_json = build_settings(&hook_socket_path, Some(&worktree_path));
// portable-pty 로 claude 스폰:
//   slave.spawn_command(CommandBuilder{ argv: ["claude", "--settings", settings_json], cwd, .. })
```

io Record 생성은 `rust/tp-runner/src/collector.rs`의 `Collector::io_record`가 담당한다 — PTY 바이트는
JSON payload 가 아니라 프레임의 **binary sidecar**로 실려(base64 오버헤드 회피) Daemon에 IPC 전송된다.

### 6.2 Hooks 수집

Claude Code hooks는 특정 이벤트 발생 시 지정된 스크립트를 실행한다.
hook 스크립트(`bun -e` one-liner, §6.1a)는 stdin으로 JSON을 받아 Runner의 HookReceiver 유닉스
소켓(`hook-<sid>.sock`)에 그대로 전달한다. `HookReceiver`(`rust/tp-runner/src/hooks.rs`, tokio
`UnixListener`)가 청크를 누적하며 최대 1 MiB(UTF-8 바이트)까지 파싱을 시도하고, 유효한 JSON이
되면 `parse_hook_event`로 구조를 검증(`hook_event_name`이 알려진 16개 이벤트 중 하나 + 문자열
`session_id`/`cwd`)한 뒤 Runner로 forward한다. HookReceiver → Runner → Daemon (IPC) → Store
순서로 event Record가 전파된다.

```
stdin JSON 필드: session_id, hook_event_name, cwd, ...
Stop 이벤트: last_assistant_message 필드 포함
PreToolUse: tool_name, tool_input 필드 포함
```

Record 조립은 `Collector::event_record`(`rust/tp-runner/src/collector.rs`)가 담당 — 이벤트 JSON을
base64로 `payload`에 인코딩하고 `ns="claude"`, `name=hook_event_name`을 설정한다.

### 6.3 ANSI 처리 전략

PTY에서 나오는 raw bytes는 ANSI escape 시퀀스(색상, 커서 이동, 대체 화면 버퍼 등)를 포함한다.

```
Terminal 탭: raw bytes → 터미널 렌더러(SwiftTerm)에 전달 — ANSI 완벽 재현, 직접 파싱 불필요
Chat 탭:    io records 미사용 — hooks events 전용 (hooks-only, PR #457에서 PTY 폴백 제거)
```

터미널 렌더러는 SwiftTerm으로 확정되었다(`ios/` — CLAUDE.md 참조). 구 Bun 레퍼런스 구현은
ghostty-web(libghostty WASM, Canvas 2D)을 사용했다 (기록용, #5 PR6에서 삭제).

## 7. 앱 아키텍처

> **재작성 상태:** ADR-0001/0003 전면 네이티브 재작성 완료 — 백엔드/CLI는 Rust(`rust/`)가 유일
> 구현, 앱은 Swift(SwiftUI) 단일 멀티플랫폼 타깃. 현재 출하 범위(Phase A) = iOS/iPadOS/네이티브
> macOS 완전 경험; visionOS 완전 + watchOS 제한 경험은 별도 `TeleprompterWatch` 타깃으로 toolchain
> 게이트 뒤 Phase B (ADR-0002). pairing/E2EE/Chat/Terminal/음성 기능 parity 구현 완료 — 상세 검증
> 매트릭스는 `.claude/rules/native-testing.md`.

### 7.1 Swift 앱 구조

```
ios/
  project.yml              # XcodeGen 스펙 (SoT — 멀티플랫폼 타깃 + 별도 TeleprompterWatch 타깃)
  Sources/                 # SwiftUI 앱 소스 (Session/, Voice/, Nav/, App/, TpCoreCheck.swift 등)
  Tests/                   # XCTest
  UITests/                 # XCUITest (TeleprompterUITests 타깃)
  Generated/                # UniFFI 바인딩 (tp_core.swift 등, gitignored, 재현 가능)
  Teleprompter.xcodeproj   # XcodeGen 생성물 (gitignored)

scripts/ios.sh             # 로컬 Apple 멀티플랫폼 하니스: rust→gen→build→install→launch→smoke/test/uitest
```

### 7.2 빌드 / 검증

```bash
scripts/ios.sh rust     # TpCore.xcframework (7 슬라이스) + UniFFI 바인딩
scripts/ios.sh gen      # xcodegen generate
scripts/ios.sh build    # xcodebuild
scripts/ios.sh smoke    # rust→gen→build→install→launch + 마커 검증 (TP_PLATFORM=ios|macos|visionos|watchos)
scripts/ios.sh test     # XCTest
scripts/ios.sh uitest-all  # XCUITest UI E2E 전 플랫폼 매트릭스
```

EAS 클라우드 빌드는 제거됨 (ADR-0001). 로컬 `scripts/ios.sh` 하니스가 유일 빌드/검증 경로 —
`TP_PLATFORM` 환경변수로 iOS Simulator(기본) / 네이티브 macOS / visionOS Simulator / watchOS
Simulator 분기.

### 7.3 Chat UI 렌더링 파이프라인

구현 완료 (`ios/Sources/Session/ChatView.swift`, `ChatComposer.swift`, `SessionStore.swift`).

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

데이터 전략(hooks-only, io records는 Terminal 탭 전용)은 구 Bun 레퍼런스 구현과 동일하게 유지한다.

## 8. 음성 UX 아키텍처

구현 완료 — `ios/Sources/Voice/` (`VoiceBackend.swift` 프로토콜 시임 위에 `OnDeviceVoiceClient.swift`와
`RealtimeClient.swift` 두 백엔드). 설정에서 Auto / On-device / OpenAI Realtime 전환 가능, 키 없을 때
기본은 on-device.

```
┌──────────────────────────────────────────────────────────────────┐
│  Swift 앱 (ios/Sources/Voice/, VoiceConnectionStatus 상태머신)      │
│                                                                    │
│  ┌──────────┐   backend A: OnDeviceVoiceClient (오프라인, 키 불필요) │
│  │ 마이크    │──▶  SFSpeechRecognizer(STT) + Foundation Models      │
│  │ (VAD)    │      (iOS 26+, 요약/정제, raw-transcript fallback)    │
│  └──────────┘      + AVSpeechSynthesizer(TTS)                     │
│                                                                    │
│  ┌──────────┐   backend B: RealtimeClient (OpenAI Realtime API,    │
│  │ 스피커    │◀──  WebSocket, 키 필요) — STT+정제+TTS 단일 세션      │
│  │ (TTS)    │      system prompt: Chat 요약 + Terminal 상태         │
│  └──────────┘                                                     │
│                            │                                      │
│                     정제된 프롬프트                                 │
│                            ▼                                      │
│                  ┌─────────────────┐                              │
│                  │ Claude Code     │                              │
│                  │ Session 입력    │                              │
│                  └─────────────────┘                              │
└──────────────────────────────────────────────────────────────────┘
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

Rust `tp-runner`의 IPC 클라이언트(`rust/tp-runner/src/ipc.rs`)는 tokio 비동기 태스크로 구성된다 —
writer 태스크가 outbound bounded `mpsc::channel`(용량 `OUTBOUND_CAPACITY`, PTY burst를 흡수)에서
프레임을 소비해 소켓에 쓰고, reader 태스크는 `ack`/`input`/`resize`만 허용하는 inbound allowlist로
Runner의 select 루프에 전달한다. 채널이 가득 차 send 가 실패하면 **연결을 닫아** Runner에 실패를
드러낸다 (자원을 무한정 버퍼링하며 조용히 데이터를 버리지 않음 — "overflow → close" 불변식).
**decode-throw teardown**: 프로토콜 위반(오버사이즈 length/깨진 JSON) 프레임은 디코더가 `Err`를
반환하고 연결을 닫아, 이후 io/hook 프레임을 조용히 계속 드롭하며 연결이 걸려있는 상태를 방지한다.

### 9.4 Hook 스크립트 IPC

Hook 스크립트는 Claude Code가 별도 프로세스로 실행하므로, Runner의 HookReceiver 소켓에 연결해야 한다.
Runner 프로세스 자체는 Rust이지만, hook 스크립트는 claude가 실행하는 짧은 one-liner이므로
플랫폼 의존 도구(nc, socat) 대신 여전히 `bun -e`를 인터프리터로 쓴다(`capture_hook_command`,
`rust/tp-runner/src/settings.rs`):

```
Hook 스크립트(bun -e one-liner) → HookReceiver (Runner 프로세스 내 tokio UnixListener) → Runner → Daemon (IPC)
```

HookReceiver 소켓 경로: `<runtime_dir>/hook-<sid>.sock` (세션별 별도 소켓; `runtime_dir` 해석은
§9.1과 동일 — `$XDG_RUNTIME_DIR` → `/run/user/<uid>` → `/tmp/teleprompter-<uid>`).

```
# 실제 구현: rust/tp-runner/src/settings.rs capture_hook_command()
# hook_socket_path를 JSON 문자열 리터럴로 임베드한 뒤 다음 스크립트를 bun -e로 실행:
const d = await Bun.stdin.text();
const s = await Bun.connect({
  unix: "<hook_socket_path>",
  socket: { open(s) { s.write(d); s.end(); }, data() {}, error() {} },
});
```

HookReceiver 자체(수신측)는 Rust `tokio::net::UnixListener`(`rust/tp-runner/src/hooks.rs`)로,
청크를 최대 1 MiB(UTF-8 바이트)까지 누적하며 파싱을 시도하고 `parse_hook_event`로 구조를
검증한다 (§6.2 참조).
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

# 로컬 dev daemon 실행
cd rust && cargo build --release --bin tp --bin tp-daemon --bin tp-runner --bin tp-relay
./target/release/tp daemon start    # 포그라운드 실행 (locate_tp_daemon() 없이 직접)

# release 번들 조립 (scripts/build-bundle.sh <suffix> <rust-target>)
scripts/build-bundle.sh darwin_arm64 aarch64-apple-darwin
#   → dist/bundles/tp-darwin_arm64/{bin/tp, libexec/tp/{tp-daemon,tp-relay,tp-runner,tpd-stub}}
#   → dist/tp-darwin_arm64.tar.gz

# Self-spawn / 자식 프로세스 탐색 메커니즘 (Bun self-spawn 을 대체)
# tp daemon start  → locate_tp_daemon()  로 libexec/tp/tp-daemon 실행 (exec)
# daemon 이 세션마다 → locate_tp_runner() 로 libexec/tp/tp-runner 스폰
# tp relay start   → locate_tp_relay()   로 libexec/tp/tp-relay 실행 (exec)
# 3개 resolver 는 canonicalize(current_exe())/../../libexec/tp/<name> 로 sibling 탐색
# (rust/tp-proto/src/locate.rs 또는 rust/tp-cli/src/locate.rs 참조)
```

### GitHub Release (Release Please)

릴리즈 플로우 (`tp` CLI 바이너리 기준):
1. `release-please.yml` (workflow_dispatch 전용 — push 트리거 없음). 한 dispatch당 한 동작만 수행하므로
   patch 릴리즈는 dispatch 2회가 필요하다:
   - 1차 dispatch → 버전 PR 생성/갱신 (CHANGELOG, `version.txt` 업데이트)
   - PR 머지 후 2차 dispatch → `vX.Y.Z` 태그 push
2. `release.yml` (push: tags `v*` + workflow_dispatch) → `scripts/build-bundle.sh` 로 darwin-arm64 +
   linux-x64/arm64 Rust 4-bin(`tp`/`tp-daemon`/`tp-relay`/`tp-runner`) prefix-tree 번들 빌드,
   GitHub Release 생성, 이어서 Homebrew tap(`DaveDev42/homebrew-tap-release`) formula 갱신,
   이어서 `testflight.yml` dispatch (5-플랫폼 TestFlight 업로드).
   (#172 push-event 누락 케이스가 잦아 실무에선 항상 manual dispatch로 트리거)

> **EAS/App Store 배포는 제거됨.** Expo 앱 삭제 + EAS 인프라 철거 완료 (ADR-0001). Swift 앱은
> `scripts/ios.sh archive` + `testflight.yml`(App Store Connect 업로드, ADR-0004)로 배포한다.

```bash
# 설치 (curl-pipe-sh)
curl -fsSL https://raw.githubusercontent.com/DaveDev42/teleprompter/main/scripts/install.sh | bash
```

버전 관리:
- `version.txt` 단일 버전 → Release Please가 관리 (`release-type: simple`; `rust/tp-cli/build.rs` 가
  빌드타임에 읽어 `TP_CLI_VERSION`으로 굽는다). 구 root `package.json` 버전 필드는 PR7에서 제거.
- 태그 패턴: `v*` (예: `v0.1.53`). release-please-config.json의 `include-component-in-tag: false` 라서 컴포넌트/접두사 없음.

### 10.2 Relay 서버

배포: `deploy-relay.yml` (main push 시 — `rust/tp-relay/**`, `rust/tp-proto/**`, `rust/tp-core/**`,
`rust/Cargo.lock`, 자기자신 경로 변경 시만 자동, 또는 수동 트리거). 구 `packages/relay,protocol,daemon`
트리거는 TS relay 퇴역과 함께 제거.
- ubuntu-latest에서 `cargo build --release --target <arch> --bin tp-relay` (서버 아키텍처 자동 감지,
  aarch64/x86_64) → SSH로 `/usr/local/bin/tp-relay` 전송 → systemd 서비스(`tp-relay.service`) 재시작
  → on-disk sha256 검증 + `/health.buildSha==github.sha` 검증
- **머지가 곧 `relay.tpmt.dev` 자동 cutover** (downtime-OK) — secrets 는 systemd drop-in
  (`/etc/systemd/system/tp-relay.service.d/secrets.conf`)에서 주입, 이 워크플로가 절대 안 건드림

### 10.3 Swift 앱 (로컬 하니스)

```bash
# 로컬 Apple 멀티플랫폼 하니스 (scripts/ios.sh)
scripts/ios.sh smoke                    # iOS Simulator (기본)
TP_PLATFORM=macos scripts/ios.sh smoke  # 네이티브 macOS
TP_PLATFORM=visionos scripts/ios.sh smoke
TP_PLATFORM=watchos scripts/ios.sh smoke

# 직접 빌드 (xcodebuild) — project.yml 은 XcodeGen 이 생성
xcodebuild -project ios/Teleprompter.xcodeproj \
  -scheme Teleprompter -destination 'platform=iOS Simulator,name=iPhone 17 Pro'

# TestFlight 배포 (ADR-0004)
scripts/ios.sh archive   # Release archive → 서명 → .ipa/.pkg export
```

EAS 클라우드 빌드는 제거됨 (ADR-0001). 모든 로컬 검증은 `scripts/ios.sh`(`TP_PLATFORM=ios|macos|
visionos|watchos`)로 수행한다. TestFlight 업로드는 `testflight.yml`(CD, `release.yml`이 자동 dispatch).
