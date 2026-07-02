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
/// `v` advertises the frontend's WS protocol version (ADR-0003 A1.3#1: used for
/// resume/kx-skip version gating; the per-label v1/v2 gate in `sendRenameNotice`
/// was removed — daemon always emits the `{set,value}` union now).
/// (`relay-client.ts:488-491`).
struct KxPayload: Encodable, Equatable {
    let pk: String
    let frontendId: String
    let role = "frontend"
    /// Advertise protocol version 2 (resume + kx-skip support).
    let v = RelayProtocol.version
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

/// `relay.push.register` — register this device's APNs token with the daemon for
/// background push. The relay seals the (plaintext hex) `token` with its push-seal
/// key the instant it arrives — the token is never stored or forwarded in the
/// clear — then routes the sealed blob to the owning daemon as `relay.push.token`
/// (`rust/tp-relay/src/conn.rs route_push_register`, PR #741). The daemon's
/// `PushNotifier` stores the sealed token and uses it for APNs delivery.
///
/// Wire shape is exactly `{ t, frontendId, token, platform }` — camelCase keys,
/// verbatim from `packages/protocol/src/types/relay.ts` `RelayPushRegister` and
/// the Rust `RelayClientMessage::PushRegister` (`rust/tp-proto/src/relay_client.rs`).
/// `platform` is the lowercase string the `Platform` enum serializes to
/// (`"ios"` / `"android"`); the app always sends `"ios"` (the only APNs target —
/// macOS/visionOS APNs is a separate device-gated follow-up).
struct RelayPushRegister: Encodable, Equatable {
    let t = "relay.push.register"
    let frontendId: String
    let token: String
    let platform: String
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

/// `relay.err` — a connection- or frontend-scoped error reply. `e` is a short
/// machine code (`"RATE_LIMITED"`, `"UNAUTHORIZED"`, `"PUSH_TOKEN_DEAD"`, …);
/// `m` is an optional human-readable detail. Verbatim from
/// `packages/protocol/src/types/relay.ts` `RelayError`. BATCH F (#15): the
/// frontend previously never decoded this frame at all — `RATE_LIMITED` is
/// the first `e` value the app surfaces to the user (via
/// `RelayClient.connectionCause`).
struct RelayErrorFrame: Decodable, Equatable {
    let t: String
    let e: String
    let m: String?
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
/// (`{pk, role, v, label}`, `relay-client.ts:431-456`). `pk` is the daemon's
/// current X25519 pubkey (authoritative for session-key derivation, tracking
/// keypair rotations a stale pairing-bundle pubkey would miss). `label` carries
/// the daemon's configured name; the frontend adopts it when the local label is
/// unset (M10). `v` is the daemon's WS protocol version — absent means v1.
struct DaemonKxPayload: Decodable, Equatable {
    let pk: String
    /// Daemon label tagged-union. `{ set: true, value: "…" }` → set name;
    /// `{ set: false }` → daemon has no label (keep current local label).
    /// Absent field → treat as no-label (keep). Optional so old daemons decode.
    let label: LabelWire?
    /// WS protocol version the daemon advertises. Absent = 1 (legacy).
    let v: Int?

    /// Tagged-union form of the Label type sent in the daemon's kx payload and
    /// inbound `control.rename` messages. `{ set: true, value: "…" }` sets a name;
    /// `{ set: false }` is an authoritative "no label" signal.
    struct LabelWire: Decodable, Equatable {
        let set: Bool
        let value: String?
    }
}

/// `relay.notification` — the relay's IN-BAND notification delivery path. When the
/// daemon emits a `relay.push` AND this frontend is currently live on the relay
/// WebSocket, the relay delivers the notification directly here instead of routing
/// it to APNs (the two paths are mutually exclusive per message — WS when
/// connected, APNs when offline; `packages/relay/src/relay-server.ts handlePush`).
/// So this is the path used while the app is foregrounded + connected; without
/// handling it, in-session notifications that fire while the app is open are lost.
///
/// Wire: `{ t, title, body, data? }` where `data` is absent OR
/// `{ sid, daemonId, event }` (the relay guard rejects a `null` data — it is
/// either absent or a full object). Verbatim from
/// `packages/protocol/src/types/relay.ts` `RelayNotification`.
struct RelayNotification: Decodable, Equatable {
    let t: String
    let title: String
    let body: String
    let data: NotificationData?

    /// Optional routing payload. `sid` lets a notification tap deep-link to the
    /// originating session (mirrors `userInfo["sid"]` on local notifications).
    struct NotificationData: Decodable, Equatable {
        let sid: String
        let daemonId: String
        let event: String
    }
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
    let state: String  // "running" | "stopped" | "error" — NOT named "status"
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
/// appends a trailing carriage return (`\r`, NOT `\n`) before writing to the PTY
/// (`relay-manager.ts onInput`, PR #738), so the app sends the line WITHOUT its own
/// terminator. (`\r` is what claude's interactive TUI treats as submit — a glued
/// `text\r` in one PTY write submits the prompt; `\n` does not.) Sealed with tx,
/// published via `relay.pub` on the session sid. Wire: `{ t, sid, d }`
/// (`packages/protocol/src/types/session-proto.ts:46-50`).
struct SessionInChat: Encodable, Equatable {
    let t = "in.chat"
    let sid: String
    let d: String  // PLAIN text (daemon adds the newline)
}

/// `in.term` — send raw terminal bytes into a session. `d` is **base64** of the
/// raw PTY bytes; the daemon passes it straight through to the runner, which
/// base64-decodes before the PTY write (`runner.ts:186`). Sealed with tx,
/// published via `relay.pub`. Wire: `{ t, sid, d }` (`session-proto.ts:52-56`).
struct SessionInTerm: Encodable, Equatable {
    let t = "in.term"
    let sid: String
    let d: String  // base64 of raw PTY bytes
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
    let k: String  // "io" | "event" | "meta"
    let ns: String?
    let n: String?
    let d: String  // base64 payload, always present
    let ts: Double
}

/// `batch` — the daemon's reply to `resume`: the records with `seq > c`, oldest
/// first. Wire: `{ t, sid, d: [SessionRec] }` (`session-proto.ts:175-179`).
struct SessionBatch: Decodable, Equatable {
    let t: String
    let sid: String
    let d: [SessionRec]
}

// MARK: - E Terminal input/resize (Frontend → Daemon)

/// `resize` — resize the PTY of a running session. `cols` and `rows` must be
/// positive integers. The daemon validates both fields with `isPositiveInt`
/// (`relay-guard.ts`, `parseRelayControlMessage`) and forwards the message to
/// the runner IPC. Wire: `{ t, sid, cols, rows }`.
///
/// Reference: `packages/protocol/src/types/session-proto.ts`, `SessionResize`.
/// Validation: `packages/protocol/src/relay-guard.ts`, `parseRelayControlMessage`.
struct SessionResize: Encodable, Equatable {
    let t = "resize"
    let sid: String
    let cols: Int
    let rows: Int
}

// MARK: - Inbound control messages (Daemon → Frontend, on __control__ sid)

/// Inbound `control.unpair` — the daemon notifies this frontend that the pairing
/// was removed on the daemon side (e.g. `tp pair delete`). Received as a
/// `relay.frame` on the `__control__` sid, decrypted with `rx` session keys.
/// Wire: `{ t, daemonId, frontendId, reason, ts }` (`packages/protocol/src/types/control.ts`).
struct ControlUnpairInbound: Decodable {
    let t: String
    let daemonId: String
    let frontendId: String
    let reason: String
}

/// Inbound `control.rename` — the daemon notifies this frontend that its label
/// was changed (e.g. `tp pair rename`). The `label` field is a tagged union:
/// `{ set: true, value: "…" }` sets a name; `{ set: false }` clears it.
/// Wire: `{ t, daemonId, frontendId, label: { set, value? }, ts }`.
/// Under ADR-0003 A1.3#1 the `label` field is REQUIRED+present on every
/// `control.rename` — the daemon's per-label v1/v2 version gate was removed
/// and the union is always emitted. A bare-`String` payload (pre-removal legacy)
/// would fail decode and be logged/dropped as a safety net.
struct ControlRenameInbound: Decodable {
    let t: String
    let daemonId: String
    let frontendId: String
    let label: LabelWire

    struct LabelWire: Decodable {
        let set: Bool
        let value: String?
    }
}

// MARK: - Worktree replies (Daemon → Frontend, on __control__ sid)

/// One git worktree, as reported by the daemon's `worktree.list` /
/// `worktree.created` replies. Wire shape `{ path, branch, head, isMain }`,
/// verbatim from `WorktreeInfo` (`packages/protocol/src/types/session-proto.ts`,
/// validated by `session-server-guard.ts`). `branch` is null for a detached HEAD;
/// `isMain` marks the repo's primary worktree (not removable).
struct WorktreeInfo: Decodable, Equatable, Identifiable {
    let path: String
    let branch: String?
    let head: String
    let isMain: Bool

    /// Stable identity for SwiftUI lists — the path is unique per worktree.
    var id: String { path }
}

/// Inbound `worktree.list` reply — the daemon's full worktree enumeration.
/// Wire: `{ t, d: WorktreeInfo[] }` (`command-dispatcher.ts handleRelayWorktreeList`).
struct WorktreeListReply: Decodable, Equatable {
    let t: String
    let d: [WorktreeInfo]
}

/// Inbound `worktree.created` reply — a worktree was created (and a session
/// auto-spawned in it). Wire: `{ t, d: WorktreeInfo, sid }`
/// (`command-dispatcher.ts handleRelayWorktreeCreate`). The `sid` is the
/// auto-created session; it also surfaces in the next `hello`/`state` on `__meta__`.
struct WorktreeCreatedReply: Decodable, Equatable {
    let t: String
    let d: WorktreeInfo
    let sid: String?
}

/// Inbound `worktree.removed` reply — the worktree at `path` was removed.
/// Wire: `{ t, path }` (`command-dispatcher.ts handleRelayWorktreeRemove`).
struct WorktreeRemovedReply: Decodable, Equatable {
    let t: String
    let path: String
}

/// Inbound `err` reply on `__control__` — a worktree op failed. Wire:
/// `{ t: "err", e, m }` where `e` is `NO_REPO` (daemon not in a git repo) or
/// `WORKTREE_ERROR` (git failure), and `m` is a human-readable message
/// (`command-dispatcher.ts withWorktreeManager`).
struct ControlErrInbound: Decodable, Equatable {
    let t: String
    let e: String
    let m: String?
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
/// `error` is present on `StopFailure` events (L6).
struct HookEventStop: Decodable, Equatable {
    let last_assistant_message: String?
    let error: String?
}

/// `PreToolUse`/`PostToolUse` extra field (`event.ts:31-42`). `tool_name` is
/// required; `tool_input`/`tool_result` are open shapes decoded as compact JSON
/// strings (I1 — capped at 500 chars for display).
struct HookEventTool: Decodable, Equatable {
    let tool_name: String
    let tool_input: RawJSONString?
    let tool_result: RawJSONString?
}

/// `UserPromptSubmit` extra field (H2). Expo ground truth (`chat-store.ts:107-109`):
/// `user_prompt ?? prompt ?? ""`.
struct HookEventPrompt: Decodable, Equatable {
    let user_prompt: String?
    let prompt: String?
}

/// `PermissionRequest` extra field (M5). `tool_name` may be absent.
struct HookEventPermission: Decodable, Equatable {
    let tool_name: String?
}

/// `Elicitation` extra field (M5). `message` carries the prompt text.
struct HookEventElicitation: Decodable, Equatable {
    let message: String?
}

// MARK: - RawJSONString

/// A Decodable wrapper that captures any JSON value (object, array, scalar) as
/// a compact JSON string. Used for open-shape fields like `tool_input`/`tool_result`
/// where a typed struct would over-constrain the schema (I1).
struct RawJSONString: Decodable, Equatable {
    let value: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        // Try common scalar types first to avoid the expense of JSONSerialization.
        if let s = try? c.decode(String.self) {
            value = s
        } else if let i = try? c.decode(Int.self) {
            value = "\(i)"
        } else if let d = try? c.decode(Double.self) {
            value = "\(d)"
        } else if let b = try? c.decode(Bool.self) {
            value = b ? "true" : "false"
        } else {
            // Structured value: re-encode via JSONSerialization.
            // Decode as generic Any first by going through the raw representation.
            // We abuse JSONDecoder to get the raw bytes back for re-serialisation.
            let raw = try c.decode(AnyDecodable.self)
            if let data = try? JSONSerialization.data(
                withJSONObject: raw.value,
                options: [.sortedKeys]),
                let s = String(data: data, encoding: .utf8)
            {
                value = s
            } else {
                value = "<unserializable>"
            }
        }
    }

    /// Display-safe compact string, capped at 500 characters.
    var displayValue: String {
        value.count > 500 ? String(value.prefix(500)) + "…" : value
    }
}

// MARK: - AnyDecodable helper

/// Minimal Any-typed Decodable for capturing arbitrary JSON (used by RawJSONString).
private struct AnyDecodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) {
            value = v
            return
        }
        if let v = try? c.decode(Int.self) {
            value = v
            return
        }
        if let v = try? c.decode(Double.self) {
            value = v
            return
        }
        if let v = try? c.decode(String.self) {
            value = v
            return
        }
        if let v = try? c.decode([String: AnyDecodable].self) {
            value = v.mapValues { $0.value }
            return
        }
        if let v = try? c.decode([AnyDecodable].self) {
            value = v.map { $0.value }
            return
        }
        value = NSNull()
    }
}
