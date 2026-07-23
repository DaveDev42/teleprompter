---
paths:
  - "rust/tp-proto/**"
  - "rust/tp-core/**"
---

# Protocol Package Conventions

The wire protocol lives in two Rust crates. **`rust/tp-proto`** owns the
server-only wire-message *parse boundaries* — the fallible `parse_*(raw:
&serde_json::Value) -> Option<T>` guards that narrow untrusted JSON at each
trust boundary (IPC, relay-client, control-plane) — plus shared primitive
guards, the `Label` tagged union, session-id/socket-path safety, and the
`tp-runner` binary locator. **`rust/tp-core`** owns the transport-agnostic,
pure-function core (framed-JSON codec, E2EE crypto, QR pairing encode/decode)
that is also exposed to the Swift app via UniFFI. Byte-exactness across the
former TS implementation is locked by golden vectors generated from the
retired `libsodium-wrappers`/TS guard path.

## `tp-proto` module structure (`rust/tp-proto/src/`)

- `lib.rs` — crate root: re-exports + the shared primitive guards (`req_string`,
  `is_number`, `is_non_negative_int`, `is_positive_int`, `is_terminal_dimension`,
  `as_string_array`, `req_bool`, `opt_string`, `opt_number`) and
  `MAX_TERMINAL_DIMENSION`. This is the **only** place numeric/string wire
  semantics live — every guard elsewhere composes these.
- `ipc.rs` — Runner ↔ Daemon messages (`IpcMessage`, `parse_ipc_message`, 27
  variants: `hello`/`rec`/`bye`/`ack`/`input`/`resize`/`pair.*`/`session.*`/
  `doctor.*`). Namespace prefix `Ipc*`.
- `relay_client.rs` — Client → Relay messages (`RelayClientMessage`,
  `parse_relay_client_message`, 10 variants: `relay.auth`/`relay.auth.resume`/
  `relay.register`/`relay.kx`/`relay.pub`/`relay.sub`/`relay.unsub`/
  `relay.ping`/`relay.push`/`relay.push.register`). Namespace prefix `Relay*`.
  Also owns the push-token format constants (`MAX_PUSH_TOKEN_ANDROID`,
  `is_ios_apns_token`).
- `control.rs` — decrypted E2EE control-plane messages that ride the
  `__control__` sid (`ControlMessage`, `parse_control_message`:
  `control.unpair` / `control.rename`). Namespace prefix `Control*`. The most
  dangerous unguarded surface — after decryption the JSON is untyped.
- `label.rs` — the `Label` tagged union (`Set { value } | Unset`) + the
  forgiving decoders (`decode_wire_label`, `decode_label_opt_field`,
  `decode_kx_label_or_keep`, `make_label`, `label_to_nullable`).
- `socket_path.rs` — `assert_safe_sid` (sid allowlist guard), `sanitize_for_sid`
  (branch-name → safe-sid collapse), `resolve_runtime_dir`/`socket_path`
  (daemon IPC socket resolution shared by daemon bind-side and CLI
  connect-side).
- `keypair.rs` — `generate_keypair()`, the one non-deterministic primitive
  `tp-core` deliberately lacks (X25519 keypair from the OS CSPRNG, byte-shape
  matched to `tp-core::crypto::KxKeyPair`).
- `locate.rs` — `locate_tp_runner()`, the shared resolver both `tp-daemon`
  (spawns a runner per session) and `tp-cli` depend on for the shipped
  `tp-runner` binary path (env override → release prefix tree → sibling →
  dev fallback). Lives here (not in `tp-cli`) because it now has two
  independent consumers that must never resolve different binaries — see the
  module's own doc comment for the full rationale.

There is no server-only-vs-frontend-safe file split anymore (the old TS
`index.ts`/`client.ts` split). The Rust-era split is by **audience**:
`tp-proto` is a host-only sibling of `tp-core` — Rust code linked into
`tp-cli`/`tp-daemon`/`tp-relay` only, never shipped to the Swift app. `tp-core`
is the crate that crosses the FFI boundary: every symbol meant to run inside
the Swift app must be a pure function in `tp-core` exported via
`#[uniffi::export]` in `tp-core/src/lib.rs` (see the "Crypto" section below).
**Where to add a new wire type or utility**: a new parse boundary or guard
primitive → `tp-proto` (pick the module matching its trust boundary, or
`lib.rs` if it's a new shared primitive guard). A new pure crypto/codec/pairing
operation that the Swift app also needs → `tp-core`, with a matching
`#[uniffi::export]` wrapper + golden-vector case.

## `tp-core` module structure (`rust/tp-core/src/`)

- `lib.rs` — crate root: FFI-facing record/enum mirrors (`FfiFrame`,
  `FfiKeyPair`, `FfiSessionKeys`, `FfiPairingData`) + every `#[uniffi::export]`
  function the Swift app calls (codec encode/decode, KDF derivations, AEAD
  seal/open, kx session-key derivation, ratchet, pairing encode/decode, PCT
  derivation, `tp_core_version()`).
- `codec.rs` — the framed-JSON codec (`encode_frame`, `FrameDecoder`).
- `crypto.rs` — E2EE primitives: BLAKE2b KDF domains (`derive_relay_token`,
  `derive_kx_key`, `derive_push_seal_key`, `derive_registration_proof`),
  XChaCha20-Poly1305 seal/open, X25519 `crypto_kx` session-key derivation,
  per-session ratchet, and the Pairing Confirmation Tag
  (`derive_pairing_confirmation_tag`) + legacy pairing-id derivation.
- `pairing.rs` — QR pairing encode/decode (`encode_pairing_data`,
  `decode_pairing_data`, `decode_binary_pairing`), the `tp://p?d=<base64url>`
  binary layout (v2/v3/v4), `MAX_PAIRING_B64_LEN` pre-decode cap.
- `error.rs` — `TpError` (the crate's single error enum) + `Result` alias.
- `src/bin/uniffi-bindgen.rs` — the UniFFI bindgen entry point that generates
  the Swift bindings consumed by `ios/`.

`tp-core` is a UniFFI-exported crate: **everything in it must be a pure
function** — no I/O, no filesystem, no non-deterministic input beyond an
explicitly-passed nonce/seed (the one exception, `generate_keypair`, lives in
`tp-proto::keypair` precisely because it is *not* pure and therefore does not
belong in the FFI-exported crate).

## Envelope field names

`t`, `sid`, `seq`, `k`, `ns`, `n`, `d`, `c`, `ts`, `e`, `m` — 의도적 축약 (wire 효율). 리네이밍 금지.

## Framed JSON Codec

`u32_be length` + `utf-8 JSON payload` — IPC와 WS 모두 동일 포맷. 구현 = `rust/tp-core/src/codec.rs`
(`encode_frame` / `FrameDecoder`), UniFFI export = `tp-core/src/lib.rs` `encode_frame`/`decode_frames`/`FrameStream`.

## Crypto

- Key exchange: X25519 via `crypto_kx` (daemon=server, frontend=client) — `crypto::kx_server_session_keys` / `crypto::kx_client_session_keys` (`rust/tp-core/src/crypto.rs`).
- Encryption: XChaCha20-Poly1305, random nonce per frame — `crypto::seal`/`crypto::open` (+ `_with_aad` variants).
- Key derivation: BLAKE2b (`generic_hash_32`, keyless 32-byte output), domain-separated (`derive_kx_key`, `derive_registration_proof`, `derive_push_seal_key`, `derive_relay_token`).
- 구현 = **순수 Rust `tp-core`** (RustCrypto crates: `blake2`, `chacha20poly1305`, `x25519-dalek` — 앱은 UniFFI FFI, 백엔드(`tp-daemon`/`tp-relay`)는 crate 직접 의존). 새 crypto 연산 추가 시 `tp-core/src/crypto.rs` 함수 + `tests/wire_vectors.rs` 골든벡터 케이스 + (앱 노출 시) `tp-core/src/lib.rs` 의 `#[uniffi::export]` 바인딩을 함께 갱신. (역사: TS 시절엔 `crypto-provider.ts` seam 뒤에 libsodium/quick-crypto 이중 provider 가 있었으나, 이 crate 는 그 자리를 대체하는 단일 Rust 구현이다.)
- Secret key 로깅 금지. 랜덤 keypair 생성(`generate_keypair`, 비순수)은 의도적으로 `tp-core` 밖 `tp-proto::keypair` 에 있다 — 위 "`tp-proto` module structure" 참조.

## Wire-boundary Guards

모든 untrusted wire 프레임은 핸들러가 필드를 읽기 전에 guard 를 통과해야 한다 (fail-closed). 숫자 필드는 단순 "is it a number" 가 아니라 **다운스트림 sink 의 범위**까지 좁힌다 — guard 가 받아들이면 sink 가 그 값을 신뢰하기 때문. 아래는 각 가드의 live 위치와, 있는 곳엔 그 가드를 잠그는 회귀 커버리지.

- **터미널 dimension (cols/rows) 은 uint16 [1, 65535] 로 cap** — `is_terminal_dimension` / `MAX_TERMINAL_DIMENSION = 65535` (`rust/tp-proto/src/lib.rs:96,107-109`). `struct winsize.ws_col/ws_row` 가 kernel 에서 `unsigned short` 라 65536 은 0 으로 truncate 돼 PTY 를 degenerate 시킨다. 적용 사이트: `parse_ipc_message` 의 `resize` arm (`rust/tp-proto/src/ipc.rs:439-447`, `resize` 필드 둘 다 `is_terminal_dimension` 통과) — daemon→runner IPC 경계. (frontend→daemon relay 경계의 `relay.pub` 페이로드는 암호화된 채로 relay 를 지나 daemon 이 복호 후 다시 IPC 로 forward 하므로, 이 IPC 가드가 그 forward 경로도 커버한다.) 65535 는 tunable 이 아니라 uint16 구조적 상한. 회귀 가드: `rust/tp-proto/src/ipc.rs` `#[cfg(test)] mod tests` 의 `resize_terminal_dimension_cap`(65535 accept / 65536 reject / 0 reject) + 크로스-impl 골든벡터 케이스 `resize-cols-max`(65535 accept)/`resize-cols-too-big`(65536 reject) — `rust/tp-proto/tests/message_vectors.rs` + `tests/fixtures/message-vectors.json`.
- **`relay.push.register` `token` 은 platform-aware format 검증** — `rust/tp-proto/src/relay_client.rs`: **ios(APNs) 는 EXACT 64 lowercase hex** (`is_ios_apns_token`, regex 없이 고정폭 ASCII 스캔 — `unsafe_code = "forbid"` 유지 + 신규 crate dep 회피), android(FCM) 는 opaque 라 길이 cap `MAX_PUSH_TOKEN_ANDROID = 1024` 만. iOS 형식은 relay 의 APNs client(`rust/tp-relay` `apns.rs`) 가 downstream 에서 강제하는 것과 byte-exact 동일하고, Swift 앱이 `String(format:"%02x",byte)` 로 emit 하는 것과 정확히 일치한다. `platform` 을 먼저 검증한 뒤 그 discriminant 로 분기(`parse_relay_client_message` `relay.push.register` arm, `relay_client.rs:277-304`). android 는 바이트 길이(`.len()`) 사용 — ASCII-only 라 char count 와 동일. 골든벡터 케이스: `push-register`(64 hex ios → accept), `push-register-ios-token-{too-short,too-long,empty,uppercase,nonhex}`(→ reject), `push-register-token-ok-android`(len 200 → accept — flat-128-cap 회귀 가드), `push-register-android-token-too-long`(1025 → reject) — `message_vectors.rs` 크로스-impl 게이트. 인라인 유닛 테스트 `push_register_token_format_platform_aware` (`relay_client.rs` `#[cfg(test)]`)도 동일 케이스를 커버.
- **`session.export` `limit`**: `session.export` is not a `tp-proto` `IpcMessage`/`RelayClientMessage` variant at all — it is a relay-control message the daemon dispatches straight off the untyped `Value` in `rust/tp-daemon/src/ipc/command_dispatcher.rs` `handle_relay_session_export` (:1640-1755): `msg.get("limit").and_then(Value::as_i64)` — a bare `as_i64`, not `is_positive_int`/`isOptionalPositiveInt`. The 50000-cap clamp is `effective_limit = limit.unwrap_or(50_000).min(50_000)` (:1689), then `RecordsFilter.limit = Some(effective_limit + 1)` is handed to `SessionDb::get_records_filtered` (`rust/tp-daemon/src/store/session_db.rs:104-144`), which re-clamps with the same `opts.limit.unwrap_or(50_000).min(50_000)` (:134) and binds it as the SQL `LIMIT ?` parameter. `.min(50_000)` only bounds the *upper* side — a negative `limit` (e.g. `-2`) survives both clamps arithmetically unchanged-in-sign (`-2 → -2+1=-1 → (-1).min(50_000)=-1`) and reaches SQLite as `LIMIT -1`, which SQLite treats as **no limit** — this is the exact `session.export` limit-bypass the old TS `isOptionalPositiveInt` guard existed to close, and it does not look closed on this Rust path today. No guard rejects a negative `limit` before it reaches the query, and no test exercises this input — a follow-up fix task (guard + regression test) is filed in TODO.md.
- **Pairing deep-link 디코더는 strict 하다** (`rust/tp-core/src/pairing.rs` `decode_binary_pairing`). (1) base64url `d` 페이로드는 디코딩 전에 **2048 char 로 pre-cap** (`MAX_PAIRING_B64_LEN`, `pairing.rs:28,194`) — `b64url_decode` alloc 전에 거부해 attacker-controlled allocation 을 bound. 정상 v2/v3/v4 번들은 ~772 char 라 구조적으로 유효한 입력은 절대 cap 을 넘지 못한다. (2) did/relay/hostname 필드는 **strict UTF-8** (`std::str::from_utf8`, `pairing.rs:221,237,282`) — 실패 시 lossy substitution 없이 즉시 `err()` 로 전체 프레임을 거부한다.

## Relay Protocol v2 (wire messages)

CLAUDE.md 의 "Protocol" 섹션은 프레임 포맷 + v2 메시지 한 줄 요약만 둔다. 아래가 wire 상세 SoT.

- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.auth.resume` — fast-path reconnect carrying an HMAC-signed token issued in the prior `relay.auth.ok`. Relay verifies the signature without per-daemon state, so resume survives a relay restart as long as `TP_RELAY_RESUME_SECRET` persists. On `auth.err` the client drops the cached token and falls back to full register+auth on the next connect. Daemon side also skips the `relay.kx` rebroadcast when resumed and peers are still cached, since the keypair is stable across reconnects (existing peers' sessionKeys remain valid) — `rust/tp-daemon/src/transport/relay_client.rs:710-716`.
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with the key from `crypto::derive_kx_key(pairingSecret)`). The kx payload carries `v` = `WS_PROTOCOL_VERSION` (both daemon `broadcast_daemon_public_key` and app `RelayProtocol.version` advertise it). **v3 = pairing confirmation (PCT) + QR v4 (#49)** (see the WS-version bullet below).
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `relay.push.register` — frontend → relay (cleartext). Registers a plaintext APNs device token with the relay. Fields: `frontendId` (self-identifying), `token` (plaintext APNs device token hex string), `platform` (`"ios" | "android"`). Relay seals the token with a key derived from `TP_RELAY_PUSH_SEAL_SECRET` and forwards a `relay.push.token` frame to the daemon. If no daemon is connected, the registration is silently dropped (frontend re-registers on next relay connect).
- `relay.push.token` — relay → daemon (cleartext). Delivers a sealed APNs device token to the daemon. Fields: `frontendId`, `sealed` (blob: `"tpps1.<version>.<base64(nonce24||ciphertext)>"`), `platform`. Daemon (`rust/tp-daemon/src/push/notifier.rs`) persists to its store; the `sealed` blob is never decrypted by the daemon — it is forwarded as-is inside `relay.push` when a push is needed. Relay unseals at send time.
- `relay.push` — daemon → relay request to send an APNs push to a target frontend. **`sealed` is REQUIRED** (there is no legacy plaintext `token` field on this wire union — `rust/tp-proto/src/relay_client.rs` `Push` variant). Carries `frontendId`, `sealed` (blob from daemon's store), `title`, `body`, optional `interruptionLevel`, optional `data`. Relay unseals the token (tries current key then prev key for rotation), then POSTs to APNs HTTP/2 using ES256 JWT auth (`rust/tp-relay/src/apns.rs`). **Error handling:** unseal failure → `relay.err PUSH_UNSEAL_FAILED`; APNs 400 `BadDeviceToken` or 410 `Unregistered` → `relay.err PUSH_TOKEN_DEAD`; non-dead APNs errors → `relay.err PUSH_DELIVERY_ERROR`. The `relay.err` wire type (`rust/tp-relay/src/messages.rs:133-137` `RelayErr`) is `{ e: String, m: Option<String> }` — there is **no structured `frontendId` field**; the affected fid appears only inside the human-readable `m` string at the send sites (`conn.rs` PUSH_UNSEAL_FAILED / PUSH_TOKEN_DEAD paths). Consequently the daemon's `handle_relay_err` (`rust/tp-daemon/src/transport/relay_client.rs:725-759`) cannot evict the dead token per-frontend — it explicitly logs "no eviction (no frontendId on this frame); app re-registers on next relay reconnect" for both `PUSH_UNSEAL_FAILED` and `PUSH_TOKEN_DEAD`. This live gap is recorded in `relay-capacity.md` ("Dead APNs token eviction"), with a follow-up task in TODO.md (additive-optional structured `frontendId` on `relay.err` + daemon-side eviction port). The `interruptionLevel` field (`"active" | "time-sensitive"`; absent → `"active"`) maps to APNs `aps.interruption-level`; for `time-sensitive` only, the relay also sets the `apns-priority: 10` header so APNs cannot defer the push (`rust/tp-relay/src/apns.rs:515-517`; regression guards `time_sensitive_sets_priority_10` / `non_time_sensitive_omits_priority`). The privileged `"critical"` level is intentionally **not** modeled — the wire guard (`InterruptionLevel::parse_opt`, `relay_client.rs`) rejects any other string. **Per-event differentiation lives in the daemon** (`rust/tp-daemon/src/push/notifier.rs` `interruption_level_for`, line 55). APNs environment (`sandbox` vs `prod`) is configured per-deployment via `APNS_ENV` — not on the wire.
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt. Emitted by the **daemon's existing `RelayClient`** (`send_unpair_notice`, `rust/tp-daemon/src/transport/relay_client.rs:1128-1142`); the CLI delegates via the `pair.remove` IPC (`rust/tp-daemon/src/ipc/command_dispatcher.rs` `handle_pair_remove`).
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app. Emitted by the **daemon's existing `RelayClient`** (`send_rename_notice`, `relay_client.rs:1146-1156`); the CLI delegates via the `pair.rename` IPC (`command_dispatcher.rs` `handle_pair_rename`). The `label` field is the `Label` **tagged union** (`{ set: true, value } | { set: false }`) — `{ set: false }` is an authoritative clear; `{ set: true, value }` sets the label. **ADR-0003 Amendment 1 (A1.3#1):** the per-peer version-gate has been removed — the daemon always emits the union object unconditionally (never a legacy string). Readers normalize either shape (legacy string or union) via `decode_wire_label` (authoritative-clear surfaces: `ControlMessage::Rename` inbound, IPC `pair.rename`, SQLite) or `decode_kx_label_or_keep` (keep-current surfaces: relay.kx daemon-hello, meta `hello` daemonLabel — field absence is the preferred keep-current signal; both absent and `{ set: false }` are accepted as keep-current for back-compat). The label helpers live in `rust/tp-proto/src/label.rs`.
- **WS protocol version (`WS_PROTOCOL_VERSION` — `rust/tp-daemon/src/transport/relay_client.rs:121`)** — advertised by both peers in the kx payload `v` (daemon `broadcast_daemon_public_key`, app `RelayMessages.swift` `RelayProtocol.version = 3` — keep the two in lockstep; `WS_PROTOCOL_VERSION` is deliberately typed `u8` not `f64` so it serializes as the bare integer `3`, not `3.0`, matching what the Swift `JSONDecoder` expects into an `Int?` field). Additive-optional semantics: new optional fields are always safe, new message types are ignored by old apps, so no hard handshake gate exists. **v2** = `Label` tagged-union for pairing labels (per-peer version-gate removed in ADR-0003 A1.3#1 — `control.rename` always emits the union). **v3** = **pairing confirmation (PCT) + QR v4** (pairing redesign #49): a v3 daemon carries a per-frontend `pct` (domain-separated BLAKE2b over the established per-frontend session keys, `tp-core::crypto::derive_pairing_confirmation_tag`, byte-exact Rust/Swift golden vectors) on the `hello` frame. The app compares it against its own PCT and runs the §1.3 promotion table: input = `hello.d.pct` (present/absent) + `effectiveV = max(this epoch's kx-advertised v, persisted device-local minAdvertisedV floor)` → (1) `pct` match → COMMITTED confirmed; (2) `pct` mismatch → FAILED; (3) `pct` absent & `effectiveV < 3` → COMMITTED legacy (`confirmed=false`); (4) `pct` absent & `effectiveV ≥ 3` → FAILED (downgrade/tamper). The floor blocks a replayed v2 kx from silently disabling PCT (wire-unchanged replay defense). The promotion table (`effectiveV` + floor) is the **sole** discriminator — there is no separate `v≥3` code gate. QR **v4** bundles add a random-UUID `pairingId` (a fresh value on each re-pair) + `hostname` (display label); the decoder accepts v2/v3/v4 and fills legacy `pairingId` from `crypto::derive_legacy_pairing_id(daemonId)` (deterministic). **Device-local, never synced**: `pct`/`lastConfirmedPct`/`minAdvertisedV` floor/`frontendId`/label/`localHidden` tombstone. SoT = `docs/design/pairing-redesign-local-ecdh-commit-v3.md` (§1.3 promotion table, §2.5 re-verification, §G version-gate).
- Connection flow — **fast-path (reconnect):** daemon `auth.resume → (ok; kx rebroadcast skipped if peers cached)`; frontend `auth.resume → (ok; kx skipped)`. On `auth.err` both sides drop the cached token and fall back to the slow path. **Slow path (first connect):** daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`.
