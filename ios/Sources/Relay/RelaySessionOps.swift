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
    /// - Returns: `true` if the control message was published (kx complete),
    ///   `false` if the client is not ready yet (the optimistic local entry in
    ///   `SessionStore` still keeps the UI consistent in that case).
    ///
    /// Bridged through `publishControl` (RelayClient.swift), which seals with the
    /// frontend's tx key and publishes on `__meta__`. The daemon spawns a runner
    /// and the session list update arrives as a `hello` push (`onHello` →
    /// `SessionStore`), replacing the optimistic placeholder.
    @discardableResult
    func createSession(cwd: String) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "relay.session")
        let sent = publishControl(SessionCreate(cwd: cwd, sid: nil), on: RelayChannel.meta)
        log.notice("createSession cwd=\(cwd, privacy: .public) sent=\(sent, privacy: .public)")
        return sent
    }
}
