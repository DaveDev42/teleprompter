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
