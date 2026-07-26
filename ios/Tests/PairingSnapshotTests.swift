import XCTest

@testable import Teleprompter

/// Tests for the WatchConnectivity companion mirror: `PairingStore.committedSnapshot`
/// (producer, phone side) and `PairingStore.applyPeerSnapshot` (consumer, watch side),
/// plus the watch status-row state machine.
///
/// **Why these matter disproportionately.** No test target compiles the watch app
/// (`TeleprompterTests` is `[iOS, macOS]`) and watchOS has no `XCUIApplication`, so
/// nothing about the watch is reachable by UI test. Everything below the `WCSession`
/// boundary was deliberately placed in files the phone target compiles precisely so
/// it could be covered here — this file is the only automated gate the feature has.
///
/// The load-bearing invariant throughout: **the watch must never issue a Keychain
/// delete.** `PairingRecordStore.remove` deletes with `kSecAttrSynchronizableAny`
/// against `synchronizable: true` items, and the watch shares the phone's
/// keychain-access-group — so a delete here could propagate and destroy the
/// operator's pairing on the phone. Several tests assert `removeCount == 0` for
/// exactly that reason.
final class PairingSnapshotTests: XCTestCase {
    private let suiteName = "tp.tests.pairingsnapshot"
    private var defaults: UserDefaults!
    private var records: SnapshotFakeRecordStore!
    private var store: PairingStore!

    override func setUpWithError() throws {
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        records = SnapshotFakeRecordStore()
        store = PairingStore(
            defaults: defaults, keychainService: "dev.tpmt.app.pairing.snapshot.tests",
            records: records)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    // MARK: - Helpers

    private func blob(
        did: String, pairingId: String, ts: Int, relay: String = "wss://relay.tpmt.dev"
    ) -> PairingBlob {
        PairingBlob(
            ps: Data(repeating: 0x01, count: 32).base64EncodedString(),
            pk: Data(repeating: 0x02, count: 32).base64EncodedString(),
            relay: relay, did: did, v: 4, pairingId: pairingId, hostname: "host-\(did)", ts: ts)
    }

    private func snapshot(_ blobs: [PairingBlob], floors: [String: Int] = [:]) -> PairingSnapshot {
        PairingSnapshot(pairings: blobs, floors: floors)
    }

    // MARK: - Adopt

    func testAdoptedBlobKeepsSnapshotTimestamp() {
        let result = store.applyPeerSnapshot(snapshot([blob(did: "d1", pairingId: "p1", ts: 1234)]))
        guard case .applied(let adopted, _, _, _) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(adopted, 1)
        // Re-stamping would let this copy out-rank the phone's own record in the
        // latest-ts-wins sweep. The blob must land byte-identical.
        XCTAssertEqual(records.blobs["p1"]?.ts, 1234)
        XCTAssertEqual(store.daemonIds(), ["d1"])
    }

    func testApplyIsIdempotent() {
        let snap = snapshot([blob(did: "d1", pairingId: "p1", ts: 1000)], floors: ["d1": 3])
        _ = store.applyPeerSnapshot(snap)
        let savesAfterFirst = records.saveCount
        let result = store.applyPeerSnapshot(snap)
        guard case .applied(let adopted, _, let hidden, _) = result else {
            return XCTFail("\(result)")
        }
        XCTAssertEqual(adopted, 0, "a repeat of the same snapshot must write nothing")
        XCTAssertEqual(hidden, 0)
        XCTAssertEqual(records.saveCount, savesAfterFirst)
        XCTAssertEqual(records.removeCount, 0)
        XCTAssertEqual(store.daemonIds(), ["d1"])
        XCTAssertEqual(store.floor(pairingId: "p1", daemonId: "d1", pending: false), 3)
    }

    /// The single most important test here. Adopting an older blob for a daemon we
    /// already hold a newer one for would leave two same-`did` blobs on disk — and
    /// the very next `daemonIds()` would run `reconciledPointers`'s ts-loser sweep,
    /// whose `records.remove` is a **synced** delete of the blob we just adopted,
    /// i.e. of the phone's live record. Refusing to delete inside `applyPeerSnapshot`
    /// is not enough; it must never create the condition.
    func testSkipsAdoptWhenLocalSameDidBlobIsNewer() {
        records.seed(blob(did: "d1", pairingId: "p-new", ts: 2000))
        let result = store.applyPeerSnapshot(snapshot([blob(did: "d1", pairingId: "p-old", ts: 1000)]))
        guard case .applied(let adopted, let skipped, _, _) = result else {
            return XCTFail("\(result)")
        }
        XCTAssertEqual(adopted, 0)
        XCTAssertEqual(skipped, 1)
        XCTAssertEqual(records.saveCount, 0)
        XCTAssertEqual(records.removeCount, 0, "the watch must never issue a synced delete")
        XCTAssertNil(records.blobs["p-old"])
        XCTAssertNotNil(records.blobs["p-new"])
    }

    /// The inverse direction: the phone re-paired, so its blob is genuinely newer.
    /// We adopt it, but tombstone the superseded local blob rather than deleting it —
    /// `reconciledPointers` filters hidden blobs out before computing ts-losers, so a
    /// tombstoned orphan can never be swept (and therefore never synced-deleted).
    func testSupersededBlobIsTombstonedNotDeleted() throws {
        records.seed(blob(did: "d1", pairingId: "p-old", ts: 1000))
        _ = store.applyPeerSnapshot(snapshot([blob(did: "d1", pairingId: "p-new", ts: 2000)]))
        XCTAssertEqual(records.removeCount, 0, "the watch must never issue a synced delete")
        XCTAssertNotNil(records.blobs["p-old"], "superseded blob stays on disk")
        XCTAssertTrue(store.hiddenPairingIds().contains("p-old"))
        XCTAssertEqual(store.daemonIds(), ["d1"])
        XCTAssertEqual(try store.load(daemonId: "d1").pairingId, "p-new")
    }

    // MARK: - Revocation

    func testRevocationHidesAndNeverDeletes() {
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        records.seed(blob(did: "d2", pairingId: "p2", ts: 1000))
        XCTAssertEqual(Set(store.daemonIds()), ["d1", "d2"])

        let result = store.applyPeerSnapshot(snapshot([blob(did: "d1", pairingId: "p1", ts: 1000)]))
        guard case .applied(_, _, let hidden, _) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(hidden, 1)
        XCTAssertEqual(store.daemonIds(), ["d1"])
        XCTAssertTrue(store.hiddenPairingIds().contains("p2"))
        // The credential itself survives — the phone stays the sole revoker.
        XCTAssertNotNil(records.blobs["p2"])
        XCTAssertEqual(records.removeCount, 0)
    }

    func testExplicitEmptySnapshotHidesEverything() {
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        let result = store.applyPeerSnapshot(snapshot([]))
        guard case .applied(_, _, let hidden, _) = result else { return XCTFail("\(result)") }
        XCTAssertEqual(hidden, 1)
        XCTAssertTrue(store.daemonIds().isEmpty)
        XCTAssertEqual(records.removeCount, 0)
    }

    /// A daemon that was revoked and later re-added arrives byte-identical to the
    /// copy still on disk, so the adopt path short-circuits. The un-hide must
    /// therefore run for every daemon in the snapshot, not only for ones whose blob
    /// needed a write — otherwise the daemon stays tombstoned and invisible forever.
    func testReAddedDaemonIsUnhidden() {
        let b = blob(did: "d1", pairingId: "p1", ts: 1000)
        records.seed(b)
        _ = store.applyPeerSnapshot(snapshot([]))
        XCTAssertTrue(store.daemonIds().isEmpty)

        _ = store.applyPeerSnapshot(snapshot([b]))
        XCTAssertEqual(store.daemonIds(), ["d1"])
        XCTAssertFalse(store.hiddenPairingIds().contains("p1"))
        XCTAssertEqual(records.removeCount, 0)
    }

    // MARK: - Floor (§1.3 anti-downgrade)

    func testFloorIsSeededOnFirstAdoptWithNoSidecar() {
        // The case `raiseCommittedFloor` cannot serve: it guards on an existing
        // sidecar dict, so it silently no-ops for a freshly-adopted daemon.
        _ = store.applyPeerSnapshot(
            snapshot([blob(did: "d1", pairingId: "p1", ts: 1000)], floors: ["d1": 3]))
        XCTAssertEqual(store.floor(pairingId: "p1", daemonId: "d1", pending: false), 3)
    }

    func testFloorNeverLowers() {
        let b = blob(did: "d1", pairingId: "p1", ts: 1000)
        _ = store.applyPeerSnapshot(snapshot([b], floors: ["d1": 3]))
        // A sender advertising a lower floor — buggy, stale, or hostile — must not
        // be able to reopen the downgrade window.
        _ = store.applyPeerSnapshot(snapshot([b], floors: ["d1": 0]))
        XCTAssertEqual(store.floor(pairingId: "p1", daemonId: "d1", pending: false), 3)
        // Nor may omitting the floor entirely clear it.
        _ = store.applyPeerSnapshot(snapshot([b]))
        XCTAssertEqual(store.floor(pairingId: "p1", daemonId: "d1", pending: false), 3)
    }

    func testFloorRaises() {
        let b = blob(did: "d1", pairingId: "p1", ts: 1000)
        _ = store.applyPeerSnapshot(snapshot([b], floors: ["d1": 0]))
        _ = store.applyPeerSnapshot(snapshot([b], floors: ["d1": 3]))
        XCTAssertEqual(store.floor(pairingId: "p1", daemonId: "d1", pending: false), 3)
    }

    // MARK: - Refusals (each must mutate nothing)

    func testLockedKeychainDefersWithoutMutation() {
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        records.failMode = .locked
        let result = store.applyPeerSnapshot(snapshot([blob(did: "d2", pairingId: "p2", ts: 1000)]))
        XCTAssertEqual(result, .deferredLocked)
        // A locked enumeration is not "zero local pairings" — treating it as such
        // would make every daemon look absent and hide the operator's whole list.
        XCTAssertEqual(records.saveCount, 0)
        XCTAssertEqual(records.removeCount, 0)
        XCTAssertTrue(store.hiddenPairingIds().isEmpty)
    }

    func testUnsupportedSchemaIsInert() throws {
        let json = #"{"schemaVersion":99,"pairings":[],"floors":{}}"#
        let future = try JSONDecoder().decode(PairingSnapshot.self, from: Data(json.utf8))
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        let result = store.applyPeerSnapshot(future)
        XCTAssertEqual(result, .unsupportedSchema(99))
        XCTAssertEqual(records.saveCount, 0)
        XCTAssertEqual(records.removeCount, 0)
        XCTAssertTrue(store.hiddenPairingIds().isEmpty, "must not revoke on a schema it cannot read")
    }

    // MARK: - Producer (phone side)

    func testCommittedSnapshotExcludesLocallyHidden() {
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        records.seed(blob(did: "d2", pairingId: "p2", ts: 1000))
        _ = store.daemonIds()  // materialise pointers so hideLocally can resolve d2
        store.hideLocally(daemonId: "d2")

        let snap = store.committedSnapshot()
        XCTAssertEqual(snap?.pairings.map(\.did), ["d1"])
        XCTAssertEqual(snap?.schemaVersion, PairingSnapshot.currentSchemaVersion)
    }

    func testCommittedSnapshotIsNilWhenKeychainUnavailable() {
        records.seed(blob(did: "d1", pairingId: "p1", ts: 1000))
        records.failMode = .locked
        // Publishing an empty set from a locked keychain would tell the watch every
        // pairing had been revoked — so there must be no snapshot to publish at all.
        XCTAssertNil(store.committedSnapshot())
    }

    func testCommittedSnapshotKeepsOnlyNewestBlobPerDaemon() {
        records.seed(blob(did: "d1", pairingId: "p-old", ts: 1000))
        records.seed(blob(did: "d1", pairingId: "p-new", ts: 2000))
        let snap = store.committedSnapshot()
        XCTAssertEqual(snap?.pairings.count, 1)
        XCTAssertEqual(snap?.pairings.first?.pairingId, "p-new")
    }

    func testSnapshotRoundTripsByteIdentically() throws {
        let original = snapshot(
            [blob(did: "d1", pairingId: "p1", ts: 1000), blob(did: "d2", pairingId: "p2", ts: 2000)],
            floors: ["d1": 3])
        let decoded = try JSONDecoder().decode(
            PairingSnapshot.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
    }

    // MARK: - Watch status-row state machine

    func testDeriveConnectionState() {
        XCTAssertEqual(
            WatchConnectionState.derive(daemonIds: [], pendingCount: 0, isReady: { _ in false }),
            .noPairings)
        // Known but not yet handshaken — the state the WC path spends its first
        // seconds in, and the one a Connected/Offline binary could not express.
        XCTAssertEqual(
            WatchConnectionState.derive(daemonIds: ["d1"], pendingCount: 0, isReady: { _ in false }),
            .connecting)
        XCTAssertEqual(
            WatchConnectionState.derive(daemonIds: [], pendingCount: 1, isReady: { _ in false }),
            .connecting)
        XCTAssertEqual(
            WatchConnectionState.derive(daemonIds: ["d1"], pendingCount: 0, isReady: { _ in true }),
            .connected)
        // One ready among several is enough.
        XCTAssertEqual(
            WatchConnectionState.derive(
                daemonIds: ["d1", "d2"], pendingCount: 0, isReady: { $0 == "d2" }),
            .connected)
    }
}

// MARK: - Test double

/// In-memory `PairingRecordStore` that counts deletes, so "the watch never issues a
/// synced delete" is an assertable property rather than a claim.
private final class SnapshotFakeRecordStore: PairingRecordStore, @unchecked Sendable {
    enum FailMode { case none, locked }
    var blobs: [String: PairingBlob] = [:]  // keyed by pairingId, as the Keychain is
    var failMode: FailMode = .none
    var saveCount = 0
    var removeCount = 0

    func loadAll() throws -> [PairingBlob] {
        switch failMode {
        case .locked: throw RecordStoreError.locked(errSecInteractionNotAllowed)
        case .none: return Array(blobs.values)
        }
    }

    func save(_ blob: PairingBlob) throws {
        saveCount += 1
        blobs[blob.pairingId] = blob
    }

    func remove(pairingId: String) {
        removeCount += 1
        blobs.removeValue(forKey: pairingId)
    }

    /// Seed directly (bypassing `save`) — models a blob that arrived out of band.
    func seed(_ blob: PairingBlob) { blobs[blob.pairingId] = blob }
}
