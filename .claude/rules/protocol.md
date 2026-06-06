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
- Secret key 로깅 금지

## Relay Protocol v2 (wire messages)

CLAUDE.md 의 "Protocol" 섹션은 프레임 포맷 + v2 메시지 한 줄 요약만 둔다. 아래가 wire 상세 SoT.

- `relay.register` — daemon self-registers token+proof (derived from pairing secret)
- `relay.auth` — authenticate with token, includes `frontendId` for frontend role
- `relay.auth.resume` — fast-path reconnect carrying an HMAC-signed token issued in the prior `relay.auth.ok`. Relay verifies the signature without per-daemon state, so resume survives a relay restart as long as `TP_RELAY_RESUME_SECRET` persists. On `auth.err` the client drops the cached token and falls back to full register+auth on the next connect. Daemon side also skips the `relay.kx` rebroadcast when resumed and peers are still cached, since the keypair is stable across reconnects (existing peers' sessionKeys remain valid).
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `relay.push.register` — frontend → relay (cleartext, Path X). Registers a plaintext Expo push token with the relay. Fields: `frontendId` (self-identifying), `token` (plaintext Expo token), `platform` (`"ios" | "android"`). Relay seals the token with `PushSealer` (XChaCha20-Poly1305, key derived from `TP_RELAY_PUSH_SEAL_SECRET` via `derivePushSealKey`) and forwards a `relay.push.token` frame to the daemon. If no daemon is connected, the registration is silently dropped (frontend re-registers on next relay connect). Old relays that don't recognize the message type ignore it (back-compat). Both `relay.push.register` (Path X) and the legacy `onPushToken` E2EE path remain active during rollout.
- `relay.push.token` — relay → daemon (cleartext, Path X). Delivers a sealed push token to the daemon. Fields: `frontendId`, `sealed` (blob: `"tpps1.<version>.<base64(nonce24||ciphertext)>"`), `platform`. Daemon calls `pushNotifier.registerSealedToken(...)` and persists to SQLite (`push_tokens` table). The `sealed` blob is never decrypted by the daemon — it is forwarded as-is inside `relay.push` when a push is needed. Relay unseals at send time.
- `relay.push` — daemon → relay request to send an Expo push to a target frontend (relay holds the only outbound HTTP path to Expo). **Path X (preferred):** carries `frontendId`, `sealed` (blob from daemon's store), `title`, `body`, optional `interruptionLevel`, optional `data`. Relay unseals the token with `PushSealer` (tries current key then prev key for rotation), then calls Expo Push API with the plaintext token. On unseal failure, relay sends `relay.err PUSH_UNSEAL_FAILED` back to the daemon. **Legacy path (back-compat):** carries `token` (plaintext) instead of `sealed`. Relay uses `token` directly. Wire guard accepts either field; daemon chooses based on stored entry type. The `interruptionLevel` field is optional (`"active" | "time-sensitive"`; absent → `"active"` for wire back-compat — an older daemon omits it, an older relay ignores it). The relay forwards `interruptionLevel` to the Expo Push API as a top-level field (→ APNs `aps.interruption-level`) and, for `time-sensitive` only, additionally lifts `priority` to `"high"` (APNs priority 10) so the push can't be deferred. **Per-event differentiation lives in the daemon** (`push-notifier.ts` `interruptionLevelFor`): attention-needed events (`PermissionRequest`/`Notification`/`Elicitation`) → `time-sensitive` (breaks Focus/DND when the user has allowed it; entitlement auto-injected by the expo-notifications plugin, no special Apple approval); informational events default to `active`. The privileged `"critical"` level is intentionally **not** modeled, and the wire guard (`parseRelayClientMessage`) rejects any `interruptionLevel` other than the two allowed strings at the zero-trust boundary.
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.remove` IPC (fallback when daemon is stopped: direct `Store` write, peer learns on next reconnect).
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.rename` IPC (fallback when daemon is stopped: direct `Store` write, peer syncs on next reconnect). The `label` field is the `Label` **tagged union** (`{ set: true, value } | { set: false }`) — `{ set: false }` is an authoritative clear, replacing the legacy `""`-as-clear sentinel. **Cross-version compat (WS protocol v2):** **both** sides advertise their WS protocol version in the `relay.kx` payload (`v`) — the daemon in its hello broadcast, the frontend in its `sendKeyExchange`. The daemon's `sendRenameNotice` **version-gates** the wire shape per peer — a peer (app) that has not advertised v2 still receives the legacy `string` (`""` = clear), because an un-updated app would coerce a union object to `""` and silently clear the user's label. Readers normalize either shape via `decodeWireLabel` (authoritative-clear surfaces: ControlRename inbound on **both** daemon and app, IPC, SQLite) or `decodeKxLabelOrKeep` (keep-current surfaces: relay.kx daemon-hello, meta `hello` daemonLabel — absence means "keep the app's current label", not "clear"; the app short-circuits and skips its `onDaemonHello` callback when this returns null). The label helpers live in `packages/protocol/src/types/label.ts`.
- Connection flow — **fast-path (reconnect):** daemon `auth.resume → (ok; kx rebroadcast skipped if peers cached)`; frontend `auth.resume → (ok; kx skipped)`. On `auth.err` both sides drop the cached token and fall back to the slow path. **Slow path (first connect):** daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`.
