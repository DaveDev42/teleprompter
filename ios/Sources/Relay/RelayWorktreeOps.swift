import Foundation
import os

// MARK: - Worktree control wire messages (Frontend → Daemon)

/// `worktree.list` — ask the daemon to enumerate its git worktrees. No fields.
/// Wire shape `{ t }`, matches `parseRelayControlMessage` case "worktree.list"
/// (`packages/protocol/src/relay-guard.ts`). The daemon replies on `__control__`
/// with `{ t: "worktree.list", d: WorktreeInfo[] }` (or an `err` frame when the
/// daemon is not in a git repo). Sealed with tx, published on `__meta__` — the
/// same control channel as `session.create` (the daemon's `decryptAndDispatch`
/// routes every control-plane message that arrives on a subscribed sid).
struct WorktreeList: Encodable, Equatable {
    let t = "worktree.list"
}

/// `worktree.create` — ask the daemon to create a git worktree for `branch`.
/// Wire shape `{ t, branch, baseBranch?, path? }`, matches `parseRelayControlMessage`
/// case "worktree.create" (`relay-guard.ts`) and the daemon handler
/// (`command-dispatcher.ts handleRelayWorktreeCreate`). `baseBranch` selects the
/// branch to fork from (daemon default when absent); `path` overrides the worktree
/// directory (daemon derives `<branch>-<ts36>` when absent). On success the daemon
/// ALSO auto-creates a session in the new worktree and replies on `__control__`
/// with `{ t: "worktree.created", d: WorktreeInfo, sid }` — so the new session
/// appears in the next `hello`/`state` on `__meta__` automatically.
struct WorktreeCreate: Encodable, Equatable {
    let t = "worktree.create"
    let branch: String
    let baseBranch: String?
    let path: String?

    enum CodingKeys: String, CodingKey {
        case t, branch, baseBranch, path
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(t, forKey: .t)
        try c.encode(branch, forKey: .branch)
        try c.encodeIfPresent(baseBranch, forKey: .baseBranch)
        try c.encodeIfPresent(path, forKey: .path)
    }
}

/// `worktree.remove` — ask the daemon to remove the worktree at `path`. Wire shape
/// `{ t, path, force? }`, matches `parseRelayControlMessage` case "worktree.remove"
/// (`relay-guard.ts`). `force` removes even with uncommitted changes (passed to
/// `git worktree remove --force`). The daemon replies on `__control__` with
/// `{ t: "worktree.removed", path }` (or an `err` frame).
struct WorktreeRemove: Encodable, Equatable {
    let t = "worktree.remove"
    let path: String
    let force: Bool?

    enum CodingKeys: String, CodingKey {
        case t, path, force
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(t, forKey: .t)
        try c.encode(path, forKey: .path)
        try c.encodeIfPresent(force, forKey: .force)
    }
}

// MARK: - RelayClient extension

extension RelayClient {
    /// Ask the daemon to list its git worktrees. The reply (`worktree.list`) lands
    /// on `__control__` and is routed to `onWorktreeList` → `WorktreeStore`.
    /// Returns `true` if the control frame was published (kx complete).
    @discardableResult
    func listWorktrees() -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.worktree")
        let sent = publishControl(WorktreeList(), on: RelayChannel.meta)
        log.notice("listWorktrees sent=\(sent, privacy: .public)")
        return sent
    }

    /// Ask the daemon to create a worktree for `branch` (optionally forked from
    /// `baseBranch`, at an explicit `path`). On success the daemon also spawns a
    /// session in the worktree. Returns `true` if the control frame was published.
    @discardableResult
    func createWorktree(branch: String, baseBranch: String? = nil, path: String? = nil) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.worktree")
        let msg = WorktreeCreate(branch: branch, baseBranch: baseBranch, path: path)
        let sent = publishControl(msg, on: RelayChannel.meta)
        log.notice(
            "createWorktree branch=\(branch, privacy: .public) base=\(baseBranch ?? "nil", privacy: .public) sent=\(sent, privacy: .public)"
        )
        return sent
    }

    /// Ask the daemon to remove the worktree at `path` (`force` to discard
    /// uncommitted changes). Returns `true` if the control frame was published.
    @discardableResult
    func removeWorktree(path: String, force: Bool = false) -> Bool {
        let log = Logger(subsystem: "dev.tpmt.app", category: "relay.worktree")
        let sent = publishControl(WorktreeRemove(path: path, force: force), on: RelayChannel.meta)
        log.notice(
            "removeWorktree path=\(path, privacy: .public) force=\(force, privacy: .public) sent=\(sent, privacy: .public)"
        )
        return sent
    }

    // MARK: - Inbound worktree reply handlers (called from onRelayFrame)

    /// `worktree.list` reply → replace the daemon's worktree list in the store.
    /// Called off-main (URLSession delegate queue); hops to the main actor.
    func onWorktreeList(_ list: [WorktreeInfo]) {
        let did = daemonId
        Task { @MainActor in WorktreeStore.shared.replaceList(list, for: did) }
    }

    /// `worktree.created` reply → upsert the new worktree. (The auto-created
    /// session arrives separately via `hello`/`state` on `__meta__`.)
    func onWorktreeCreated(_ wt: WorktreeInfo) {
        let did = daemonId
        Task { @MainActor in WorktreeStore.shared.upsert(wt, for: did) }
    }

    /// `worktree.removed` reply → drop the worktree at `path` from the store.
    func onWorktreeRemoved(_ path: String) {
        let did = daemonId
        Task { @MainActor in WorktreeStore.shared.remove(path: path, for: did) }
    }

    /// `err` reply on `__control__` → record the worktree-op error for this daemon
    /// (e.g. `NO_REPO` when the daemon is not in a git repo).
    func onControlErr(code: String, message: String?) {
        let did = daemonId
        let text = message ?? code
        Task { @MainActor in WorktreeStore.shared.setError(text, for: did) }
    }
}
