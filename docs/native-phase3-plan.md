# Phase 3 Implementation Plan — Native Swift Teleprompter Client (relay-as-frontend)

> ADR-0001 Phase 3. SoT for the app track's next milestone. Grounded in live HEAD
> file:line citations (verified, not hearsay). Backend stays TypeScript — this phase
> is about the **app**, not porting the backend (that's Phase 4).

The app must become a functional teleprompter client: consume a pairing bundle, connect
to the relay over WebSocket, complete the E2EE handshake as the **frontend** role, and
render a live session (hooks events in Chat, terminal io in Terminal; send input back).
All crypto/codec/pairing primitives already exist in `tp-core`; Phase 3 wires them into a
relay client + UI.

## Ground truth (cited)

The app's job is to be the **mirror image of the daemon's `RelayClient`**, but with
`role: "frontend"`. The exact wire sequence the app must drive, verified against three
independent sources (the daemon client, the relay server, and the live e2e test):

**Frontend slow-path handshake** (daemon does register→auth→kx; frontend skips register):
1. `relay.auth` `{ t, v:2, role:"frontend", daemonId, token, frontendId }` —
   `packages/protocol/src/types/relay.ts:23-35`; relay requires `frontendId` for
   `role=frontend` or replies `auth.err` (`packages/relay/src/relay-server.ts:825-831`).
   Token = `derive_relay_token(pairingSecret)` (`crypto.ts:224-230`).
2. Wait for `relay.auth.ok` (`relay.ts:179-200`; issued at `relay-server.ts:871-877`,
   carrying `resumeToken`/`resumeExpiresAt`).
3. `relay.kx` `{ t, ct, role:"frontend" }` where
   `ct = encrypt(JSON({ pk: base64(frontendPubKey), frontendId, role:"frontend", v:2 }), kxKey)`
   and `kxKey = derive_kx_key(pairingSecret)`. Canonical frontend kx payload — proven in
   `apps/cli/src/unpair-e2e.test.ts:89-100`. `v` gates the daemon rename wire-shape
   (`relay-client.ts:469-471`); send `v:2`.
4. `relay.sub` for `__meta__`, `__control__`, and each session `sid` (`relay.ts:81-87`,
   `types/relay.ts:17-19`). Optional `after` seq for cache replay
   (`relay-server.ts:1200-1209`).

**Session keys (riskiest detail).** Frontend derives with
`kx_client_session_keys(frontendPk, frontendSk, daemonPk)` where `daemonPk` is the `pk`
field from the **pairing bundle** (NOT from a kx frame — it's in the QR). Daemon derives
with `kx_server_session_keys(...)`. Crossover: `frontend.tx == daemon.rx`,
`frontend.rx == daemon.tx` (`crypto.ts:80-102`; proven on-device in
`ios/Tests/TpCoreTests.swift:45-52`). **Frontend encrypts data with `tx`, decrypts with
`rx`.** The daemon also broadcasts its pubkey via `relay.kx.frame`
(`relay-client.ts:428-439`) — the frontend **ignores** it (daemon pubkey already in bundle).

**Data frames.** Outbound `relay.pub { t, sid, ct, seq }` (`relay.ts:71-79`). Relay echoes
peer frames as `relay.frame { t, sid, ct, seq, from, frontendId? }` (`relay.ts:217-225`,
routing `relay-server.ts:1093-1165`). Plaintext inside `ct` is a `Session*` JSON message
(`session-proto.ts`).

**What flows to the frontend (plaintext inside `ct`):**
- `__meta__`: `hello { t:"hello", v, d:{ sessions: SessionMeta[], daemonLabel? } }`
  (`session-proto.ts:151-165`; pushed on join `relay-manager.ts:127-134`, and on explicit
  `hello` `command-dispatcher.ts:450-465`); `state { t:"state", sid, d: SessionMeta }`
  (`session-proto.ts:167-171`).
- Per-`sid`: `rec { t:"rec", sid, seq, k, ns?, n?, d:base64, ts }`
  (`session-proto.ts:173-182`) and `batch { t:"batch", sid, d: SessionRec[] }` (replay,
  `session-proto.ts:184-188`, emitted `command-dispatcher.ts:730-754`). `k` is
  `"io"|"event"|"meta"` (`types/record.ts:1`). **Chat shows `k=event`; Terminal shows
  `k=io`** (ADR Phase 3; rule: chat = hooks-only, terminal io → terminal tab).
- `__control__`: `control.unpair`/`control.rename` (`relay-client.ts:530-556`), `pong`,
  worktree/export replies, `err`.

**What the app sends (plaintext inside `ct`, all `SessionClientMessage`,
`session-proto.ts:22-147`):**
- `hello { t:"hello", v }` on `__meta__` (resync; daemon also pushes on join).
- `attach { t:"attach", sid }` → daemon replies `state` (`command-dispatcher.ts:468-480`).
- `resume { t:"resume", sid, c }` → daemon replies `batch` after cursor `c`
  (`command-dispatcher.ts:486-489, 730-754`). History backfill.
- `in.chat { t:"in.chat", sid, d }` (plain text; daemon adds `\n`, writes PTY,
  `relay-manager.ts:102-110`) and `in.term { t:"in.term", sid, d }` (base64).
- `resize`, `session.create/stop/restart`, `worktree.*`, `ping`, `session.export` — later.

**`frontendId`.** App-generated, stable per install (UUID in UserDefaults/Keychain). The
N:N routing key (`relay-server.ts:836-844, 1134-1142`); identical in `relay.auth` and the
`relay.kx` payload.

**FFI surface today** (`rust/tp-core/src/lib.rs`) already exposes everything the handshake
needs: `derive_relay_token` (`:136`), `derive_kx_key` (`:141`),
`derive_registration_proof` (`:146`), `seal`/`open` (`:165`/`:170`), `kx_seed_keypair`
(`:193`), `kx_client_session_keys` (`:216`), `ratchet_session_keys` (`:231`),
`encode_frame`/`decode_frames`/`FrameStream` (`:95`/`:102`/`:108`), `decode_pairing_data`
(`:258`). **Missing:** no random keypair generator — the app generates 32 random bytes
(`SecRandomCopyBytes`) and feeds `kx_seed_keypair` (zero Rust change), OR we add
`kx_keypair()`. **Recommendation: use the seed path, keep the FFI frozen** to preserve the
Phase 2 golden-vector guarantee.

**Codec correctness note.** `encode_frame`/`decode_frames` is the **framed-JSON transport
codec** (`u32_be jsonLen + ...`, for IPC / raw byte streams). The relay WebSocket carries
**one JSON text message per frame** (`ws.send(JSON.stringify(msg))`,
`relay-client.ts:798-802`; relay `JSON.parse(text)` `relay-server.ts:650-654`). So over the
relay WS the app does **NOT** use `encode_frame` — it sends/receives plain JSON text via
`URLSessionWebSocketTask`. The framed codec is only for a later libghostty/IPC path. This
is the single most likely place to waste effort.

## Single riskiest part

The **in-band kx handshake + frontendId routing + tx/rx key direction**:
1. The `relay.kx` payload JSON must be exactly `{ pk, frontendId, role:"frontend", v }`,
   encrypted with `derive_kx_key(pairingSecret)` via `seal` (prepends 24B nonce, base64 —
   same as TS `encrypt`). Wrong field/key → daemon `kx frame decrypt/parse failed`
   (`relay-client.ts:486-488`), no peer registered, app appears connected but gets nothing.
2. Frontend must use `tx` outbound, `rx` inbound. Backwards → decrypts nothing, hard to
   debug (auth still succeeds).
3. `frontendId` identical across `relay.auth` and kx payload, else daemon registers a peer
   the relay can't route back to.

Mitigation: M2 isolates auth (no decryption) before M3 attempts the handshake; M3 isolates
the first decrypted frame.

## Smallest first real signal

**Milestone 2** is the smallest milestone with a true end-to-end signal: app opens a WS to
a locally-spawned relay, sends `relay.auth (role=frontend)`, relay accepts — observable
app-side (`relay.auth.ok` → `TP_RELAY_AUTH_OK`) and relay-side
(`frontend authenticated for daemon …`, `relay-server.ts:873`). Proves the WS client, JSON
shaping, token derivation, and `frontendId` with zero crypto-direction risk.

## Milestones

Each is independently buildable and verified via `scripts/ios.sh smoke`/`test`, mirroring
Phase 2's `TP_CORE_OK`: an on-device marker to subsystem `dev.tpmt.teleprompter` (greppable
exactly like `TP_BOOT_OK`/`TP_CORE_OK`, `scripts/ios.sh:156-173`) + an XCTest. Proposed
markers: `TP_PAIR_OK`, `TP_RELAY_AUTH_OK`, `TP_KX_OK`, `TP_FRAME_OK`, `TP_SESSION_OK`,
`TP_INPUT_OK`.

### M0 — Harness: local daemon+relay loopback
- **Goal:** `scripts/ios.sh` can stand up a real relay + paired daemon for live verification.
- **Rust/Swift:** none.
- **Harness:** add `cmd_loopback` (or env-gated `smoke` preamble): (a) `tp relay` on a fixed
  port (7090) in background; (b) `tp daemon` + `tp pair new` to mint a bundle; (c) capture
  the `tp://p?d=…` deep link (`apps/cli/src/commands/pair.ts:160-169`) + daemonId/relayUrl;
  (d) inject the deep link into the app via launch env or `simctl openurl`. `tp pair new`
  blocks until the frontend completes kx — itself a strong gate for M2-M3. Simulator reaches
  the host relay via `localhost` (shared host network).
- **Verify:** `scripts/ios.sh loopback` prints relay `/health` (`relay-server.ts:419-435`)
  with `clients>=1` after connect. **Keep env-gated/optional** so default `smoke` stays
  hermetic (no Bun runtime needed for CI).
- **Risks:** bash background-process lifecycle (trap EXIT); `tp` must be built; document
  `localhost` reachability.

### M1 — Pairing bundle ingestion (offline) ✅ DONE (2026-06-15, Simulator-verified)
- **Goal:** app accepts `tp://p?d=…`, decodes via FFI, persists the pairing.
- **Rust:** none (`decode_pairing_data` `lib.rs:258` → `FfiPairingData{ps,pk,relay,did,v}`).
- **Swift (landed):** `ios/Sources/Pairing/PairingStore.swift` (`Pairing` model
  `{pairingSecret:Data, daemonPublicKey:Data, relayURL, daemonId, frontendId, version}`;
  standard-base64-decode `ps`/`pk` with 32-byte guards; stable `frontendId` UUID in
  UserDefaults; secret in Keychain keyed by daemon id; non-secret meta + index in
  UserDefaults). `ios/Sources/Pairing/DeepLinkHandler.swift` (routes `tp://p`,
  emits `TP_PAIR_OK did=<id>` / `TP_PAIR_FAIL detail=<…>`). `TeleprompterApp.swift`
  `.onOpenURL` → handler; `RootView` paired-daemons list (`@Observable PairingViewModel`).
- **Verify (passing):** `scripts/ios.sh smoke` injects a deterministic `tp://p?d=…`
  (`smoke_pair_link`, did `daemon-smoketest`) via `xcrun simctl openurl` and greps
  `TP_PAIR_OK did=daemon-smoketest`. XCTest `PairingStoreTests` (9 cases) + existing 8 ⇒
  17/17. Rust host 20/20.
- **Two Simulator gotchas discovered (cost the most time — do NOT re-derive):**
  1. **Scene manifest required.** `.onOpenURL` silently never fires unless the Info.plist
     declares `UIApplicationSceneManifest` (with a `UISceneConfigurations` entry). The
     prior harness used `GENERATE_INFOPLIST_FILE=YES`, which SwiftUI auto-injected it; the
     custom `tp://` scheme needs an explicit Info.plist (`CFBundleURLTypes` has no
     `INFOPLIST_KEY_*`), so the manifest must be added by hand in `project.yml`
     `info.properties`. Do **not** declare your own `UISceneDelegateClassName` — SwiftUI
     ignores it and owns the scene; only the manifest's *presence* matters for `.onOpenURL`.
  2. **Keychain needs an entitlement + ad-hoc signing.** Unsigned Simulator builds
     (`CODE_SIGNING_ALLOWED=NO`) have no entitlements, so `SecItemAdd` fails with
     `errSecMissingEntitlement` (-34018). Fix = `ios/Teleprompter.entitlements`
     (`keychain-access-groups = $(AppIdentifierPrefix)dev.tpmt.teleprompter`) + ad-hoc sign
     (`CODE_SIGN_IDENTITY=-`, `CODE_SIGNING_ALLOWED=YES`, `CODE_SIGNING_REQUIRED=NO`).
     The harness passes these as `$SIGN_FLAGS` (replaced the old `CODE_SIGNING_ALLOWED=NO`).
  3. **Adding a new URL scheme needs a LaunchServices refresh.** The first build that adds
     `tp://` won't route until the Simulator's LaunchServices re-registers — a
     `simctl shutdown && boot` (or device erase) clears the stale cache. Subsequent
     installs route fine. (Symptom: `CoreSimulatorBridge` logs "Opening URL … with
     dev.tpmt.teleprompter" + `lsd` "No override", but the app process gets nothing.)
- **Note:** `ps`/`pk` are **standard** base64 (`pairing.ts:291-295`) → Swift
  `Data(base64Encoded:)` is correct (url-safe is only the outer `?d=` blob, handled inside
  `decode_pairing_data`). Confirmed on-device.

### M2 — WebSocket connect + frontend auth (FIRST REAL E2E SIGNAL)
- **Goal:** app opens WS, authenticates as `role=frontend`; relay accepts + logs.
- **Rust:** none (`derive_relay_token` `lib.rs:136`; auth has no ciphertext).
- **Swift:** `ios/Sources/Relay/RelayClient.swift` (wraps `URLSessionWebSocketTask`, no dep;
  state machine connecting→authenticating→authenticated; send `relay.auth`; receive loop
  parses `RelayServerMessage`; on `relay.auth.ok` cache resume token; `relay.ping` every 30s
  per `relay-client.ts:784-789`; reconnect backoff). `ios/Sources/Relay/RelayMessages.swift`
  (Codable structs from `types/relay.ts`, field names verbatim: `t`,`ct`,`sid`,`seq`,
  `frontendId`,`v`).
- **Verify:** `TP_RELAY_AUTH_OK daemon=<id>`. Two-sided: app marker + `loopback` asserts
  `/health clients>=1` (or relay log `frontend authenticated for daemon`,
  `relay-server.ts:873`). XCTest `RelayAuthTests`: against in-test relay if reachable, else
  assert the exact `relay.auth` JSON bytes vs the literal in `unpair-e2e.test.ts:78-86`.
- **Risks:** `URLSessionWebSocketTask` non-101 handling; relay closes 1008 on auth-timeout
  (`relay-server.ts:526`). ATS: `ws://localhost` exempt on Simulator; prod `wss://` needs no
  exception. Defer `relay.auth.resume` — first connect uses full auth.

### M3 — In-band kx + first decrypted frame (RISKIEST)
- **Goal:** app completes kx, daemon registers it as a peer, app decrypts the daemon's
  `hello` (session list) on `__meta__`.
- **Rust:** optional `kx_keypair()` (random; mirrors `crypto.ts:62-65`) — **recommend
  skipping**; use `SecRandomCopyBytes` + existing `kx_seed_keypair` (`lib.rs:193`).
- **Swift:** extend `RelayClient`: after `auth.ok`, generate frontend keypair, derive
  `kxKey=deriveKxKey(ps)`, build kx payload `{pk:base64(pub),frontendId,role:"frontend",v:2}`,
  `seal` with `kxKey` + fresh 24B random nonce, send `relay.kx`. Derive session keys
  `kxClientSessionKeys(frontendPub, frontendSec, daemonPublicKey)` → store `{tx,rx}`. Sub
  `__meta__`/`__control__`. Inbound `relay.frame`: `open(ct, rx)` → parse `Session*` → route
  by `sid` + inner `t`; marker on first `hello`. `ios/Sources/Session/SessionStore.swift`
  (`@Observable`, session list from `hello.d.sessions`).
- **Verify:** `TP_KX_OK` + `TP_FRAME_OK sessions=<n>`. Strongest: against loopback,
  `tp pair new` **unblocks** (waits for frontend kx, `relay-manager.ts:117`) — assert the
  subprocess exits 0. Relay-side: daemon log `key exchange completed with frontend <id>`
  (`relay-client.ts:484`). XCTest `KxRoundTripTests`: full handshake vs embedded relay if
  available, else seal/open a kx payload + crossover assert (extend
  `TpCoreTests.swift:45-52`).
- **Risks:** see "single riskiest part". Also: the app **receives** `relay.kx.frame` (daemon
  pubkey broadcast) — must ignore it, not treat as data. The daemon pushes `hello`
  automatically on join (`relay-manager.ts:127-134`) — handle unsolicited `__meta__` frames.
  Fresh 24 random bytes per `seal` (nonce is an FFI arg `lib.rs:165`; reuse catastrophic).

### M4 — Live session render: Chat (hooks) + history backfill
- **Goal:** open a session, backfill via `resume`, render `k=event` hooks in Chat; live
  `rec` frames stream.
- **Rust:** none.
- **Swift:** `RelayClient`: `attach(sid)`, `resume(sid, cursor)` (→ `batch`), route
  `rec`/`batch`/`state` to `SessionStore` (decrypt `rx`; `rec.d` is base64;
  `k=event` payload is a hook event JSON `types/event.ts`).
  `ios/Sources/Session/ChatView.swift` (filter `k=event`; parse `hook_event_name`,
  `tool_name`, `last_assistant_message`). Track `lastSeq`/cursor; drive `relay.sub after=`
  (`relay-server.ts:1200-1209`).
- **Verify:** `TP_SESSION_OK sid=<sid> events=<n>` after a `batch` decrypts + first event
  renders. Loopback: drive the daemon to produce a hook event. XCTest `ChatRenderTests`:
  feed a synthetic `batch` of `event` records through decrypt+route; assert Chat items.
- **Risks:** seq gaps / slow-consumer disconnect → replay via `relay.sub after=`
  (relay-capacity rule); track cursors precisely. `SessionMeta` shape
  (`session-proto.ts:11-20`). Terminal `io` explicitly NOT shown in Chat (ADR).

### M5 — Send input + terminal io tab
- **Goal:** send `in.chat`/`in.term`; render `k=io` in a Terminal tab.
- **Rust:** none for wire (full ANSI emulation via SwiftTerm/libghostty is a Phase 3.x
  follow-up; this milestone = raw io append + input send).
- **Swift:** `RelayClient.sendInput(sid, kind, text)` → `relay.pub` with
  `ct=seal(JSON({t:"in.chat"|"in.term",sid,d}), tx)` (`in.chat` d=plain text, daemon adds
  `\n` `relay-manager.ts:106-108`; `in.term` d=base64). `ios/Sources/Session/TerminalView.swift`
  (append decoded `k=io`; composer field → `sendInput`).
- **Verify:** `TP_INPUT_OK` after the daemon echoes a change from input. Loopback: send
  `in.chat` to a live runner (`["true"]`/`cat` via `setRunnerCommand`, cf.
  `unpair-e2e.test.ts:38`); assert an `io` rec round-trips. XCTest `InputEncodeTests`: assert
  sealed `in.chat`/`in.term` plaintext matches `Session*` JSON; `in.term` d is base64.
- **Risks:** input hits the PTY write path (`relay-client.ts:558-566`); malformed `sid`/`d`
  silently dropped. Full emulation out of scope — keep to "bytes append + input send".

## Sequencing
- M0 ∥ M1 (M0 unblocks live verify for M2-M5; not required for offline M1).
- M2 ← M1 (needs ps/token/frontendId).
- M3 ← M2 (authenticated socket). **Riskiest — budget the most time.**
- M4 ← M3 (decrypted frames + session list).
- M5 ← M3 (keys) + M4 (session context).

## FFI verdict
**No tp-core changes strictly required for Phase 3.** Handshake/AEAD/kx/KDF/pairing all
exported (`lib.rs:95-269`). Only candidate addition is a random `kx_keypair()`, avoidable
via `SecRandomCopyBytes` + `kx_seed_keypair`. Keeping the FFI frozen preserves the Phase 2
golden-vector guarantee (`rust/tp-core/tests/wire_vectors.rs`).

## Proposed Swift file layout
- `ios/Sources/Pairing/PairingStore.swift`, `DeepLinkHandler.swift`
- `ios/Sources/Relay/RelayClient.swift`, `RelayMessages.swift`
- `ios/Sources/Session/SessionStore.swift`, `ChatView.swift`, `TerminalView.swift`
- `ios/Tests/PairingStoreTests.swift`, `RelayAuthTests.swift`, `KxRoundTripTests.swift`,
  `ChatRenderTests.swift`, `InputEncodeTests.swift`
- Modify: `ios/Sources/TeleprompterApp.swift` (deep-link, root nav),
  `ios/Sources/ContentView.swift` (daemons/sessions UI), `scripts/ios.sh` (loopback + marker
  greps).

## Verification doctrine (from Phase 2)
Every milestone emits a single-line marker to `Logger(subsystem:"dev.tpmt.teleprompter")`,
greppable by `scripts/ios.sh` exactly as `TP_BOOT_OK`/`TP_CORE_OK` today
(`ContentView.swift:34-42`, `ios.sh:156-173`). Prefer the live-loopback assertion (relay
`/health clients>=1`, daemon "key exchange completed", `tp pair new` unblocking) as the
authoritative signal; the XCTest is the hermetic CI fallback.

## Critical files
- `packages/daemon/src/transport/relay-client.ts` — client behavior the app mirrors as
  frontend (auth → kx payload → tx/rx → frame routing).
- `packages/protocol/src/types/relay.ts` — relay v2 wire shapes the Swift Codable structs
  must match verbatim.
- `packages/protocol/src/types/session-proto.ts` — `Session*` payload schema inside every
  encrypted `ct`.
- `rust/tp-core/src/lib.rs` — the FFI surface already available (confirms no Rust changes).
- `scripts/ios.sh` — harness to extend with loopback + new markers.
- Secondary: `packages/relay/src/relay-server.ts`, `apps/cli/src/unpair-e2e.test.ts` (a
  live byte-exact frontend handshake — the canonical sequence to copy),
  `packages/daemon/src/transport/relay-manager.ts`,
  `packages/daemon/src/ipc/command-dispatcher.ts`.
