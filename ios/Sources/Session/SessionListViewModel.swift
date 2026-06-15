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
    /// The relay send is bridged through `RelayClient.publishControl`
    /// (integration pass) and routed via `PairingViewModel.createSession(cwd:)`.
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

        // 2. Relay send (best-effort). Routes through PairingViewModel, which
        //    owns the relay clients, to the sole connected client. When a session
        //    fires back via `hello`, the daemon's real sid upserts over the
        //    placeholder. If kx is not yet complete the send is a no-op and the
        //    optimistic local entry keeps the UI consistent until reconnect.
        //    TODO(sessions-crud): pass the selected daemonId for multi-daemon.
        createSession(cwd: cwd)
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
