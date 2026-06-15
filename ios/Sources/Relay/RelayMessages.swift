import Foundation

/// Relay protocol v2 wire messages (ADR-0001 Phase 3, M2).
///
/// Field names are verbatim from `packages/protocol/src/types/relay.ts` — the
/// relay parses by key, so any rename breaks the wire. Only the messages the
/// *frontend* sends or receives during connect+auth live here; kx/data frames
/// arrive in M3.
///
/// The current protocol version is 2 (`WS_PROTOCOL_VERSION`,
/// `packages/protocol/src/compat.ts`).
enum RelayProtocol {
    static let version = 2
}

/// Well-known sid channels (not real sessions). The daemon publishes the session
/// list (`hello`) on `__meta__` and control ops (unpair/rename) on `__control__`;
/// the frontend must subscribe to both to receive them
/// (`packages/relay/src/relay-server.ts` only forwards to subscribers).
enum RelayChannel {
    static let meta = "__meta__"
    static let control = "__control__"
}

// MARK: - Frontend → Relay

/// `relay.auth` — the frontend authenticates after the socket opens.
///
/// Byte-shape must match `unpair-e2e.test.ts:78-86` and `multi-frontend.test.ts:79-88`:
/// `{ t, v, role, daemonId, token, frontendId }`. `token` is the lowercase-hex
/// `derive_relay_token(pairingSecret)` (BLAKE2b-256(secret || "relay-auth")).
struct RelayAuth: Encodable, Equatable {
    let t = "relay.auth"
    let v = RelayProtocol.version
    let role = "frontend"
    let daemonId: String
    let token: String
    let frontendId: String
}

/// `relay.auth.resume` — HMAC resume-token fast-path. Deferred in M2 (first
/// connect always uses full `relay.auth`); the shape is defined for M-later.
struct RelayAuthResume: Encodable, Equatable {
    let t = "relay.auth.resume"
    let token: String
    let v = RelayProtocol.version
}

/// `relay.ping` — liveness keep-alive. The daemon sends one every 30s
/// (`relay-client.ts` `PING_INTERVAL_MS`); the relay's idle timeout is 90s, so
/// the frontend matches the 30s cadence to survive three-strikes idle close.
struct RelayPing: Encodable, Equatable {
    let t = "relay.ping"
    let ts: Double?
}

/// `relay.kx` — in-band public-key exchange (M3). The relay fans this out to the
/// opposite-role peer(s); the daemon decrypts `ct` with the kx-envelope key
/// (`derive_kx_key(pairingSecret)`) to recover the frontend's pubkey + frontendId.
///
/// Wire shape is exactly `{ t, ct, role }` — `frontendId` is NOT at the envelope
/// level, it lives ONLY inside the sealed `ct` plaintext
/// (`packages/protocol/src/types/relay.ts` `RelayKeyExchange`). The sealed
/// plaintext is `{ pk, frontendId, role: "frontend" }` (3 fields, no `v`) — the
/// tested daemon-decode norm at `relay-client.ts:451-454`.
struct RelayKeyExchange: Encodable, Equatable {
    let t = "relay.kx"
    let ct: String
    let role = "frontend"
}

/// The sealed plaintext inside a frontend `relay.kx`'s `ct`. `pk` is standard
/// base64 (libsodium original `+/` with padding) of the 32-byte X25519 pubkey.
/// `v` is deliberately omitted to match the tested daemon-decode norm
/// (`relay-client.ts:451-454`; daemon defaults absent `v` to 1).
struct KxPayload: Encodable, Equatable {
    let pk: String
    let frontendId: String
    let role = "frontend"
}

/// `relay.sub` — subscribe to a sid so the relay forwards its frames. `after` is
/// the last-seen seq for cache replay: the relay replays cached frames with
/// `seq > after` ONLY when `after` is present (`relay-server.ts:1201-1209`); a
/// subscribe with no `after` does NOT replay. We subscribe with `after: 0` so an
/// auto-`hello` the daemon may have pushed before we subscribed is still recovered.
struct RelaySubscribe: Encodable, Equatable {
    let t = "relay.sub"
    let sid: String
    let after: Int?
}

/// `relay.pub` — publish an E2EE frame on a sid. `ct` is sealed with the
/// frontend's tx session key. Used for the on-demand `hello` fallback.
struct RelayPublish: Encodable, Equatable {
    let t = "relay.pub"
    let sid: String
    let ct: String
    let seq: Int
}

// MARK: - Relay → Frontend

/// `relay.auth.ok` — auth succeeded. `resumeToken`/`resumeExpiresAt` are cached
/// for the (deferred) resume path; `resumed` is diagnostic.
struct RelayAuthOk: Decodable, Equatable {
    let t: String
    let daemonId: String
    let resumeToken: String?
    let resumeExpiresAt: Double?
    let resumed: Bool?
}

/// `relay.auth.err` — auth rejected (bad token/daemonId, missing frontendId, …).
struct RelayAuthErr: Decodable, Equatable {
    let t: String
    let e: String
}

/// `relay.presence` — broadcast to the daemon's frontends after auth and on
/// daemon online/offline transitions. M2 only logs it; M3 consumes `sessions`.
struct RelayPresence: Decodable, Equatable {
    let t: String
    let daemonId: String
    let online: Bool
    let sessions: [String]
    let lastSeen: Double
}

/// `relay.pong` — reply to our ping (or the relay's own keep-alive).
struct RelayPong: Decodable, Equatable {
    let t: String
    let ts: Double?
}

/// `relay.kx.frame` — the relay delivers a peer's `relay.kx` here. `from` is the
/// originating role; the frontend only acts on `from == "daemon"` frames (mirror
/// of `relay-client.ts:446`). `ct` is sealed with the kx-envelope key.
struct RelayKeyExchangeFrame: Decodable, Equatable {
    let t: String
    let ct: String
    let from: String
}

/// The daemon's kx plaintext, recovered by decrypting a `relay.kx.frame(from:
/// daemon)`'s `ct` with the kx-envelope key. The daemon seals 4 fields
/// (`{pk, role, v, label}`, `relay-client.ts:431-436`); M3 reads only `pk`, the
/// daemon's *current* X25519 pubkey (standard base64). This is the authoritative
/// pubkey for session-key derivation — it tracks a daemon keypair rotation that a
/// stale pairing-bundle pubkey would miss.
struct DaemonKxPayload: Decodable, Equatable {
    let pk: String
}

/// `relay.frame` — an inbound E2EE data frame. The auto-`hello` arrives as a
/// `relay.frame` with `sid == "__meta__"` and `from == "daemon"`; `ct` is bare
/// sealed JSON (NOT the u32-length framed codec — that is IPC-only). Decrypt with
/// the frontend's rx session key, then JSON-decode the discriminated payload.
struct RelayFrame: Decodable, Equatable {
    let t: String
    let sid: String
    let ct: String
    let seq: Int
    let from: String
    let frontendId: String?
}

/// `hello` (`SessionHelloReply`) — the daemon's session-list reply, decrypted out
/// of a `__meta__` `relay.frame`. `v` is hardcoded to 1 on both daemon paths
/// (`relay-manager.ts:129`, `command-dispatcher.ts:459`) — do not gate on it.
/// Sessions live at `d.sessions`; the status field is `state`, NOT `status`.
struct SessionHelloReply: Decodable, Equatable {
    let t: String
    let v: Int
    let d: HelloData

    struct HelloData: Decodable, Equatable {
        let sessions: [SessionMeta]
    }
}

/// One session's metadata (`packages/protocol/src/types/session-proto.ts:11-20`).
/// Only the fields the frontend renders are decoded; `daemonLabel` (a tagged
/// union) and optional fields are intentionally omitted from M3's first decode.
struct SessionMeta: Decodable, Equatable {
    let sid: String
    let state: String // "running" | "stopped" | "error" — NOT named "status"
    let cwd: String
    let createdAt: Double
    let updatedAt: Double
    let lastSeq: Int
}

/// The on-demand `hello` request the frontend seals with its tx key and publishes
/// on `__meta__` when no auto-`hello` arrives (belt-and-suspenders against the
/// kx→publish timing race). The daemon's command-dispatcher replies on `__meta__`.
struct HelloRequest: Encodable, Equatable {
    let t = "hello"
    let v = RelayProtocol.version
}

/// A server message decoded far enough to dispatch on `t`. The full payload is
/// re-decoded into the concrete type once the tag is known — this keeps the
/// receive loop a single `switch` without a hand-rolled tagged union.
struct RelayServerEnvelope: Decodable {
    let t: String
}

// MARK: - M4 Session messages (Frontend → Daemon)

/// `attach` — open a session; the daemon replies with a `state` frame
/// (`command-dispatcher.ts:468-479`). This is an *application-level* message
/// sealed with the frontend's tx key and published via `relay.pub` on the
/// session sid — distinct from the relay-level `relay.sub`, which only routes
/// frames. The frontend must send BOTH: subscribe (so the relay forwards the
/// daemon's reply) and attach (so the daemon produces one). Wire: `{ t, sid }`
/// (`packages/protocol/src/types/session-proto.ts:31-33`).
struct SessionAttach: Encodable, Equatable {
    let t = "attach"
    let sid: String
}

/// `resume` — request history backfill; the daemon replies with a `batch` of all
/// records whose `seq > c` (`command-dispatcher.ts:730-753`). The cursor field is
/// named `c` (NOT `after`/`cursor`/`seq`) and must be a non-negative integer
/// (`relay-guard.ts:120-128`). `c: 0` requests the full history. Sealed with tx,
/// published via `relay.pub` on the session sid.
/// Wire: `{ t, sid, c }` (`session-proto.ts:41-44`).
struct SessionResume: Encodable, Equatable {
    let t = "resume"
    let sid: String
    let c: Int
}

// MARK: - M5 Input messages (Frontend → Daemon)

/// `in.chat` — send a chat line into a session. `d` is **plain text**; the daemon
/// appends a trailing `\n` before writing to the PTY (`relay-manager.ts:107`), so
/// the app sends the line WITHOUT its own newline. Sealed with tx, published via
/// `relay.pub` on the session sid. Wire: `{ t, sid, d }`
/// (`packages/protocol/src/types/session-proto.ts:46-50`).
struct SessionInChat: Encodable, Equatable {
    let t = "in.chat"
    let sid: String
    let d: String // PLAIN text (daemon adds the newline)
}

/// `in.term` — send raw terminal bytes into a session. `d` is **base64** of the
/// raw PTY bytes; the daemon passes it straight through to the runner, which
/// base64-decodes before the PTY write (`runner.ts:186`). Sealed with tx,
/// published via `relay.pub`. Wire: `{ t, sid, d }` (`session-proto.ts:52-56`).
struct SessionInTerm: Encodable, Equatable {
    let t = "in.term"
    let sid: String
    let d: String // base64 of raw PTY bytes
}

// MARK: - M4 Session messages (Daemon → Frontend)

/// `state` — the daemon's reply to `attach` (and a push on session state change).
/// Carries the full `SessionMeta`. Wire: `{ t, sid, d }`
/// (`session-proto.ts:158-162`).
struct SessionStateMsg: Decodable, Equatable {
    let t: String
    let sid: String
    let d: SessionMeta
}

/// `rec` — one session record. Arrives inside a `batch` (history) and live during
/// a running session. `d` is **always base64-encoded** regardless of `k` (the
/// daemon does `Buffer.from(payload).toString("base64")` unconditionally,
/// `command-dispatcher.ts:950`), so decode base64 before any UTF-8/JSON parse.
/// `ns`/`n` are optional; everything else is required.
/// Wire: `{ t, sid, seq, k, ns?, n?, d, ts }` (`session-proto.ts:164-173`).
struct SessionRec: Decodable, Equatable {
    let t: String
    let sid: String
    let seq: Int
    let k: String // "io" | "event" | "meta"
    let ns: String?
    let n: String?
    let d: String // base64 payload, always present
    let ts: Double
}

/// `batch` — the daemon's reply to `resume`: the records with `seq > c`, oldest
/// first. Wire: `{ t, sid, d: [SessionRec] }` (`session-proto.ts:175-179`).
struct SessionBatch: Decodable, Equatable {
    let t: String
    let sid: String
    let d: [SessionRec]
}

// MARK: - M4 hook-event payloads (decoded from SessionRec.d when k == "event")

/// The always-present fields of a Claude hook event (`event.ts:19-24`). The TS
/// type has an open index signature, so event-subtype fields (`tool_name`,
/// `last_assistant_message`, …) are decoded separately from the same bytes.
struct HookEventBase: Decodable, Equatable {
    let session_id: String
    let hook_event_name: String
    let cwd: String
}

/// `Stop`/`StopFailure` extra field (`event.ts:26-29`). The Stop event's
/// `last_assistant_message` is the canonical assistant response (CLAUDE.md).
struct HookEventStop: Decodable, Equatable {
    let last_assistant_message: String?
}

/// `PreToolUse`/`PostToolUse` extra field (`event.ts:31-42`). `tool_input` is an
/// open shape and not rendered in M4, so only `tool_name` is decoded.
struct HookEventTool: Decodable, Equatable {
    let tool_name: String
}
