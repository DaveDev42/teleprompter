---
paths:
  - "packages/protocol/**"
---

# Protocol Package Conventions

## Export 구조
- `./src/index.ts` (메인): codec, socket, crypto, logger, types 전체 — 서버 전용 (Node/Bun)
- `./src/client.ts` (`/client`): crypto, pairing, logger, types만 — 프론트엔드 안전 (RN/Expo)
- 새 유틸 추가 시: 서버 전용이면 index.ts에만, 프론트엔드에도 필요하면 client.ts에도 export

## Type 파일 구조 (`src/types/`)
- 도메인당 1파일: `envelope.ts`, `event.ts`, `ipc.ts`, `record.ts`, `relay.ts`, `session.ts`, `session-proto.ts`, `control.ts` (E2EE control messages riding the `__control__` sid — `control.unpair`, `control.rename`, etc.)
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
- `relay.auth.resume` — fast-path reconnect carrying an HMAC-signed token issued in the prior `relay.auth.ok`. Relay verifies the signature without per-daemon state, so resume survives a relay restart as long as `TP_RELAY_RESUME_SECRET` persists. On `auth.err` the client drops the cached token and falls back to full register+auth on the next connect. Daemon side also skips the `relay.kx` rebroadcast when resumed and peers are still cached, since the keypair is stable across reconnects (existing peers' sessionKeys remain valid). Frontend resume is a follow-up.
- `relay.kx` / `relay.kx.frame` — in-band pubkey exchange (encrypted with `deriveKxKey(pairingSecret)`)
- `relay.pub` / `relay.frame` — encrypted data frames, includes `frontendId` for N:N routing
- `relay.presence` — daemon online/offline with session list
- `control.unpair` — E2EE control message on the `__control__` sid (rides the existing `relay.pub` channel as ciphertext). Sent by either side when a pairing is removed (`tp pair delete` or the app's Daemons list). The receiving peer auto-removes the matching pairing and surfaces a toast/log. Stateless: if the peer is offline, the message is lost and the pairing heals on the next connect attempt. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.remove` IPC (fallback when daemon is stopped: direct `Store` write, peer learns on next reconnect).
- `control.rename` — E2EE control message on `__control__` sid; updates the peer's pairing label. Sent when either side runs `tp pair rename` or edits the label in the app. Emitted by the **daemon's existing RelayClient**; the CLI delegates via the `pair.rename` IPC (fallback when daemon is stopped: direct `Store` write, peer syncs on next reconnect). The `label` field is the `Label` **tagged union** (`{ set: true, value } | { set: false }`) — `{ set: false }` is an authoritative clear, replacing the legacy `""`-as-clear sentinel. **Cross-version compat (WS protocol v2):** **both** sides advertise their WS protocol version in the `relay.kx` payload (`v`) — the daemon in its hello broadcast, the frontend in its `sendKeyExchange`. The daemon's `sendRenameNotice` **version-gates** the wire shape per peer — a peer (app) that has not advertised v2 still receives the legacy `string` (`""` = clear), because an un-updated app would coerce a union object to `""` and silently clear the user's label. Readers normalize either shape via `decodeWireLabel` (authoritative-clear surfaces: ControlRename inbound on **both** daemon and app, IPC, SQLite) or `decodeKxLabelOrKeep` (keep-current surfaces: relay.kx daemon-hello, meta `hello` daemonLabel — absence means "keep the app's current label", not "clear"; the app short-circuits and skips its `onDaemonHello` callback when this returns null). The label helpers live in `packages/protocol/src/types/label.ts`.
- Connection flow: daemon `register → auth → broadcast pubkey via kx`; frontend `auth → send pubkey via kx → subscribe`
