import XCTest
@testable import Teleprompter

/// Unit tests for the H3 ghost-row fix and H4 pending-placeholder fix in
/// `SessionStore`. No relay or Simulator needed — these are pure store-logic
/// guards for the per-daemon replace behaviour.
///
/// H3: a session absent from a new `hello` must disappear from `sessions`.
/// H4: `pending-*` placeholders must be stripped after a `replaceSessionsForDaemon` call.
@MainActor
final class SessionStoreGhostRowTests: XCTestCase {

    private let daemonA = "daemon-a"
    private let daemonB = "daemon-b"

    /// `SessionStore.init()` hydrates from the shared `UserDefaults.standard`
    /// key `tp.sessions.v1`, and every mutating method persists back to it. In a
    /// single test process this leaks state across tests (the count asserts then
    /// see residue from a prior test). Clear the key before and after each test so
    /// every `SessionStore()` starts from an empty persisted list.
    // `nonisolated`: an immutable String constant, read from `setUp`/`tearDown`,
    // which are nonisolated overrides of XCTestCase under Swift 6 (the @MainActor
    // class annotation does not extend to those base-class overrides).
    nonisolated private static let persistKey = "tp.sessions.v1"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
        super.tearDown()
    }

    /// Helper: make a minimal `SessionMeta`.
    private func meta(sid: String, state: String = "stopped") -> SessionMeta {
        let now = Date().timeIntervalSince1970 * 1000
        return SessionMeta(sid: sid, state: state, cwd: "/tmp/\(sid)",
                           createdAt: now, updatedAt: now, lastSeq: 0)
    }

    // MARK: - H3: ghost-row removal

    /// After a second hello that omits a session that was in the first hello,
    /// the session must no longer appear in `sessions`.
    func testGhostRowRemovedOnReplace() async {
        let store = SessionStore()

        // First hello: sessions s1 and s2.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [
            meta(sid: "s1"), meta(sid: "s2"),
        ])
        XCTAssertEqual(store.sessions.count, 2)
        XCTAssertNotNil(store.sessions["s1"])
        XCTAssertNotNil(store.sessions["s2"])

        // Second hello: only s1 (s2 was deleted on daemon side).
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [
            meta(sid: "s1"),
        ])
        XCTAssertEqual(store.sessions.count, 1, "s2 should be removed — ghost row fix")
        XCTAssertNotNil(store.sessions["s1"])
        XCTAssertNil(store.sessions["s2"], "s2 was not in hello → must be gone")
    }

    /// An empty hello (all sessions deleted on daemon) must wipe that daemon's slice.
    func testEmptyHelloClearsAllSessionsForDaemon() {
        let store = SessionStore()

        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [
            meta(sid: "s1"), meta(sid: "s2"),
        ])
        XCTAssertEqual(store.sessions.count, 2)

        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [])
        XCTAssertEqual(store.sessions.count, 0, "empty hello must clear all sessions")
    }

    /// Sessions from a SECOND daemon must NOT be removed when the first daemon
    /// sends a new hello.
    func testMultiDaemonBucketsAreIsolated() {
        let store = SessionStore()

        // Daemon A has s1; daemon B has s2.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [meta(sid: "s1")])
        store.replaceSessionsForDaemon(daemonId: daemonB, sessions: [meta(sid: "s2")])
        XCTAssertEqual(store.sessions.count, 2)

        // Daemon A refreshes with empty list.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [])

        // Daemon B's session must survive.
        XCTAssertNil(store.sessions["s1"], "daemon-A session must be gone")
        XCTAssertNotNil(store.sessions["s2"], "daemon-B session must survive")
        XCTAssertEqual(store.sessions.count, 1)
    }

    /// A daemon that reconnects and sends an overlapping hello (same sid, updated
    /// metadata) must update the metadata in place.
    func testHelloUpdatesExistingSessionMetadata() {
        let store = SessionStore()

        let original = meta(sid: "s1", state: "stopped")
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [original])
        XCTAssertEqual(store.sessions["s1"]?.state, "stopped")

        // New hello: same sid but now running.
        let now = Date().timeIntervalSince1970 * 1000
        let updated = SessionMeta(sid: "s1", state: "running", cwd: "/tmp/s1",
                                  createdAt: now, updatedAt: now, lastSeq: 5)
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [updated])

        XCTAssertEqual(store.sessions["s1"]?.state, "running", "metadata must update")
        XCTAssertEqual(store.sessions["s1"]?.lastSeq, 5)
    }

    // MARK: - H4: pending-placeholder stripping

    /// `pending-*` entries inserted via `upsertSessions` must be removed after
    /// a `replaceSessionsForDaemon` call (simulates the daemon's hello arriving
    /// after a create request).
    func testPendingPlaceholderIsStrippedOnHello() {
        let store = SessionStore()

        // Simulate a (legacy) optimistic add via upsertSessions.
        let pending = meta(sid: "pending-abc12345")
        store.upsertSessions([pending])
        XCTAssertNotNil(store.sessions["pending-abc12345"], "placeholder must exist before hello")

        // Daemon's hello arrives with the real session.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [meta(sid: "real-sid-1")])

        XCTAssertNil(store.sessions["pending-abc12345"],
                     "pending placeholder must be stripped after hello")
        XCTAssertNotNil(store.sessions["real-sid-1"], "real session from hello must be present")
    }

    /// Multiple pending-* entries must all be stripped.
    func testMultiplePendingPlaceholdersAreStripped() {
        let store = SessionStore()

        store.upsertSessions([
            meta(sid: "pending-aaa"),
            meta(sid: "pending-bbb"),
            meta(sid: "real-existing"),
        ])
        XCTAssertEqual(store.sessions.count, 3)

        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [
            meta(sid: "real-existing"),
            meta(sid: "real-new"),
        ])

        XCTAssertNil(store.sessions["pending-aaa"], "pending-aaa must be gone")
        XCTAssertNil(store.sessions["pending-bbb"], "pending-bbb must be gone")
        XCTAssertNotNil(store.sessions["real-existing"])
        XCTAssertNotNil(store.sessions["real-new"])
        XCTAssertEqual(store.sessions.count, 2)
    }

    // MARK: - Backward compatibility: upsertSessions / appendState still work

    /// `upsertSessions` still merges (for `state` frame updates) without breaking
    /// the sessions dict.
    func testUpsertSessionsStillMerges() {
        let store = SessionStore()

        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [meta(sid: "s1")])
        // A state-frame update via upsertSessions.
        let now = Date().timeIntervalSince1970 * 1000
        let updated = SessionMeta(sid: "s1", state: "running", cwd: "/tmp/s1",
                                  createdAt: now, updatedAt: now, lastSeq: 7)
        store.upsertSessions([updated])

        XCTAssertEqual(store.sessions["s1"]?.state, "running")
        XCTAssertEqual(store.sessions["s1"]?.lastSeq, 7)
    }

    // MARK: - H3 regression: removeSession must purge daemon buckets

    /// Regression test for the ghost-row-via-delete path.
    ///
    /// Scenario: two daemons are connected. A session owned by daemon A is
    /// deleted locally via `removeSession`. Daemon B then sends a periodic hello
    /// (unchanged). `replaceSessionsForDaemon` for daemon B must NOT re-insert
    /// the deleted sid from daemon A's stale bucket.
    func testRemoveSessionDoesNotGhostOnSubsequentHello() {
        let store = SessionStore()

        // Daemon A has s1; daemon B has s2.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [meta(sid: "s1")])
        store.replaceSessionsForDaemon(daemonId: daemonB, sessions: [meta(sid: "s2")])
        XCTAssertEqual(store.sessions.count, 2)

        // User deletes s1 (owned by daemon A) locally.
        store.removeSession("s1")
        XCTAssertNil(store.sessions["s1"], "s1 must be removed immediately")
        XCTAssertEqual(store.sessions.count, 1)

        // Daemon B sends a periodic hello with its unchanged session list.
        store.replaceSessionsForDaemon(daemonId: daemonB, sessions: [meta(sid: "s2")])

        // s1 must NOT reappear — the stale daemon-A bucket should have been cleared.
        XCTAssertNil(store.sessions["s1"],
                     "deleted s1 must not ghost-row after an unrelated daemon's hello")
        XCTAssertNotNil(store.sessions["s2"], "daemon-B s2 must survive")
        XCTAssertEqual(store.sessions.count, 1)
    }

    /// Same ghost-row regression via `removeSessions` (batch delete path).
    func testRemoveSessionsBatchDoesNotGhostOnSubsequentHello() {
        let store = SessionStore()

        // Daemon A has s1 and s3; daemon B has s2.
        store.replaceSessionsForDaemon(daemonId: daemonA, sessions: [
            meta(sid: "s1"), meta(sid: "s3"),
        ])
        store.replaceSessionsForDaemon(daemonId: daemonB, sessions: [meta(sid: "s2")])
        XCTAssertEqual(store.sessions.count, 3)

        // User batch-deletes s1 and s3.
        store.removeSessions(["s1", "s3"])
        XCTAssertNil(store.sessions["s1"])
        XCTAssertNil(store.sessions["s3"])
        XCTAssertEqual(store.sessions.count, 1)

        // Daemon B sends a periodic hello.
        store.replaceSessionsForDaemon(daemonId: daemonB, sessions: [meta(sid: "s2")])

        // Neither s1 nor s3 must reappear.
        XCTAssertNil(store.sessions["s1"],
                     "batch-deleted s1 must not ghost after unrelated hello")
        XCTAssertNil(store.sessions["s3"],
                     "batch-deleted s3 must not ghost after unrelated hello")
        XCTAssertNotNil(store.sessions["s2"])
        XCTAssertEqual(store.sessions.count, 1)
    }
}
