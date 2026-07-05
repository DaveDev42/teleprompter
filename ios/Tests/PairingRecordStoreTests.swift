import XCTest

@testable import Teleprompter

/// PR-6 (design §3.2 "Option A") tests for the committed-record persistence
/// substrate: the `PairingRecordStore` seam, the daemonId→pairingId pointer index
/// with Keychain reconciliation, re-pair orphan sweeping, legacy migration, and
/// the enumeration cache-preservation rules (§3.6 cond 2). These use an in-memory
/// `PairingRecordStore` double injected via the designated initializer, so they
/// exercise the store's logic without touching the real Keychain or depending on
/// iCloud (which no CI environment has — the 2-device sync itself is a manual
/// ship-gate, design §3.7).
final class PairingRecordStoreTests: XCTestCase {
    private let suiteName = "tp.tests.recordstore"
    private var defaults: UserDefaults!
    private var records: FakeRecordStore!
    private var store: PairingStore!

    private let secret = Data(repeating: 0x01, count: 32)
    private let daemonPk = Data(repeating: 0x02, count: 32)

    override func setUpWithError() throws {
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        records = FakeRecordStore()
        store = PairingStore(
            defaults: defaults, keychainService: "dev.tpmt.app.pairing.tests", records: records)
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func makeDeepLink(
        did: String, pairingId: String, hostname: String = "host-a"
    ) throws -> String {
        let data = FfiPairingData(
            ps: secret.base64EncodedString(), pk: daemonPk.base64EncodedString(),
            relay: "wss://relay.tpmt.dev", did: did, v: 4,
            pairingId: pairingId, hostname: hostname)
        return try encodePairingData(data: data)
    }

    private func ingestAndPromote(did: String, pairingId: String, hostname: String = "host-a")
        throws
    {
        _ = try store.ingest(
            deepLink: makeDeepLink(did: did, pairingId: pairingId, hostname: hostname))
        try store.promote(pairingId: pairingId)
    }

    private let pidA = "00000000-0000-4000-8000-0000000000a1"
    private let pidB = "00000000-0000-4000-8000-0000000000b2"

    // MARK: blob round-trip

    func testPromoteWritesBlobAndLoadReadsItBack() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA, hostname: "host-x")
        // The blob really landed in the record store, keyed by pairingId.
        XCTAssertEqual(records.blobs.count, 1)
        let blob = try XCTUnwrap(records.blobs[pidA])
        XCTAssertEqual(blob.did, "daemon-1")
        XCTAssertEqual(blob.pairingId, pidA)
        XCTAssertEqual(blob.hostname, "host-x")
        XCTAssertEqual(blob.ps, secret.base64EncodedString())

        let loaded = try store.load(daemonId: "daemon-1")
        XCTAssertEqual(loaded.pairingSecret, secret)
        XCTAssertEqual(loaded.daemonPublicKey, daemonPk)
        XCTAssertEqual(loaded.pairingId, pidA)
        XCTAssertEqual(loaded.hostname, "host-x")
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
    }

    // MARK: re-pair — ≤1 blob per did

    func testRepairReplacesSameDaemonBlobAndLoadsNewPairingId() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA, hostname: "old-host")
        // Re-pair the SAME daemon under a NEW pairingId (a fresh `tp pair new`).
        try ingestAndPromote(did: "daemon-1", pairingId: pidB, hostname: "new-host")

        // Exactly one blob survives for the daemon — the orphan is swept.
        XCTAssertEqual(records.blobs.count, 1)
        XCTAssertNil(records.blobs[pidA])
        XCTAssertNotNil(records.blobs[pidB])
        // daemonIds has ONE entry; load returns the NEW pairing.
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
        let loaded = try store.load(daemonId: "daemon-1")
        XCTAssertEqual(loaded.pairingId, pidB)
        XCTAssertEqual(loaded.hostname, "new-host")
    }

    // MARK: remove — blob + legacy secret + pointer + sidecar

    func testRemoveDeletesBlobPointerAndSidecar() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        store.raiseCommittedFloor(daemonId: "daemon-1", observedV: 5)  // write sidecar
        XCTAssertEqual(store.floor(pairingId: pidA, daemonId: "daemon-1", pending: false), 5)

        store.remove(daemonId: "daemon-1")

        XCTAssertTrue(records.blobs.isEmpty)  // blob gone
        XCTAssertTrue(store.daemonIds().isEmpty)  // pointer dropped
        XCTAssertThrowsError(try store.load(daemonId: "daemon-1"))
        // Sidecar floor cleared.
        XCTAssertEqual(store.floor(pairingId: pidA, daemonId: "daemon-1", pending: false), 0)
    }

    // MARK: two daemons — dedupe + stable order

    func testTwoDaemonsDistinctRowsStableOrder() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        try ingestAndPromote(did: "daemon-2", pairingId: pidB)
        XCTAssertEqual(Set(store.daemonIds()), ["daemon-1", "daemon-2"])
        // Insertion order preserved across reloads (SwiftUI row stability).
        XCTAssertEqual(store.daemonIds(), store.daemonIds())
        XCTAssertEqual(records.blobs.count, 2)
    }

    // MARK: enumeration cache-preservation (§3.6 cond 2)

    func testLockedEnumerationKeepsLastGoodDaemonIds() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])  // populates last-good
        // A subsequent locked keychain must NOT blank the list.
        records.failMode = .locked
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
        // And load still resolves via the pointer (surfacing the keychain error).
        records.failMode = .none
        XCTAssertEqual(try store.load(daemonId: "daemon-1").pairingId, pidA)
    }

    func testUncorroboratedEmptyDoesNotWipePopulatedPointer() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
        // Simulate an AfterFirstUnlock pre-first-unlock enumeration that returns an
        // (uncorroborated) empty set: the populated pointer index must survive.
        records.failMode = .empty
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
    }

    // MARK: migration (legacy split storage → Option A blob)

    func testMigratesLegacyCommittedRecordWithoutDeletingLegacySecret() throws {
        // A FRESH defaults suite: the migration done-flag (`tp.pairings.migrated.v2`)
        // is set by any store init, so `setUp`'s store would otherwise have already
        // flipped it on `self.defaults` and this migration would be skipped.
        let suite = "tp.tests.recordstore.migr"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        d.removePersistentDomain(forName: suite)
        defer { d.removePersistentDomain(forName: suite) }

        // Seed a legacy committed record the OLD way: a UserDefaults meta dict +
        // daemonIndex entry, and a Keychain secret keyed by daemonId.
        let legacy = LegacySeeder(defaults: d, keychainService: "dev.tpmt.app.pairing.tests.migr")
        legacy.seedCommitted(
            did: "daemon-legacy", pairingId: pidA, secret: secret, pk: daemonPk,
            relay: "wss://relay.tpmt.dev", v: 3, hostname: "legacy-host", floor: 3)

        // A store over that seeded suite + base service migrates on init.
        let migRecords = FakeRecordStore()
        let migrated = PairingStore(
            defaults: d, keychainService: "dev.tpmt.app.pairing.tests.migr", records: migRecords)

        // The blob now exists and loads.
        XCTAssertEqual(migRecords.blobs.count, 1)
        let loaded = try migrated.load(daemonId: "daemon-legacy")
        XCTAssertEqual(loaded.pairingSecret, secret)
        XCTAssertEqual(loaded.pairingId, pidA)
        XCTAssertEqual(loaded.hostname, "legacy-host")
        XCTAssertEqual(loaded.minAdvertisedV, 3)  // sidecar floor preserved
        // The legacy synced secret is UNTOUCHED (a synced delete would unpair peers).
        XCTAssertNotNil(legacy.readCommittedSecret(did: "daemon-legacy"))
    }

    func testMigrationIsOneShotIdempotent() throws {
        let suite = "tp.tests.recordstore.idem"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        d.removePersistentDomain(forName: suite)
        defer { d.removePersistentDomain(forName: suite) }

        let legacy = LegacySeeder(defaults: d, keychainService: "dev.tpmt.app.pairing.tests.idem")
        legacy.seedCommitted(
            did: "daemon-legacy", pairingId: pidA, secret: secret, pk: daemonPk,
            relay: "wss://relay.tpmt.dev", v: 3, hostname: "", floor: 0)

        let r1 = FakeRecordStore()
        _ = PairingStore(
            defaults: d, keychainService: "dev.tpmt.app.pairing.tests.idem", records: r1)
        XCTAssertEqual(r1.saveCount, 1)

        // A second store over the same defaults must NOT re-run migration (done-flag).
        let r2 = FakeRecordStore()
        _ = PairingStore(
            defaults: d, keychainService: "dev.tpmt.app.pairing.tests.idem", records: r2)
        XCTAssertEqual(r2.saveCount, 0)
    }

    // MARK: persist durability — save-before-sweep (review HIGH, PairingStore.swift:270)

    /// A re-pair whose `save` fails mid-flight must NOT delete the prior committed
    /// blob: the old pairing has to survive intact (no permanently-stuck phantom row
    /// where the pointer names a pairingId whose blob was already swept).
    func testSaveFailureLeavesPriorBlobIntact() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA, hostname: "old-host")
        XCTAssertEqual(records.blobs.count, 1)

        // Re-pair to a NEW pairingId, but the save throws this time.
        records.failNextSave = true
        _ = try store.ingest(
            deepLink: makeDeepLink(did: "daemon-1", pairingId: pidB, hostname: "new"))
        XCTAssertThrowsError(try store.promote(pairingId: pidB))

        // The OLD blob is untouched (save-before-sweep means the sweep never ran),
        // and the daemon still loads to the original pairing — not a phantom.
        XCTAssertEqual(records.blobs.count, 1)
        XCTAssertNotNil(records.blobs[pidA])
        XCTAssertNil(records.blobs[pidB])
        XCTAssertEqual(try store.load(daemonId: "daemon-1").pairingId, pidA)
    }

    // MARK: partial-sync — per-daemon transient absence (review HIGH, PairingStore.swift:442)

    /// A non-empty enumeration that is missing ONE daemon's blob (its delete synced
    /// before its replacement add, mid-iCloud-sync) must NOT prune that daemon's
    /// pointer — the whole-empty cache-preservation rule generalizes per-did.
    func testPartialEnumerationPreservesAbsentDaemonPointer() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        try ingestAndPromote(did: "daemon-2", pairingId: pidB)
        XCTAssertEqual(Set(store.daemonIds()), ["daemon-1", "daemon-2"])

        // daemon-1's blob is transiently absent while daemon-2's is present.
        records.hiddenDids = ["daemon-1"]
        // Both daemons still surface — daemon-1's pointer is preserved, not pruned.
        XCTAssertEqual(Set(store.daemonIds()), ["daemon-1", "daemon-2"])

        // Once daemon-1's blob is visible again, load resolves it unchanged.
        records.hiddenDids = []
        XCTAssertEqual(try store.load(daemonId: "daemon-1").pairingId, pidA)
    }

    // MARK: concurrent re-pair — ts-loser sweep (review HIGH, PairingStore.swift:416)

    /// Two blobs for one daemon (concurrent re-pair from two devices, each minting
    /// its own pairingId) converge to the latest-`ts` blob AND the older orphan is
    /// swept out of the Keychain, restoring the ≤1-blob-per-did invariant.
    func testConcurrentRepairSweepsLosingOrphanBlob() throws {
        // Seed two co-resident same-did blobs directly (as iCloud merge would land).
        records.seed(makeBlob(did: "daemon-1", pairingId: pidA, ts: 1000))
        records.seed(makeBlob(did: "daemon-1", pairingId: pidB, ts: 2000))  // newer
        XCTAssertEqual(records.blobs.count, 2)

        // Reconciliation (via daemonIds) picks the newer and sweeps the older.
        XCTAssertEqual(store.daemonIds(), ["daemon-1"])
        XCTAssertEqual(records.blobs.count, 1)
        XCTAssertNil(records.blobs[pidA])  // older orphan swept
        XCTAssertNotNil(records.blobs[pidB])
        XCTAssertEqual(try store.load(daemonId: "daemon-1").pairingId, pidB)
    }

    // MARK: peer-synced arrival — blob present, pointer absent (review LOW, :448)

    /// A blob that arrives out-of-band (iCloud sync from a peer that paired a NEW
    /// daemon) with no local pointer entry is picked up as an arrival on the next
    /// reconciliation and appears in `daemonIds`.
    func testPeerSyncedArrivalAppearsInDaemonIds() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        // A peer paired daemon-2; only its blob synced here (no local promote).
        records.seed(makeBlob(did: "daemon-2", pairingId: pidB, ts: 3000))
        XCTAssertEqual(Set(store.daemonIds()), ["daemon-1", "daemon-2"])
        XCTAssertEqual(try store.load(daemonId: "daemon-2").pairingId, pidB)
    }

    // MARK: unpair — legacy synced secret revoked (review HIGH, :93)

    /// `remove(daemonId:)` (unpair) MUST delete the legacy synced secret (revocation
    /// propagates to peers) — distinct from migration, which must never delete it.
    func testRemoveDeletesLegacySecret() throws {
        let seeder = LegacySeeder(defaults: defaults, keychainService: "dev.tpmt.app.pairing.tests")
        seeder.seedCommitted(
            did: "daemon-1", pairingId: pidA, secret: secret, pk: daemonPk,
            relay: "wss://relay.tpmt.dev", v: 3, hostname: "h", floor: 0)
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        XCTAssertNotNil(seeder.readCommittedSecret(did: "daemon-1"))  // present before

        store.remove(daemonId: "daemon-1")

        // Legacy secret is revoked (unlike migration, which preserves it for peers).
        XCTAssertNil(seeder.readCommittedSecret(did: "daemon-1"))
        XCTAssertTrue(records.blobs.isEmpty)
        XCTAssertTrue(store.daemonIds().isEmpty)
    }

    // MARK: smoke wipe — clears all committed state (review MEDIUM)

    /// `wipeAllCommittedForSmoke()` clears every blob + pointer + any orphan not in
    /// the pointer map, so a smoke re-run never boot-reconnects a stale committed
    /// client (the frame-decrypt regression this method exists to prevent).
    func testWipeAllCommittedForSmokeClearsEverything() throws {
        try ingestAndPromote(did: "daemon-1", pairingId: pidA)
        try ingestAndPromote(did: "daemon-2", pairingId: pidB)
        // An orphan blob NOT reflected in the pointer map (belt-and-suspenders path).
        records.seed(
            makeBlob(did: "daemon-3", pairingId: "00000000-0000-4000-8000-0000000000c3", ts: 1))

        store.wipeAllCommittedForSmoke()

        XCTAssertTrue(records.blobs.isEmpty)  // every blob gone, incl. the orphan
        XCTAssertTrue(store.daemonIds().isEmpty)  // pointer index cleared
    }

    // MARK: helpers

    private func makeBlob(did: String, pairingId: String, ts: Int) -> PairingBlob {
        PairingBlob(
            ps: secret.base64EncodedString(), pk: daemonPk.base64EncodedString(),
            relay: "wss://relay.tpmt.dev", did: did, v: 4,
            pairingId: pairingId, hostname: "host-a", ts: ts)
    }
}

// MARK: - Test doubles

/// In-memory `PairingRecordStore` with fault injection.
private final class FakeRecordStore: PairingRecordStore, @unchecked Sendable {
    enum FailMode { case none, locked, empty }
    var blobs: [String: PairingBlob] = [:]  // keyed by pairingId (as the Keychain would be)
    var failMode: FailMode = .none
    var saveCount = 0
    /// When true, the NEXT `save` throws (then resets) — simulates a transient
    /// SecItemAdd failure (device relock, disk pressure) for the persist-rollback path.
    var failNextSave = false
    /// dids to hide from `loadAll` (simulate a partial iCloud sync where one
    /// daemon's blob has not arrived yet while others are present).
    var hiddenDids: Set<String> = []

    func loadAll() throws -> [PairingBlob] {
        switch failMode {
        case .locked: throw RecordStoreError.locked(errSecInteractionNotAllowed)
        case .empty: return []
        case .none: return blobs.values.filter { !hiddenDids.contains($0.did) }
        }
    }

    func save(_ blob: PairingBlob) throws {
        if failNextSave {
            failNextSave = false
            throw RecordStoreError.keychain(errSecIO)
        }
        saveCount += 1
        blobs[blob.pairingId] = blob
    }

    func remove(pairingId: String) {
        blobs.removeValue(forKey: pairingId)
    }

    /// Seed a blob directly (bypasses `save`) — for out-of-band arrival / concurrent
    /// re-pair scenarios that iCloud sync would produce without a local `promote`.
    func seed(_ blob: PairingBlob) { blobs[blob.pairingId] = blob }
}

/// Writes a legacy split-storage committed record (UserDefaults meta + index +
/// a synchronizable Keychain secret keyed by daemonId) the way pre-PR-6 code did,
/// so the migration path has real legacy state to convert. Mirrors the exact
/// UserDefaults keys `PairingStore` migrates from.
private final class LegacySeeder {
    private let defaults: UserDefaults
    private let service: String
    init(defaults: UserDefaults, keychainService: String) {
        self.defaults = defaults
        self.service = keychainService
    }

    func seedCommitted(
        did: String, pairingId: String, secret: Data, pk: Data, relay: String, v: UInt8,
        hostname: String, floor: Int
    ) {
        // Legacy Keychain secret (synchronizable, keyed by daemonId).
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: did,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ] as CFDictionary)
        SecItemAdd(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: did,
                kSecAttrSynchronizable as String: kCFBooleanFalse!,
                kSecValueData as String: secret,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            ] as CFDictionary, nil)
        // Legacy meta dict + index.
        let meta: [String: String] = [
            "pk": pk.base64EncodedString(), "relay": relay, "did": did,
            "v": String(v), "pairingId": pairingId, "hostname": hostname, "floor": String(floor),
        ]
        defaults.set(meta, forKey: "tp.pairing.\(did).meta")
        var index = defaults.stringArray(forKey: "tp.pairings.index") ?? []
        if !index.contains(did) { index.append(did) }
        defaults.set(index, forKey: "tp.pairings.index")
    }

    func readCommittedSecret(did: String) -> Data? {
        var out: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: did,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
            ] as CFDictionary, &out)
        return status == errSecSuccess ? out as? Data : nil
    }
}
