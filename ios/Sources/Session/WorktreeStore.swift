import Foundation
import os

/// Observable store for per-daemon git worktree lists, fed by the daemon's
/// `worktree.list` / `worktree.created` / `worktree.removed` replies (decoded in
/// `RelayClient.onRelayFrame`'s `__control__` branch and routed here on the main
/// actor).
///
/// `@MainActor` + `ObservableObject` mirrors `SessionStore`: `@Published`
/// mutations drive SwiftUI updates, and the relay callbacks already hop to the
/// main actor before writing. The store is intentionally a thin per-daemon cache —
/// the daemon is the source of truth; the app re-requests `worktree.list` whenever
/// the worktree UI appears and applies incremental created/removed deltas in
/// between.
@MainActor
final class WorktreeStore: ObservableObject {
    static let shared = WorktreeStore()

    private let log = Logger(subsystem: "dev.tpmt.app", category: "worktree-store")

    /// Worktrees per daemon id. Replaced wholesale on a `worktree.list` reply and
    /// patched on `worktree.created` / `worktree.removed`.
    @Published private(set) var worktrees: [String: [WorktreeInfo]] = [:]

    /// The most recent worktree-op error per daemon (e.g. `NO_REPO` when the daemon
    /// is not in a git repo), surfaced in the UI and cleared on the next success.
    @Published private(set) var lastError: [String: String] = [:]

    private init() {}

    /// Read accessor: the worktrees known for a daemon (empty until the first list).
    func worktrees(for daemonId: String) -> [WorktreeInfo] {
        worktrees[daemonId] ?? []
    }

    /// Read accessor: the last error string for a daemon, or nil.
    func error(for daemonId: String) -> String? {
        lastError[daemonId]
    }

    /// Replace the full worktree list for a daemon (from a `worktree.list` reply).
    func replaceList(_ list: [WorktreeInfo], for daemonId: String) {
        worktrees[daemonId] = list
        lastError[daemonId] = nil
        log.notice(
            "replaceList daemon=\(daemonId, privacy: .public) count=\(list.count, privacy: .public)")
    }

    /// Apply a `worktree.created` reply: upsert the new worktree (dedupe by path).
    func upsert(_ wt: WorktreeInfo, for daemonId: String) {
        var list = worktrees[daemonId] ?? []
        if let idx = list.firstIndex(where: { $0.path == wt.path }) {
            list[idx] = wt
        } else {
            list.append(wt)
        }
        worktrees[daemonId] = list
        lastError[daemonId] = nil
        log.notice(
            "upsert daemon=\(daemonId, privacy: .public) path=\(wt.path, privacy: .public)")
    }

    /// Apply a `worktree.removed` reply: drop the worktree at `path`.
    func remove(path: String, for daemonId: String) {
        guard var list = worktrees[daemonId] else { return }
        list.removeAll { $0.path == path }
        worktrees[daemonId] = list
        lastError[daemonId] = nil
        log.notice(
            "remove daemon=\(daemonId, privacy: .public) path=\(path, privacy: .public)")
    }

    /// Record a worktree-op error for a daemon (from an `err` reply).
    func setError(_ message: String, for daemonId: String) {
        lastError[daemonId] = message
        log.notice(
            "setError daemon=\(daemonId, privacy: .public) msg=\(message, privacy: .public)")
    }
}
