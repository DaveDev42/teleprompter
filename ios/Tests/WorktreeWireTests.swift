import XCTest

@testable import Teleprompter

/// Unit tests for the worktree wire messages (Task #100): the outbound
/// `worktree.list` / `worktree.create` / `worktree.remove` requests the app sends
/// over `__meta__`, and the inbound `worktree.list` / `worktree.created` /
/// `worktree.removed` / `err` replies the daemon sends over `__control__`.
///
/// Byte-exactness matters — the daemon parses by exact `t` literal + exact field
/// names (`packages/protocol/src/relay-guard.ts parseRelayControlMessage`,
/// `packages/daemon/src/ipc/command-dispatcher.ts handleRelayWorktree*`). Offline:
/// encode/decode the structs and assert the JSON, no relay/daemon needed.
final class WorktreeWireTests: XCTestCase {

    private func decode(_ data: Data) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    // MARK: - Outbound requests (Frontend → Daemon, on __meta__)

    /// `worktree.list` is a bare `{ t }` — no fields. An extra key would not break
    /// the daemon (it ignores them) but the app must not invent fields.
    func testWorktreeListShape() {
        let obj = decode(try! JSONEncoder().encode(WorktreeList()))
        XCTAssertEqual(obj["t"] as? String, "worktree.list")
        XCTAssertEqual(obj.count, 1)
    }

    /// `worktree.create` with only a branch omits `baseBranch`/`path` entirely
    /// (custom `encodeIfPresent`) — the daemon derives both defaults when absent.
    /// Emitting `baseBranch: null` would be a different wire shape and is wrong.
    func testWorktreeCreateBranchOnly() {
        let msg = WorktreeCreate(branch: "feat/x", baseBranch: nil, path: nil)
        let obj = decode(try! JSONEncoder().encode(msg))
        XCTAssertEqual(obj["t"] as? String, "worktree.create")
        XCTAssertEqual(obj["branch"] as? String, "feat/x")
        // Optional fields absent — not present-as-null.
        XCTAssertEqual(obj.count, 2)
        XCTAssertFalse(obj.keys.contains("baseBranch"))
        XCTAssertFalse(obj.keys.contains("path"))
    }

    /// With a baseBranch supplied, the key is present and carries the value.
    func testWorktreeCreateWithBase() {
        let msg = WorktreeCreate(branch: "feat/x", baseBranch: "main", path: nil)
        let obj = decode(try! JSONEncoder().encode(msg))
        XCTAssertEqual(obj["branch"] as? String, "feat/x")
        XCTAssertEqual(obj["baseBranch"] as? String, "main")
        XCTAssertFalse(obj.keys.contains("path"))
        XCTAssertEqual(obj.count, 3)
    }

    /// `worktree.remove` with `force` omitted sends only `{ t, path }` — the
    /// daemon treats absent force as a non-forced removal.
    func testWorktreeRemoveDefault() {
        let msg = WorktreeRemove(path: "/repo/wt-1", force: nil)
        let obj = decode(try! JSONEncoder().encode(msg))
        XCTAssertEqual(obj["t"] as? String, "worktree.remove")
        XCTAssertEqual(obj["path"] as? String, "/repo/wt-1")
        XCTAssertFalse(obj.keys.contains("force"))
        XCTAssertEqual(obj.count, 2)
    }

    /// With `force: true`, the key is present and boolean.
    func testWorktreeRemoveForced() {
        let msg = WorktreeRemove(path: "/repo/wt-1", force: true)
        let obj = decode(try! JSONEncoder().encode(msg))
        XCTAssertEqual(obj["force"] as? Bool, true)
        XCTAssertEqual(obj.count, 3)
    }

    // MARK: - Inbound replies (Daemon → Frontend, on __control__)

    /// `worktree.list` reply decodes the full array, including a detached-HEAD
    /// worktree (`branch == nil`) and the main worktree (`isMain == true`).
    func testWorktreeListReplyDecode() throws {
        let json = """
            {"t":"worktree.list","d":[
              {"path":"/repo","branch":"main","head":"abc1234def","isMain":true},
              {"path":"/repo/wt-feat","branch":"feat/x","head":"99887766aa","isMain":false},
              {"path":"/repo/wt-det","branch":null,"head":"deadbeef00","isMain":false}
            ]}
            """
        let reply = try JSONDecoder().decode(WorktreeListReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.t, "worktree.list")
        XCTAssertEqual(reply.d.count, 3)
        XCTAssertEqual(reply.d[0].path, "/repo")
        XCTAssertEqual(reply.d[0].branch, "main")
        XCTAssertTrue(reply.d[0].isMain)
        XCTAssertEqual(reply.d[1].branch, "feat/x")
        XCTAssertFalse(reply.d[1].isMain)
        // Detached HEAD → branch nil, not a decode failure.
        XCTAssertNil(reply.d[2].branch)
        XCTAssertEqual(reply.d[2].head, "deadbeef00")
        // Identifiable id == path (stable for SwiftUI ForEach).
        XCTAssertEqual(reply.d[1].id, "/repo/wt-feat")
    }

    /// `worktree.created` reply carries the new worktree plus the auto-spawned
    /// session id. `sid` is optional on the decoder for forward-compat.
    func testWorktreeCreatedReplyDecode() throws {
        let json = """
            {"t":"worktree.created",
             "d":{"path":"/repo/wt-new","branch":"feat/new","head":"0011223344","isMain":false},
             "sid":"feat/new-abc36"}
            """
        let reply = try JSONDecoder().decode(WorktreeCreatedReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.t, "worktree.created")
        XCTAssertEqual(reply.d.path, "/repo/wt-new")
        XCTAssertEqual(reply.d.branch, "feat/new")
        XCTAssertFalse(reply.d.isMain)
        XCTAssertEqual(reply.sid, "feat/new-abc36")
    }

    /// `worktree.removed` reply is `{ t, path }`.
    func testWorktreeRemovedReplyDecode() throws {
        let json = """
            {"t":"worktree.removed","path":"/repo/wt-gone"}
            """
        let reply = try JSONDecoder().decode(WorktreeRemovedReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.t, "worktree.removed")
        XCTAssertEqual(reply.path, "/repo/wt-gone")
    }

    /// `err` reply with `NO_REPO` (the daemon is not in a git repo). `m` is the
    /// human-readable message surfaced into the worktree error banner.
    func testControlErrNoRepoDecode() throws {
        let json = """
            {"t":"err","e":"NO_REPO","m":"daemon is not running in a git repository"}
            """
        let reply = try JSONDecoder().decode(ControlErrInbound.self, from: Data(json.utf8))
        XCTAssertEqual(reply.e, "NO_REPO")
        XCTAssertEqual(reply.m, "daemon is not running in a git repository")
    }

    /// `err` with `m` absent decodes with `m == nil` — not a decode failure (the
    /// UI falls back to the code string).
    func testControlErrWithoutMessage() throws {
        let json = """
            {"t":"err","e":"WORKTREE_ERROR"}
            """
        let reply = try JSONDecoder().decode(ControlErrInbound.self, from: Data(json.utf8))
        XCTAssertEqual(reply.e, "WORKTREE_ERROR")
        XCTAssertNil(reply.m)
    }

    // MARK: - WorktreeStore reducer

    /// The store replaces the full list on `worktree.list`, upserts on `created`,
    /// and drops on `removed` — keyed independently per daemon.
    @MainActor
    func testWorktreeStoreReducer() {
        let store = WorktreeStore.shared
        let did = "test-daemon-\(UUID().uuidString)"
        let main = WorktreeInfo(path: "/repo", branch: "main", head: "aaa", isMain: true)
        let feat = WorktreeInfo(path: "/repo/wt-f", branch: "feat", head: "bbb", isMain: false)

        store.replaceList([main], for: did)
        XCTAssertEqual(store.worktrees(for: did).count, 1)

        store.upsert(feat, for: did)
        XCTAssertEqual(store.worktrees(for: did).count, 2)

        // Upsert with the same path replaces, does not duplicate.
        let featMoved = WorktreeInfo(path: "/repo/wt-f", branch: "feat2", head: "ccc", isMain: false)
        store.upsert(featMoved, for: did)
        XCTAssertEqual(store.worktrees(for: did).count, 2)
        XCTAssertEqual(
            store.worktrees(for: did).first { $0.path == "/repo/wt-f" }?.branch, "feat2")

        store.remove(path: "/repo/wt-f", for: did)
        XCTAssertEqual(store.worktrees(for: did).count, 1)
        XCTAssertEqual(store.worktrees(for: did).first?.path, "/repo")

        store.setError("nope", for: did)
        XCTAssertEqual(store.error(for: did), "nope")
        // A successful list clears the error.
        store.replaceList([main], for: did)
        XCTAssertNil(store.error(for: did))
    }
}
