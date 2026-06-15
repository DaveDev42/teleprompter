import Foundation

// MARK: - PairingViewModel + session CRUD

/// Session-management actions on `PairingViewModel`.
///
/// `PairingViewModel` owns the live relay clients, so all session operations
/// that touch the relay route through it. UI code calls these methods rather
/// than reaching into `RelayClient` directly.
extension PairingViewModel {

    // MARK: Create

    /// Request the daemon to create a new session at `cwd`.
    ///
    /// The operation has two parts:
    /// 1. **Local optimistic add**: a placeholder `SessionMeta` is inserted into
    ///    `sessionStore` immediately so the UI reflects the intent without waiting
    ///    for the daemon round-trip.
    /// 2. **Relay send**: `session.create { cwd }` is sent to the daemon via the
    ///    relay. The daemon spawns a runner and pushes a `hello` update; when
    ///    that arrives, `upsertSessions` replaces the placeholder with the
    ///    authoritative metadata (real `sid`, correct `createdAt`, etc.).
    ///
    /// ## Wire gap
    /// `RelayClient.createSession(cwd:)` currently cannot seal+send the control
    /// message because `sessionKeys` / `send` are `private` in RelayClient.swift
    /// (Swift cross-file private rule). The relay call is a no-op today; it logs
    /// the intent. Close by making those members `internal`, or adding a bridging
    /// method to RelayClient.swift.
    /// TODO(sessions-crud): remove this note once the wire gap is closed.
    @MainActor
    func createSession(cwd: String, sessionStore: SessionStore) {
        // 1. Optimistic local entry: use a client-generated sid prefixed
        //    "pending-" so it's distinguishable from daemon-assigned sids.
        //    The daemon's hello push will upsert the real sid on top.
        let placeholderSid = "pending-\(UUID().uuidString.prefix(8).lowercased())"
        let now = Date().timeIntervalSince1970 * 1000 // ms
        let placeholder = SessionMeta(
            sid: placeholderSid,
            state: "stopped",     // will be updated to "running" by daemon push
            cwd: cwd,
            createdAt: now,
            updatedAt: now,
            lastSeq: 0,
        )
        sessionStore.upsertSessions([placeholder])

        // 2. Relay send (best-effort; no-op today due to wire gap).
        //    Routes to the first authenticated relay client. When N-daemon
        //    support lands, the caller should pass the target daemonId.
        //    TODO(sessions-crud): pass the selected daemonId once the wire
        //    gap is closed and multi-daemon create is needed.
        sendCreateSession(cwd: cwd)
    }

    /// Internal: broadcast `session.create { cwd }` to the first available
    /// relay client. Safe to call even when no client is connected — the
    /// client's `createSession(cwd:)` is a no-op if not authenticated.
    private func sendCreateSession(cwd: String) {
        // `clients` is `private` on PairingViewModel (defined in TeleprompterApp.swift),
        // so we cannot iterate it here. We route through the public `sendInput`
        // method as an indirect proxy — the relay path is a TODO.
        //
        // TODO(sessions-crud): Once RelayClient.createSession exposes proper
        // relay send (closing the sessionKeys gap), wire it here by either:
        //   a) Adding `func sendToFirstClient<F: Encodable>(control: F, sid: String)` to
        //      PairingViewModel in TeleprompterApp.swift, or
        //   b) Making `clients` internal and calling client.createSession(cwd:) here.
        //
        // For now: the relay send is a no-op; the optimistic local entry in
        // createSession(cwd:sessionStore:) keeps the UI consistent.
    }

    // MARK: Delete (local-only)

    /// Remove sessions from the local `SessionStore`.
    ///
    /// **This is a local-only operation.** The relay protocol does not expose
    /// a `session.delete` control message (`relay-guard.ts` case list has
    /// `session.create` / `session.stop` / `session.restart` but NOT
    /// `session.delete`). To delete on the daemon use the CLI:
    /// `tp session delete <sid>`.
    ///
    /// TODO(sessions-crud): add `session.delete` to the relay control protocol
    /// (relay-guard.ts + parseRelayControlMessage + command-dispatcher handling)
    /// so the app can request daemon-side deletion.
    @MainActor
    func deleteSessions(_ sids: [String], from sessionStore: SessionStore) {
        sessionStore.removeSessions(sids)
    }
}
