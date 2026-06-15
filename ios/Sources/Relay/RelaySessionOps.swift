import Foundation
import os

// MARK: - Session control wire message

/// `session.create` — the app-level control message the frontend sends to ask
/// the daemon to spawn a new Claude Code session at `cwd`.
///
/// Wire shape: `{ t, cwd, sid? }` — matches `parseRelayControlMessage` case
/// "session.create" in `packages/protocol/src/relay-guard.ts`. The daemon
/// generates its own sid when `sid` is nil. Sealed with the frontend's tx key
/// and published via `relay.pub` on `__meta__` (same channel as `hello`/`ping`).
struct SessionCreate: Encodable, Equatable {
    let t = "session.create"
    let cwd: String
    let sid: String?
}

// MARK: - RelayClient extension

extension RelayClient {
    /// Ask the daemon to create a new Claude Code session at `cwd`.
    ///
    /// Seals `{ t: "session.create", cwd }` with the frontend's tx key and
    /// publishes it on `__meta__` via `relay.pub`. The daemon spawns a new
    /// runner; the session list update arrives as a `hello` push (which
    /// `onHello` routes into `SessionStore`).
    ///
    /// - Parameter cwd: Absolute path for the new session's working directory.
    ///
    /// ## Backend wire gap
    /// `sessionKeys` and `send(_:completion:)` are `private` in RelayClient.swift,
    /// so this extension **cannot** access them directly (Swift does not allow
    /// cross-file `private` member access even in the same module). The actual
    /// encrypt+send must be bridged via one of:
    ///   1. Change `sessionKeys` and `send` to `internal` in RelayClient.swift.
    ///   2. Add a `sendControlMessage<T: Encodable>(_ msg: T, sid: String)` internal
    ///      method to RelayClient.swift that this extension can call.
    /// Until that bridge exists, `createSession(cwd:)` is a no-op relay-wise.
    /// The UI layer adds the session optimistically via `SessionStore`; the daemon
    /// will create it once the wire gap is closed.
    ///
    /// TODO(sessions-crud): Close the private-member gap so this actually sends.
    func createSession(cwd: String) {
        // The implementation intentionally logs the intent but cannot seal/send
        // due to Swift private access rules across files. See the doc comment.
        let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "relay.session")
        log.notice("createSession cwd=\(cwd, privacy: .public) — relay send TODO (sessionKeys private)")
    }
}
