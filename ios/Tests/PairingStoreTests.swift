import XCTest

@testable import Teleprompter

/// Unit tests for M1 pairing ingestion (ADR-0001 Phase 3).
///
/// Exercises `PairingStore` + `DeepLinkHandler` against an isolated
/// `UserDefaults` suite and a test-specific Keychain service so they neither
/// read nor clobber real install state. The deep link is produced via the same
/// Rust FFI path the daemon uses (`encodePairingData`), so a green test proves
/// decode→persist→load survives the full UniFFI boundary on the Simulator.
final class PairingStoreTests: XCTestCase {
    private let suiteName = "tp.tests.pairing"
    private let keychainService = "dev.tpmt.app.pairing.tests"
    private var defaults: UserDefaults!
    private var store: PairingStore!

    // Fixed, deterministic vectors (mirror TpCoreTests.testPairingRoundTrip).
    private let secret = Data(repeating: 0x01, count: 32)
    private let daemonPk = Data(repeating: 0x02, count: 32)

    override func setUpWithError() throws {
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        store = PairingStore(defaults: defaults, keychainService: keychainService)
        // Purge any Keychain residue (committed + pending) from a prior crashed run.
        store.remove(daemonId: "daemon-test")
        store.removePending(pairingId: "00000000-0000-4000-8000-0000000000aa")
    }

    override func tearDownWithError() throws {
        store.remove(daemonId: "daemon-test")
        store.removePending(pairingId: "00000000-0000-4000-8000-0000000000aa")
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// Deterministic QR v4 pairingId. `encodePairingData` always emits v4 and
    /// requires a valid 16-byte UUID here (an empty/derived id is only produced by
    /// DECODING a genuine v2/v3 bundle — not reachable through the encoder).
    private let testPairingId = "00000000-0000-4000-8000-0000000000aa"

    /// Build a real `tp://p?d=…` deep link via the Rust core, carrying the QR v4
    /// `pairingId`/`hostname` fields.
    private func makeDeepLink(
        did: String = "daemon-test", pairingId: String? = nil, hostname: String = "host-a"
    ) throws -> String {
        let data = FfiPairingData(
            ps: secret.base64EncodedString(),
            pk: daemonPk.base64EncodedString(),
            relay: "wss://relay.tpmt.dev",
            did: did,
            v: 4,
            pairingId: pairingId ?? testPairingId,
            hostname: hostname)
        return try encodePairingData(data: data)
    }

    /// The pairingId a default `makeDeepLink()` will ingest under.
    private func pairingIdFor(did: String) -> String { testPairingId }

    func testIngestPersistsToPendingNamespace() throws {
        let link = try makeDeepLink()
        let result = try store.ingest(deepLink: link)
        let pid = pairingIdFor(did: "daemon-test")
        XCTAssertEqual(result, .pending(pairingId: pid))

        // Lands in PENDING, NOT committed.
        XCTAssertEqual(store.pendingIds(), [pid])
        XCTAssertTrue(store.daemonIds().isEmpty)

        let p = try store.loadPending(pairingId: pid)
        XCTAssertEqual(p.daemonId, "daemon-test")
        XCTAssertEqual(p.relayURL, "wss://relay.tpmt.dev")
        XCTAssertEqual(p.version, 4)
        XCTAssertEqual(p.hostname, "host-a")
        XCTAssertEqual(p.pairingId, pid)
        // Secret + pubkey are decoded to raw 32-byte values, not left as base64.
        XCTAssertEqual(p.pairingSecret, secret)
        XCTAssertEqual(p.daemonPublicKey, daemonPk)
        XCTAssertFalse(p.frontendId.isEmpty)
    }

    func testPromoteMovesPendingToCommitted() throws {
        let link = try makeDeepLink(hostname: "host-b")
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: link)

        try store.promote(pairingId: pid)

        // Pending drained; committed populated.
        XCTAssertTrue(store.pendingIds().isEmpty)
        XCTAssertEqual(store.daemonIds(), ["daemon-test"])

        let committed = try store.load(daemonId: "daemon-test")
        XCTAssertEqual(committed.pairingSecret, secret)  // secret survived the move
        XCTAssertEqual(committed.pairingId, pid)  // pairingId persisted in committed meta
        XCTAssertEqual(committed.hostname, "host-b")  // hostname persisted too
        // The pending secret item is gone.
        XCTAssertThrowsError(try store.loadPending(pairingId: pid))
    }

    func testPromoteIsIdempotent() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        try store.promote(pairingId: pid)
        // Second promote (record already gone) must be a silent no-op, not a throw.
        XCTAssertNoThrow(try store.promote(pairingId: pid))
        XCTAssertEqual(store.daemonIds(), ["daemon-test"])
    }

    func testLoadPendingRoundTripsThroughKeychain() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        let loaded = try store.loadPending(pairingId: pid)
        // The secret really came back out of the (non-synced) pending Keychain item.
        XCTAssertEqual(loaded.pairingSecret, secret)
    }

    func testFrontendIdIsStableAcrossCalls() {
        let a = store.frontendId()
        let b = store.frontendId()
        XCTAssertEqual(a, b)
        XCTAssertFalse(a.isEmpty)
        // A fresh store over the same defaults sees the same id.
        let store2 = PairingStore(defaults: defaults, keychainService: keychainService)
        XCTAssertEqual(store2.frontendId(), a)
    }

    func testIngestIsIdempotentNoDuplicatePendingIndex() throws {
        let link = try makeDeepLink()
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: link)
        _ = try store.ingest(deepLink: link)
        XCTAssertEqual(store.pendingIds(), [pid])  // not duplicated
    }

    func testRemovePendingClearsEverything() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        store.removePending(pairingId: pid)
        XCTAssertTrue(store.pendingIds().isEmpty)
        XCTAssertThrowsError(try store.loadPending(pairingId: pid))
    }

    func testRemoveClearsCommittedEverything() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        try store.promote(pairingId: pid)
        store.remove(daemonId: "daemon-test")
        XCTAssertTrue(store.daemonIds().isEmpty)
        XCTAssertThrowsError(try store.load(daemonId: "daemon-test"))
    }

    func testDeepLinkHandlerPendsValidLink() throws {
        let link = try makeDeepLink()
        let pid = pairingIdFor(did: "daemon-test")
        let outcome = DeepLinkHandler.handle(URL(string: link)!, store: store)
        XCTAssertEqual(outcome, .pending(pairingId: pid))
    }

    func testDeepLinkHandlerIgnoresForeignScheme() {
        let outcome = DeepLinkHandler.handle(URL(string: "https://example.com")!, store: store)
        guard case .ignored = outcome else {
            return XCTFail("expected .ignored, got \(outcome)")
        }
    }

    func testDeepLinkHandlerFailsOnGarbage() {
        // Right scheme/host, but the payload is not a valid pairing bundle.
        let outcome = DeepLinkHandler.handle(URL(string: "tp://p?d=not-base64url!!")!, store: store)
        guard case .failed = outcome else {
            return XCTFail("expected .failed, got \(outcome)")
        }
    }

    func testMarkerConstantsAreStable() {
        // The harness greps these; changing them requires a scripts/ios.sh edit.
        XCTAssertEqual(DeepLinkHandler.pairPendingMarker, "TP_PAIR_PENDING")
        XCTAssertEqual(DeepLinkHandler.pairMarker, "TP_PAIR_OK")
        XCTAssertEqual(DeepLinkHandler.pairFailMarker, "TP_PAIR_FAIL")
    }

    func testPr5MarkerConstantsAreStable() {
        // The harness greps these too (§1.3 promotion decision markers).
        XCTAssertEqual(RelayClient.pairConfirmOkMarker, "TP_PAIR_CONFIRM_OK")
        XCTAssertEqual(RelayClient.pairConfirmFailMarker, "TP_PAIR_CONFIRM_FAIL")
    }

    // MARK: PR-5 — anti-downgrade floor (§1.3) + committed re-verify (§2.5)

    func testV4PairingInitializesFloorTo3() throws {
        // A QR v4 bundle proves the daemon is v≥3, so the pending record starts at
        // floor 3 — a pct-absent hello can never take the legacy branch.
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        XCTAssertEqual(store.floor(pairingId: pid, daemonId: "daemon-test", pending: true), 3)
        let pending = try store.loadPending(pairingId: pid)
        XCTAssertEqual(pending.minAdvertisedV, 3)
    }

    func testFloorSurvivesPromoteIntoCommittedMeta() throws {
        // The v4 pending floor (3) must carry into the committed meta so a relaunch
        // still refuses a downgraded (v=2) kx.
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        try store.promote(pairingId: pid)
        XCTAssertEqual(store.floor(pairingId: pid, daemonId: "daemon-test", pending: false), 3)
        let committed = try store.load(daemonId: "daemon-test")
        XCTAssertEqual(committed.minAdvertisedV, 3)
    }

    func testRaisePendingFloorIsMonotonic() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())  // starts at 3
        // A lower observed version is ignored (never lowered).
        store.raisePendingFloor(pairingId: pid, observedV: 2)
        XCTAssertEqual(store.floor(pairingId: pid, daemonId: "daemon-test", pending: true), 3)
        // A higher one raises it.
        store.raisePendingFloor(pairingId: pid, observedV: 5)
        XCTAssertEqual(store.floor(pairingId: pid, daemonId: "daemon-test", pending: true), 5)
    }

    func testRaiseCommittedFloorIsMonotonicAndSurvivesRepersist() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        try store.promote(pairingId: pid)  // committed floor = 3
        store.raiseCommittedFloor(daemonId: "daemon-test", observedV: 4)
        XCTAssertEqual(store.floor(pairingId: pid, daemonId: "daemon-test", pending: false), 4)
        // load reflects the raised value; a re-persist of that Pairing keeps 4.
        let loaded = try store.load(daemonId: "daemon-test")
        XCTAssertEqual(loaded.minAdvertisedV, 4)
    }

    func testRecordAndReadConfirmedPct() throws {
        let pid = pairingIdFor(did: "daemon-test")
        _ = try store.ingest(deepLink: try makeDeepLink())
        try store.promote(pairingId: pid)
        XCTAssertNil(store.lastConfirmedPct(daemonId: "daemon-test"))
        store.recordConfirmedPct(daemonId: "daemon-test", pctB64: "AAAA")
        XCTAssertEqual(store.lastConfirmedPct(daemonId: "daemon-test"), "AAAA")
    }

    func testFloorAbsentDefaultsToZero() {
        // A daemon/pairing with no record contributes no floor.
        XCTAssertEqual(
            store.floor(pairingId: "nope", daemonId: "daemon-missing", pending: true), 0)
        XCTAssertEqual(
            store.floor(pairingId: "nope", daemonId: "daemon-missing", pending: false), 0)
    }
}
