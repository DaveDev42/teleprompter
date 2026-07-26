import XCTest

@testable import Teleprompter

/// Unit tests for session pinning (iOS swipe-right) and the canonical ordering
/// it feeds. Pure store logic — no relay, no Simulator UI.
///
/// The ordering matters beyond the list itself: `SessionsTab.orderedSids`
/// (⌘[/⌘] stepping), `QuickSwitcherSheet` (⌘K) and `WatchRootView` all render
/// from `SessionStore.orderedSessions`, so a regression here silently desyncs
/// keyboard navigation from what the user sees.
@MainActor
final class SessionPinOrderTests: XCTestCase {

    /// `SessionStore.init()` hydrates from the shared `UserDefaults.standard`
    /// (sessions + pins), and every mutation persists back. Clear both keys
    /// around each test so a store always starts empty and nothing leaks into
    /// the other test classes that share the same suite.
    // `nonisolated`: immutable constants read from the nonisolated
    // `setUp`/`tearDown` overrides (the @MainActor class annotation does not
    // extend to those XCTestCase base-class overrides under Swift 6).
    nonisolated private static let persistKey = "tp.sessions.v1"
    nonisolated private static let pinnedKey = "tp.sessions.pinned.v1"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
        UserDefaults.standard.removeObject(forKey: Self.pinnedKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
        UserDefaults.standard.removeObject(forKey: Self.pinnedKey)
        super.tearDown()
    }

    /// Helper: a minimal `SessionMeta` with an explicit `updatedAt` so ordering
    /// assertions are deterministic.
    private func meta(
        sid: String,
        state: String = "stopped",
        updatedAt: Double
    ) -> SessionMeta {
        SessionMeta(
            sid: sid,
            state: state,
            cwd: "/tmp/\(sid)",
            createdAt: updatedAt,
            updatedAt: updatedAt,
            lastSeq: 0
        )
    }

    // MARK: - Ordering

    /// Baseline (no pins): running first, then `updatedAt` descending.
    func testOrderRunningFirstThenRecency() {
        let store = SessionStore()
        store.upsertSessions([
            meta(sid: "old-stopped", state: "stopped", updatedAt: 1_000),
            meta(sid: "new-stopped", state: "stopped", updatedAt: 3_000),
            meta(sid: "running", state: "running", updatedAt: 2_000),
        ])

        XCTAssertEqual(
            store.orderedSessions.map(\.sid),
            ["running", "new-stopped", "old-stopped"]
        )
    }

    /// A pin outranks "running": an explicit user intent must not be overridden
    /// by a session merely being alive.
    func testPinnedOutranksRunning() {
        let store = SessionStore()
        store.upsertSessions([
            meta(sid: "running", state: "running", updatedAt: 3_000),
            meta(sid: "stale", state: "stopped", updatedAt: 1_000),
        ])

        store.togglePin("stale")

        XCTAssertEqual(store.orderedSessions.map(\.sid), ["stale", "running"])
    }

    /// Within the pinned group the same running/recency rules still apply.
    func testPinnedGroupKeepsRunningThenRecencyOrder() {
        let store = SessionStore()
        store.upsertSessions([
            meta(sid: "pin-old", state: "stopped", updatedAt: 1_000),
            meta(sid: "pin-new", state: "stopped", updatedAt: 2_000),
            meta(sid: "pin-running", state: "running", updatedAt: 500),
            meta(sid: "loose-running", state: "running", updatedAt: 9_000),
        ])

        for sid in ["pin-old", "pin-new", "pin-running"] { store.setPinned(true, for: sid) }

        XCTAssertEqual(
            store.orderedSessions.map(\.sid),
            ["pin-running", "pin-new", "pin-old", "loose-running"]
        )
    }

    /// Equal timestamps fall back to the sid so rows never jitter between
    /// renders (a `Dictionary.values` sequence has no inherent order).
    func testEqualTimestampsBreakTieOnSidDeterministically() {
        let store = SessionStore()
        store.upsertSessions([
            meta(sid: "ccc", updatedAt: 1_000),
            meta(sid: "aaa", updatedAt: 1_000),
            meta(sid: "bbb", updatedAt: 1_000),
        ])

        XCTAssertEqual(store.orderedSessions.map(\.sid), ["aaa", "bbb", "ccc"])
        // Same store, second read — identical order.
        XCTAssertEqual(store.orderedSessions.map(\.sid), ["aaa", "bbb", "ccc"])
    }

    // MARK: - Pin state

    func testTogglePinFlipsAndPersistsAcrossStores() {
        let store = SessionStore()
        store.upsertSessions([meta(sid: "s1", updatedAt: 1_000)])

        XCTAssertFalse(store.isPinned("s1"))
        store.togglePin("s1")
        XCTAssertTrue(store.isPinned("s1"))
        XCTAssertEqual(store.pinnedSids, ["s1"])

        // A fresh store (app relaunch) must hydrate the pin from UserDefaults.
        XCTAssertTrue(SessionStore().isPinned("s1"))

        store.togglePin("s1")
        XCTAssertFalse(store.isPinned("s1"))
        XCTAssertFalse(SessionStore().isPinned("s1"))
    }

    /// `setPinned` is idempotent — repeating the same state is a no-op, not a
    /// toggle (the swipe action and any future menu item share this entry point).
    func testSetPinnedIsIdempotent() {
        let store = SessionStore()
        store.setPinned(true, for: "s1")
        store.setPinned(true, for: "s1")
        XCTAssertEqual(store.pinnedSids, ["s1"])

        store.setPinned(false, for: "s1")
        store.setPinned(false, for: "s1")
        XCTAssertTrue(store.pinnedSids.isEmpty)
    }

    /// Deleting a session drops its pin (a pin for a sid that can never come
    /// back would be unreachable state), and the drop survives relaunch.
    func testDeletingSessionClearsItsPin() {
        let store = SessionStore()
        store.upsertSessions([
            meta(sid: "gone", updatedAt: 1_000),
            meta(sid: "kept", updatedAt: 2_000),
        ])
        store.setPinned(true, for: "gone")
        store.setPinned(true, for: "kept")

        store.removeSessions(["gone"])

        XCTAssertEqual(store.pinnedSids, ["kept"])
        XCTAssertEqual(SessionStore().pinnedSids, ["kept"])

        store.removeSession("kept")
        XCTAssertTrue(store.pinnedSids.isEmpty)
        XCTAssertTrue(SessionStore().pinnedSids.isEmpty)
    }

    /// A `hello` for one daemon replaces only that daemon's bucket, so it must
    /// NOT be treated as evidence that other daemons' pinned sessions are gone.
    func testHelloForOneDaemonKeepsPinsForOtherSessions() {
        let store = SessionStore()
        store.setPinned(true, for: "other-daemon-session")
        store.setPinned(true, for: "a1")

        store.replaceSessionsForDaemon(
            daemonId: "daemon-a",
            sessions: [meta(sid: "a1", updatedAt: 1_000)]
        )

        XCTAssertEqual(store.pinnedSids, ["a1", "other-daemon-session"])
    }
}
