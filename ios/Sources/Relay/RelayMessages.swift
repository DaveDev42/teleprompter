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

/// A server message decoded far enough to dispatch on `t`. The full payload is
/// re-decoded into the concrete type once the tag is known — this keeps the
/// receive loop a single `switch` without a hand-rolled tagged union.
struct RelayServerEnvelope: Decodable {
    let t: String
}
