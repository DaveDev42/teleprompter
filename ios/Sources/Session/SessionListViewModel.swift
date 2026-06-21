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
    /// H4 fix: the previous optimistic `pending-*` placeholder was never replaced
    /// by the daemon's real sid (different key in the dict), so it persisted as a
    /// ghost row. Expo had NO optimistic add — it relied on the daemon's hello push.
    /// We match Expo: just fire the relay send and let the next `hello` (which calls
    /// `replaceSessionsForDaemon`) bring in the new session. L1's 3s toast in the
    /// sheet provides failure feedback when the daemon doesn't respond.
    ///
    /// The relay send is bridged through `RelayClient.publishControl`
    /// (integration pass) and routed via `PairingViewModel.createSession(cwd:)`.
    @MainActor
    func createSession(cwd: String, sessionStore: SessionStore) {
        // Relay send (best-effort). Routes through PairingViewModel, which
        // owns the relay clients, to the sole connected client. When a session
        // fires back via `hello`, replaceSessionsForDaemon adds it to the list.
        // TODO(sessions-crud): pass the selected daemonId for multi-daemon.
        createSession(cwd: cwd)
    }

    // MARK: Refresh

    /// Ask every connected daemon for a fresh session list (M1 pull-to-refresh).
    /// Each client sends a sealed `hello` request on `__meta__`; the daemon replies
    /// with its current session list via `replaceSessionsForDaemon`.
    func refreshSessions() {
        for did in daemonIds {
            client(for: did)?.sendHello()
        }
    }

    // MARK: Stop

    /// Ask the daemon to stop (kill the Claude process for) `sid`. The session
    /// row is kept and transitions to `stopped`; the new state arrives via the
    /// daemon's `state` broadcast (`onState` → `SessionStore`). Routes to the
    /// owning daemon's relay client.
    @MainActor
    @discardableResult
    func stopSession(_ sid: String, from sessionStore: SessionStore) -> Bool {
        let did = sessionStore.daemonId(for: sid)
        let relayClient = did.flatMap { client(for: $0) } ?? firstClient()
        return relayClient?.stopSession(sid: sid) ?? false
    }

    // MARK: Delete

    /// Request daemon-side deletion of `sids`, then remove them from the local
    /// `SessionStore`.
    ///
    /// Each sid is routed to its owning daemon's relay client as a
    /// `session.delete` control message (the relay-plane sibling of the CLI's
    /// `tp session delete <sid>`). The daemon kills the runner if running, drops
    /// the store row, and replies `session.delete.ok`/`err` on this frontend's
    /// peer channel. We optimistically remove the local row immediately (matching
    /// the snappy `createSession` pattern that relies on the daemon's async push);
    /// the next `hello` is authoritative, and the deleted row stays gone because
    /// the daemon no longer reports it.
    @MainActor
    func deleteSessions(_ sids: [String], from sessionStore: SessionStore) {
        for sid in sids {
            let did = sessionStore.daemonId(for: sid)
            let relayClient = did.flatMap { client(for: $0) } ?? firstClient()
            relayClient?.deleteSession(sid: sid)
        }
        sessionStore.removeSessions(sids)
    }
}
