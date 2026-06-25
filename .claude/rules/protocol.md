---
paths:
  - "packages/protocol/**"
---

# Protocol Package Conventions

## Export 구조
- `./src/index.ts` (메인): codec, socket, crypto, logger, types 전체 — 서버 전용 (Node/Bun)
- `./src/client.ts` (`/client`): crypto, pairing, logger, compat (version helpers), control-guard, relay-server-guard, session-server-guard, types — 프론트엔드 안전 (RN/Expo). 규칙: Node.js 전용 import(fs, path, net, socket-path, QueuedWriter, ipc-guard) 금지; pure-TS · sodium-safe 유틸은 추가 가능.
- 새 유틸 추가 시: 서버 전용이면 index.ts에만, 프론트엔드에도 필요하면 client.ts에도 export

## Type 파일 구조 (`src/types/`)
- 도메인당 1파일: `envelope.ts`, `event.ts`, `ipc.ts`, `label.ts`, `record.ts`, `relay.ts`, `session.ts`, `session-proto.ts`, `control.ts` (E2EE control messages riding the `__control__` sid — `control.unpair`, `control.rename`, etc.; `label.ts` — Label tagged union + wire decode helpers (`decodeWireLabel`, `decodeKxLabelOrKeep`))
- Namespace prefix: `Ipc*` (Runner↔Daemon), `Relay*` (Daemon↔Relay), `Session*` (Frontend↔Daemon session control/data, in `session-proto.ts`), `Control*` (peer-to-peer control messages)
- index.ts에서 re-export

## Envelope 필드명
`t`, `sid`, `seq`, `k`, `ns`, `n`, `d`, `c`, `ts`, `e`, `m` — 의도적 축약 (wire 효율). 리네이밍 금지.

## Framed JSON Codec
`u32_be length` + `utf-8 JSON payload` — IPC와 WS 모두 동일 포맷.

## Crypto
- Key exchange: X25519 via `crypto_kx` (daemon=server, frontend=client)
- Encryption: XChaCha20-Poly1305, random nonce per frame
- Key derivation: BLAKE2b (`crypto_generichash`), domain-separated (kxKey, registrationProof)
- 구현은 CryptoProvider seam: `crypto-provider.ts` interface + `__setCryptoProviderFactory`. 기본 provider = libsodium-wrappers (`crypto-provider-libsodium.ts` — factory 본문에서 lazy require, import 만으로는 evaluate 안 됨). 앱 native(Hermes)는 react-native-quick-crypto provider 를 주입 (`apps/app/src/lib/crypto-provider-native.ts`). 새 crypto 연산 추가 시 interface + 양쪽 provider + cross-provider 테스트를 함께 갱신
- Secret key 로깅 금지

## Wire-boundary Guards (`*-guard.ts` + `guard-primitives.ts`)

모든 untrusted wire 프레임은 핸들러가 필드를 읽기 전에 guard 를 통과해야 한다 (fail-closed). 숫자 필드는 단순 `isNumber` 가 아니라 **다운스트림 sink 의 범위**까지 좁힌다 — guard 가 받아들이면 sink 가 그 값을 신뢰하기 때문.

- **터미널 dimension (cols/rows) 은 uint16 [1, 65535] 로 cap** — `isTerminalDimension` / `isOptionalTerminalDimension` (`guard-primitives.ts`). `struct winsize.ws_col/ws_row` 가 kernel 에서 `unsigned short` 라 65536 은 0 으로 truncate 돼 PTY 를 degenerate 시킨다 (`pty-bun.ts` `terminal.resize`). 두 trust boundary 모두에 적용: frontend→daemon (`relay-guard.ts` `resize`/`session.create`) **와** daemon→runner (`ipc-guard.ts` `resize`) — daemon 이 relay-plane resize 를 IPC resize 로 forward 하므로 양쪽 다 cap 해야 truncation 이 막힌다. 65535 는 tunable 이 아니라 uint16 구조적 상한. 회귀 가드: `relay-guard.test.ts` / `ipc-guard.test.ts`. **Rust `tp-proto`**: `MAX_TERMINAL_DIMENSION = 65535` + `is_terminal_dimension()` (`rust/tp-proto/src/lib.rs:88-108`); 적용: `parse_ipc_message` resize arm (`rust/tp-proto/src/ipc.rs:402-403`). 골든벡터 케이스: `resize-cols-max`(65535 accept), `resize-cols-too-big`(65536 reject) — `message_vectors.rs` 크로스-impl 게이트.
- **`session.export` `limit` 은 positive integer 로 좁힌다** (`isOptionalPositiveInt`, not `isOptionalNumber`). `-1` 이 guard 를 통과하면 다운스트림 `Math.min(-1, 50000) = -1` → SQLite `LIMIT -1` (= no-limit) 로 50000-row export cap 을 우회한다 (대형 세션 전량 직렬화 → 메모리 스파이크). "unlimited" semantics 는 필드 부재로만 표현 (0 아님). 회귀 가드: `relay-guard.test.ts`.
- **`relay.push.register` `token` 은 platform-aware length cap** — `MAX_PUSH_TOKEN_LEN` (`relay-client-guard.ts`): ios(APNs) 128, android(FCM) 1024. zero-trust relay boundary 에서 `pushSealer.seal()` 의 대용량 alloc 을 막되, FCM 토큰은 opaque 하고 ~140–200+ 자라 단일 128 cap 이면 정당한 android 토큰을 reject 한다 (wire 타입이 `platform: "android"` 를 허용하므로). `platform` 을 먼저 검증한 뒤 그 discriminant 로 bound 를 고른다. 회귀 가드: `relay-client-guard.test.ts`. **Rust `tp-proto`**: `MAX_PUSH_TOKEN_IOS = 128` / `MAX_PUSH_TOKEN_ANDROID = 1024` (`rust/tp-proto/src/relay_client.rs:21-27`); `platform` 먼저 parse 후 cap 적용 (`relay_client.rs:280-287`). 바이트 길이(`.len()`) 사용 — 토큰이 ASCII-only(hex/base64url)라 `.chars().count()` 와 동일; `tp-core/pairing.rs` 의 `MAX_PAIRING_B64_LEN` 선례와 일치. 골든벡터 케이스: `push-register-token-too-long-ios`(len 129, ios → reject), `push-register-token-ok-android`(len 200, android → accept — flat-128-cap 회귀 가드) — `message_vectors.rs` 크로스-impl 게이트.
- **Pairing deep-link 디코더는 native 디코더와 동일하게 strict 하다** (`pairing.ts` `decodeBinaryPairing`). (1) base64url `d` 페이로드는 디코딩 전에 **2048 char 로 pre-cap** (`MAX_PAIRING_B64_LEN`) — `base64UrlToBytes` alloc 전에 거부해 attacker-controlled allocation 을 bound. 정상 v2/v3 번들은 ~772 char 라 구조적으로 유효한 입력은 절대 cap 을 넘지 못한다 (회귀 가드는 v3 가 trailing byte 를 무시하는 점을 이용해 *구조적으로 유효하지만* over-cap 인 페이로드를 만든다). (2) did/relay/magic 필드는 **strict UTF-8** (`new TextDecoder("utf-8", { fatal: true })`) — lenient 디코더의 U+FFFD substitution 대신 invalid UTF-8 을 거부. 둘 다 live native 디코더 `rust/tp-core/src/pairing.rs` (`MAX_PAIRING_B64_LEN = 2048`, `str::from_utf8`) 와 byte-for-byte reject 동작을 맞춘다. 회귀 가드: `pairing.test.ts` (over-length·invalid-UTF-8 둘 다 pre-fix 소스에서 fail 함을 증명).

## Relay Protocol v2 (wire messages)

CLAUDE.md 의 "Protocol" 섹션은 프레임 포맷 + v2 메시지 한 줄 요약만 둔다. 아래가 wire 상세 SoT.

- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.auth.resume` — fast-path reconnect carrying an HMAC-signed token issued in the prior `relay.auth.ok`. Relay verifies the signature without per-daemon state, so resume survives a relay restart as long as `TP_RELAY_RESUME_SECRET` persists. On `auth.err` the client drops the cached token and falls back to full register+auth on the next connect. Daemon side also skips the `relay.kx` rebroadcast when resumed and peers are still cached, since the keypair is stable across reconnects (existing peers' sessionKeys remain valid).
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `relay.push.register` — frontend → relay (cleartext). Registers a plaintext APNs device token with the relay. Fields: `frontendId` (self-identifying), `token` (plaintext APNs device token hex string), `platform` (`"ios" | "android"`). Relay seals the token with `PushSealer` (XChaCha20-Poly1305, key derived from `TP_RELAY_PUSH_SEAL_SECRET` via `derivePushSealKey`) and forwards a `relay.push.token` frame to the daemon. If no daemon is connected, the registration is silently dropped (frontend re-registers on next relay connect).
- `relay.push.token` — relay → daemon (cleartext). Delivers a sealed APNs device token to the daemon. Fields: `frontendId`, `sealed` (blob: `"tpps1.<version>.<base64(nonce24||ciphertext)>"`), `platform`. Daemon calls `pushNotifier.registerSealedToken(...)` and persists to SQLite (`push_tokens` table). The `sealed` blob is never decrypted by the daemon — it is forwarded as-is inside `relay.push` when a push is needed. Relay unseals at send time.
- `relay.push` — daemon → relay request to send an APNs push to a target frontend. **`sealed` is REQUIRED** (the legacy plaintext `token` field has been removed). Carries `frontendId`, `sealed` (blob from daemon's store), `title`, `body`, optional `interruptionLevel`, optional `data`. Relay unseals the token with `PushSealer` (tries current key then prev key for rotation), then POSTs to APNs HTTP/2 (`https://api[.sandbox].push.apple.com/3/device/<token>`) using ES256 JWT auth (`ApnsJwtSigner`, 50-min cache). **Error handling:** unseal failure → `relay.err PUSH_UNSEAL_FAILED`; APNs 400 `BadDeviceToken` or 410 `Unregistered` → `relay.err PUSH_TOKEN_DEAD` (daemon deletes the push_token row, frontend re-registers on next connect); non-dead APNs errors → `relay.err PUSH_DELIVERY_ERROR`. The `interruptionLevel` field (`"active" | "time-sensitive"`; absent → `"active"`) maps to APNs `aps.interruption-level`; for `time-sensitive` only, `apns-priority: 10` is set so the push cannot be deferred. The privileged `"critical"` level is intentionally **not** modeled; the wire guard rejects any `interruptionLevel` other than the two allowed strings. **Per-event differentiation lives in the daemon** (`push-notifier.ts` `interruptionLevelFor`). APNs environment (`sandbox` vs `prod`) is configured per-deployment via `APNS_ENV` — not on the wire.
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.remove` IPC (fallback when daemon is stopped: direct `Store` write, peer learns on next reconnect).
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.rename` IPC (fallback when daemon is stopped: direct `Store` write, peer syncs on next reconnect). The `label` field is the `Label` **tagged union** (`{ set: true, value } | { set: false }`) — `{ set: false }` is an authoritative clear; `{ set: true, value }` sets the label. **ADR-0003 Amendment 1 (A1.3#1):** the per-peer version-gate has been removed — the daemon always emits the union object unconditionally (never the legacy string). Both sides advertise their WS protocol version in the `relay.kx` payload (`v`) — retained for future gating of new message types, not for label downgrade. Readers normalize either shape (legacy string or union) via `decodeWireLabel` (authoritative-clear surfaces: ControlRename inbound on **both** daemon and app, IPC, SQLite) or `decodeKxLabelOrKeep` (keep-current surfaces: relay.kx daemon-hello, meta `hello` daemonLabel — field absence is the preferred keep-current signal; both absent and `{ set: false }` are accepted as keep-current for back-compat). The label helpers live in `packages/protocol/src/types/label.ts`.
- Connection flow — **fast-path (reconnect):** daemon `auth.resume → (ok; kx rebroadcast skipped if peers cached)`; frontend `auth.resume → (ok; kx skipped)`. On `auth.err` both sides drop the cached token and fall back to the slow path. **Slow path (first connect):** daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`.
