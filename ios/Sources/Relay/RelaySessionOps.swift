import Foundation
import os

// MARK: - Session control wire message

/// `session.create` — the app-level control message the frontend sends to ask
/// the daemon to spawn a new Claude Code session at `cwd`.
///
/// Wire shape: `{ t, cwd, sid?, cols?, rows? }` — matches
/// `parseRelayControlMessage` case "session.create" in
/// `packages/protocol/src/relay-guard.ts` (both `cols` and `rows` are validated
/// by `isOptionalPositiveInt`, meaning they may be absent). The daemon generates
/// its own sid when `sid` is nil. Sealed with the frontend's tx key and published
/// via `relay.pub` on `__meta__` (same channel as `hello`/`ping`).
///
/// L4 fix: `cols`/`rows` are now included so the daemon can spawn the PTY at the
/// correct initial size. Pass current terminal dimensions when available; omit
/// (nil) when unknown (daemon falls back to its own default).
struct SessionCreate: Encodable, Equatable {
    let t = "session.create"
    let cwd: String
    let sid: String?
    /// L4: optional PTY width hint (columns). Omitted when nil; daemon uses its default.
    let cols: Int?
    /// L4: optional PTY height hint (rows). Omitted when nil; daemon uses its default.
    let rows: Int?

    enum CodingKeys: String, CodingKey {
        case t, cwd, sid, cols, rows
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(t, forKey: .t)
        try c.encode(cwd, forKey: .cwd)
        try c.encodeIfPresent(sid, forKey: .sid)
        try c.encodeIfPresent(cols, forKey: .cols)
        try c.encodeIfPresent(rows, forKey: .rows)
    }
}

/// `session.stop` — ask the daemon to kill the running Claude process for `sid`
/// (the session row is kept; it transitions to `stopped`). Wire shape `{ t, sid }`,
/// matches `parseRelayControlMessage` case "session.stop" in `relay-guard.ts`.
struct SessionStop: Encodable, Equatable {
    let t = "session.stop"
    let sid: String
}

/// `session.delete` — ask the daemon to permanently delete `sid` (kills the
/// runner if running, then drops the store row). Wire shape `{ t, sid }`, matches
/// `parseRelayControlMessage` case "session.delete" in `relay-guard.ts`. The
/// daemon replies `session.delete.ok`/`err` to this frontend; other frontends
/// drop the ghost row on their next `hello`.
struct SessionDelete: Encodable, Equatable {
    let t = "session.delete"
    let sid: String
}

// MARK: - RelayClient extension

extension RelayClient {
    /// Ask the daemon to create a new Claude Code session at `cwd`.
    ///
    /// Seals `{ t: "session.create", cwd, cols?, rows? }` with the frontend's
    /// tx key and publishes it on `__meta__` via `relay.pub`. The daemon spawns a
    /// new runner; the session list update arrives as a `hello` push (which
    /// `onHello` routes into `SessionStore`).
    ///
    /// - Parameters:
    ///   - cwd: Absolute path for the new session's working directory.
    ///   - cols: Optional PTY column count (L4 fix). Pass current terminal width when
    ///     known; omit to let the daemon use its own default.
    ///   - rows: Optional PTY row count (L4 fix). Pass current terminal height when
    ///     known; omit to let the daemon use its own default.
    /// - Returns: `true` if the control message was published (kx complete),
    ///   `false` if the client is not ready yet.
    ///
    /// Bridged through `publishControl` (RelayClient.swift), which seals with the
    /// frontend's tx key and publishes on `__meta__`. The daemon spawns a runner
    /// and the session list update arrives as a `hello` push (`onHello` →
    /// `replaceSessionsForDaemon`).
    @discardableResult
    func createSession(cwd: String, cols: Int? = nil, rows: Int? = nil) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.session")
        let msg = SessionCreate(cwd: cwd, sid: nil, cols: cols, rows: rows)
        let sent = publishControl(msg, on: RelayChannel.meta)
        log.notice(
            "createSession cwd=\(cwd, privacy: .public) cols=\(cols.map(String.init) ?? "nil", privacy: .public) rows=\(rows.map(String.init) ?? "nil", privacy: .public) sent=\(sent, privacy: .public)"
        )
        return sent
    }

    /// Ask the daemon to stop (kill the Claude process for) `sid`. The session
    /// row is kept and transitions to `stopped`; the daemon broadcasts the new
    /// state via `relay.state`. Returns `true` if the control frame was published.
    @discardableResult
    func stopSession(sid: String) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.session")
        let sent = publishControl(SessionStop(sid: sid), on: RelayChannel.meta)
        log.notice(
            "stopSession sid=\(sid, privacy: .public) sent=\(sent, privacy: .public)"
        )
        return sent
    }

    /// Ask the daemon to permanently delete `sid` (kills the runner if running,
    /// then drops the store row). Returns `true` if the control frame was
    /// published. The daemon replies `session.delete.ok`/`err` on this frontend's
    /// peer channel.
    @discardableResult
    func deleteSession(sid: String) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.session")
        let sent = publishControl(SessionDelete(sid: sid), on: RelayChannel.meta)
        log.notice(
            "deleteSession sid=\(sid, privacy: .public) sent=\(sent, privacy: .public)"
        )
        return sent
    }
}
