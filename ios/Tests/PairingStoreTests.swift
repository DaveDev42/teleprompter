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
    private let keychainService = "dev.tpmt.teleprompter.pairing.tests"
    private var defaults: UserDefaults!
    private var store: PairingStore!

    // Fixed, deterministic vectors (mirror TpCoreTests.testPairingRoundTrip).
    private let secret = Data(repeating: 0x01, count: 32)
    private let daemonPk = Data(repeating: 0x02, count: 32)

    override func setUpWithError() throws {
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        store = PairingStore(defaults: defaults, keychainService: keychainService)
        // Purge any Keychain residue from a prior crashed run.
        store.remove(daemonId: "daemon-test")
    }

    override func tearDownWithError() throws {
        store.remove(daemonId: "daemon-test")
        defaults.removePersistentDomain(forName: suiteName)
    }

    /// Build a real `tp://p?d=…` deep link via the Rust core.
    private func makeDeepLink(did: String = "daemon-test") throws -> String {
        let data = FfiPairingData(
            ps: secret.base64EncodedString(),
            pk: daemonPk.base64EncodedString(),
            relay: "wss://relay.tpmt.dev",
            did: did,
            v: 3)
        return try encodePairingData(data: data)
    }

    func testIngestDecodesAndPersists() throws {
        let link = try makeDeepLink()
        let p = try store.ingest(deepLink: link)

        XCTAssertEqual(p.daemonId, "daemon-test")
        XCTAssertEqual(p.relayURL, "wss://relay.tpmt.dev")
        XCTAssertEqual(p.version, 3)
        // Secret + pubkey are decoded to raw 32-byte values, not left as base64.
        XCTAssertEqual(p.pairingSecret, secret)
        XCTAssertEqual(p.pairingSecret.count, 32)
        XCTAssertEqual(p.daemonPublicKey, daemonPk)
        XCTAssertEqual(p.daemonPublicKey.count, 32)
        XCTAssertFalse(p.frontendId.isEmpty)

        // Index updated.
        XCTAssertEqual(store.daemonIds(), ["daemon-test"])
    }

    func testLoadRoundTripsThroughKeychain() throws {
        let link = try makeDeepLink()
        let ingested = try store.ingest(deepLink: link)
        let loaded = try store.load(daemonId: "daemon-test")
        XCTAssertEqual(loaded, ingested)
        // The secret really came back out of the Keychain.
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

    func testIngestIsIdempotentNoDuplicateIndex() throws {
        let link = try makeDeepLink()
        _ = try store.ingest(deepLink: link)
        _ = try store.ingest(deepLink: link)
        XCTAssertEqual(store.daemonIds(), ["daemon-test"]) // not duplicated
    }

    func testRemoveClearsEverything() throws {
        _ = try store.ingest(deepLink: try makeDeepLink())
        store.remove(daemonId: "daemon-test")
        XCTAssertTrue(store.daemonIds().isEmpty)
        XCTAssertThrowsError(try store.load(daemonId: "daemon-test"))
    }

    func testDeepLinkHandlerPairsValidLink() throws {
        let link = try makeDeepLink()
        let outcome = DeepLinkHandler.handle(URL(string: link)!, store: store)
        XCTAssertEqual(outcome, .paired(daemonId: "daemon-test"))
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
        XCTAssertEqual(DeepLinkHandler.pairMarker, "TP_PAIR_OK")
        XCTAssertEqual(DeepLinkHandler.pairFailMarker, "TP_PAIR_FAIL")
    }
}
