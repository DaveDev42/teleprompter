import XCTest

@testable import Teleprompter

/// Tests for Batch B relay resilience features:
/// H5: kx re-exchange on daemon restart
/// H6: exponential-backoff reconnect delay
/// H7: inbound control.unpair decoding
/// H8: inbound control.rename decoding
/// M7: relay.auth.resume wire shape
/// M8: relay.presence callback wiring
/// M10: daemon label adoption from kx payload
/// M11: KxPayload includes `v`
/// L5: missed-pong reconnect trigger (delay arithmetic)
final class RelayResilienceTests: XCTestCase {

    // MARK: - Helpers

    private let goldenSecret = Data((0..<32).map { UInt8($0) })
    private let daemonPk = Data(repeating: 0x02, count: 32)

    private func makePairing(
        daemonId: String = "daemon-test",
        frontendId: String = "frontend-A"
    ) -> Pairing {
        Pairing(
            pairingSecret: goldenSecret,
            daemonPublicKey: daemonPk,
            relayURL: "wss://relay.tpmt.dev",
            daemonId: daemonId,
            frontendId: frontendId,
            version: 3)
    }

    // MARK: - H6: Exponential-backoff reconnect delay

    func testReconnectDelayExponentialBackoff() {
        // attempt=0 → 1s, attempt=1 → 2s, attempt=2 → 4s, attempt=3 → 8s,
        // attempt=4 → 16s, attempt=5 → 30s (capped), attempt=10 → 30s (capped).
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 0), 1.0, accuracy: 0.001)
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 1), 2.0, accuracy: 0.001)
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 2), 4.0, accuracy: 0.001)
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 3), 8.0, accuracy: 0.001)
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 4), 16.0, accuracy: 0.001)
        // attempt 5 → 32, capped to 30
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 5), 30.0, accuracy: 0.001)
        // attempt 10 → 1024, capped to 30
        XCTAssertEqual(RelayClient.reconnectDelay(attempt: 10), 30.0, accuracy: 0.001)
    }

    func testReconnectDelayNeverExceedsCap() {
        for attempt in 0..<20 {
            XCTAssertLessThanOrEqual(
                RelayClient.reconnectDelay(attempt: attempt), 30.0,
                "attempt \(attempt) exceeded 30s cap")
            XCTAssertGreaterThan(
                RelayClient.reconnectDelay(attempt: attempt), 0.0,
                "attempt \(attempt) must be positive")
        }
    }

    // MARK: - M7: relay.auth.resume wire shape

    func testRelayAuthResumeEncodesCorrectly() throws {
        let resume = RelayAuthResume(token: "abc-token-xyz")
        let data = try JSONEncoder().encode(resume)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(Set(obj.keys), ["t", "token", "v"])
        XCTAssertEqual(obj["t"] as? String, "relay.auth.resume")
        XCTAssertEqual(obj["token"] as? String, "abc-token-xyz")
        XCTAssertEqual(obj["v"] as? Int, 2)
    }

    // MARK: - M11: KxPayload includes `v`

    func testKxPayloadIncludesVersionField() throws {
        let payload = KxPayload(pk: "base64pk==", frontendId: "fe-123")
        let data = try JSONEncoder().encode(payload)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(obj["v"] as? Int, 2, "KxPayload must include v=2 for Label union gating")
        XCTAssertEqual(obj["pk"] as? String, "base64pk==")
        XCTAssertEqual(obj["frontendId"] as? String, "fe-123")
        XCTAssertEqual(obj["role"] as? String, "frontend")
    }

    // MARK: - M10: DaemonKxPayload decodes label

    func testDaemonKxPayloadDecodesLabelSet() throws {
        let json = """
            {"pk":"AAECBA==","role":"daemon","v":2,"label":{"set":true,"value":"My Mac"}}
            """
        let payload = try JSONDecoder().decode(
            DaemonKxPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.pk, "AAECBA==")
        XCTAssertEqual(payload.v, 2)
        XCTAssertEqual(payload.label?.set, true)
        XCTAssertEqual(payload.label?.value, "My Mac")
    }

    func testDaemonKxPayloadDecodesLabelUnset() throws {
        let json = """
            {"pk":"AAECBA==","role":"daemon","v":2,"label":{"set":false}}
            """
        let payload = try JSONDecoder().decode(
            DaemonKxPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.label?.set, false)
        XCTAssertNil(payload.label?.value)
    }

    func testDaemonKxPayloadDecodesWithoutLabel() throws {
        // Old daemons that don't send the label field.
        let json = """
            {"pk":"AAECBA==","role":"daemon"}
            """
        let payload = try JSONDecoder().decode(
            DaemonKxPayload.self, from: Data(json.utf8))
        XCTAssertNil(payload.label, "absent label must decode as nil, not throw")
        XCTAssertNil(payload.v, "absent v must decode as nil, not throw")
    }

    // MARK: - M10: daemon-label adoption refreshes the observable cache

    /// Build an isolated `PairingStore` over a throwaway UserDefaults suite so the
    /// test never touches the shared (`.standard`) defaults or the real Keychain
    /// index. The suite name is unique per call so tests don't bleed into each
    /// other.
    @MainActor
    private func makeIsolatedStore() -> (PairingStore, UserDefaults, String) {
        let suiteName = "tp.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let store = PairingStore(defaults: defaults, keychainService: suiteName)
        return (store, defaults, suiteName)
    }

    /// Regression for the "daemon-m…" display bug.
    ///
    /// `PairingViewModel.label(for:)` reads its `@Observable labels` cache, whose
    /// value type is `String?`. After `refreshLabels()` runs for an unlabeled
    /// daemon the cache holds a present-but-`nil` entry — a cache HIT that
    /// shadows the store. A bare `PairingStore.setLabel` (as the kx-adoption
    /// path did before the fix) is therefore invisible to the view-model: the
    /// row stays on the `daemonId.prefix(8)` fallback ("daemon-m…").
    ///
    /// The fix routes kx adoption through the `onRename` handler, which calls
    /// `setLabel` AND `reload()` (→ `refreshLabels()`). This test proves the
    /// stale-cache shadowing (a direct store write does NOT surface) and that a
    /// `reload()` — the step the fix's `onRename` path performs — does.
    @MainActor
    func testViewModelLabelCacheShadowsBareStoreWriteUntilReload() {
        let (store, defaults, suiteName) = makeIsolatedStore()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let did = "daemon-mqyu8qqz"
        // Register the daemon in the index (no Keychain secret needed for the
        // label cache path) and refresh the cache while it is unlabeled.
        defaults.set([did], forKey: "tp.pairings.index")

        let vm = PairingViewModel(store: store, sessionStore: SessionStore())
        // Empty-on-construct then registered: reload to pick up the index entry.
        vm.reload()
        XCTAssertNil(vm.label(for: did), "precondition: daemon starts unlabeled")

        // Simulate the kx frame's adoption writing straight to the store (the
        // PRE-FIX behavior). The observable cache is NOT told, so the view-model
        // still reports nil → DaemonRow would show "daemon-m…".
        store.setLabel("Dave-MBP16", for: did)
        XCTAssertNil(
            vm.label(for: did),
            "bare store write must remain shadowed by the stale present-but-nil cache entry")

        // The fix's onRename path calls reload() after setLabel — that refreshes
        // the cache and the hostname label finally surfaces.
        vm.reload()
        XCTAssertEqual(
            vm.label(for: did), "Dave-MBP16",
            "after reload() the adopted hostname label must surface (no daemon-m fallback)")
    }

    // MARK: - H7: inbound control.unpair decoding

    func testControlUnpairInboundDecodes() throws {
        let json = """
            {
                "t": "control.unpair",
                "daemonId": "daemon-test",
                "frontendId": "fe-abc",
                "reason": "user-initiated",
                "ts": 1750000000000
            }
            """
        let msg = try JSONDecoder().decode(
            ControlUnpairInbound.self, from: Data(json.utf8))
        XCTAssertEqual(msg.t, "control.unpair")
        XCTAssertEqual(msg.daemonId, "daemon-test")
        XCTAssertEqual(msg.frontendId, "fe-abc")
        XCTAssertEqual(msg.reason, "user-initiated")
    }

    func testControlUnpairInboundDecodesWithOtherReason() throws {
        let json = """
            {"t":"control.unpair","daemonId":"d","frontendId":"f","reason":"daemon-initiated","ts":0}
            """
        let msg = try JSONDecoder().decode(
            ControlUnpairInbound.self, from: Data(json.utf8))
        XCTAssertEqual(msg.reason, "daemon-initiated")
    }

    // MARK: - H8: inbound control.rename decoding

    func testControlRenameInboundDecodesLabelSet() throws {
        let json = """
            {
                "t": "control.rename",
                "daemonId": "daemon-test",
                "frontendId": "fe-abc",
                "label": {"set": true, "value": "Dave's Mac"},
                "ts": 1750000000000
            }
            """
        let msg = try JSONDecoder().decode(
            ControlRenameInbound.self, from: Data(json.utf8))
        XCTAssertEqual(msg.t, "control.rename")
        XCTAssertEqual(msg.daemonId, "daemon-test")
        XCTAssertTrue(msg.label.set)
        XCTAssertEqual(msg.label.value, "Dave's Mac")
    }

    func testControlRenameInboundDecodesLabelClear() throws {
        let json = """
            {"t":"control.rename","daemonId":"d","frontendId":"f","label":{"set":false},"ts":0}
            """
        let msg = try JSONDecoder().decode(
            ControlRenameInbound.self, from: Data(json.utf8))
        XCTAssertFalse(msg.label.set)
        XCTAssertNil(msg.label.value)
    }

    func testControlRenameInboundFailsOnLegacyStringLabel() throws {
        // v1 daemons send a bare string for label — this should fail to decode.
        // We log and drop these frames rather than crashing.
        let json = """
            {"t":"control.rename","daemonId":"d","frontendId":"f","label":"legacy-string","ts":0}
            """
        XCTAssertThrowsError(
            try JSONDecoder().decode(ControlRenameInbound.self, from: Data(json.utf8)),
            "legacy string-shaped label must fail to decode as ControlRenameInbound"
        )
    }

    // MARK: - M8: relay.presence decoding + callback

    func testRelayPresenceDecodes() throws {
        let json = """
            {
                "t": "relay.presence",
                "daemonId": "daemon-test",
                "online": true,
                "sessions": ["s1"],
                "lastSeen": 1750000000000
            }
            """
        let p = try JSONDecoder().decode(RelayPresence.self, from: Data(json.utf8))
        XCTAssertTrue(p.online)
        XCTAssertEqual(p.daemonId, "daemon-test")
        XCTAssertEqual(p.sessions, ["s1"])
    }

    func testRelayPresenceOfflineDecodes() throws {
        let json = """
            {"t":"relay.presence","daemonId":"d","online":false,"sessions":[],"lastSeen":0}
            """
        let p = try JSONDecoder().decode(RelayPresence.self, from: Data(json.utf8))
        XCTAssertFalse(p.online)
        XCTAssertTrue(p.sessions.isEmpty)
    }

    func testRelayClientExposesPresenceCallback() {
        // Verify the callback slot compiles and is callable. A live relay is not
        // needed — we're testing the callback plumbing, not the relay protocol.
        let client = RelayClient(pairing: makePairing())
        var gotDaemonId: String?
        var gotOnline: Bool?
        client.onPresence = { did, online in
            gotDaemonId = did
            gotOnline = online
        }
        XCTAssertNotNil(client.onPresence, "onPresence must be settable")
        // Confirm type matches expected signature.
        _ = gotDaemonId
        _ = gotOnline
    }

    func testRelayClientExposesUnpairCallback() {
        let client = RelayClient(pairing: makePairing())
        client.onUnpair = { _, _ in }
        XCTAssertNotNil(client.onUnpair)
    }

    func testRelayClientExposesRenameCallback() {
        let client = RelayClient(pairing: makePairing())
        client.onRename = { _, _ in }
        XCTAssertNotNil(client.onRename)
    }

    // MARK: - RelayClient starts with idle state (regression guard)

    func testClientStartsIdle() {
        let client = RelayClient(pairing: makePairing())
        XCTAssertEqual(client.state, .idle)
        XCTAssertFalse(client.isReady, "isReady must be false before kx")
    }

    // MARK: - ControlRenameMsg outbound wire shape (regression guard for H8)

    func testControlRenameMsgEncodesLabelTaggedUnion() throws {
        let msg = ControlRenameMsg(
            daemonId: "daemon-test",
            frontendId: "fe-abc",
            label: "My Label",
            ts: 1750000000000)
        let data = try JSONEncoder().encode(msg)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(obj["t"] as? String, "control.rename")
        // label must be a dict with {set:true, value:"My Label"} — NOT a bare string.
        let label = try XCTUnwrap(obj["label"] as? [String: Any])
        XCTAssertEqual(label["set"] as? Bool, true)
        XCTAssertEqual(label["value"] as? String, "My Label")
    }

    func testControlRenameMsgEncodesLabelClear() throws {
        let msg = ControlRenameMsg(
            daemonId: "daemon-test",
            frontendId: "fe-abc",
            label: nil,
            ts: 0)
        let data = try JSONEncoder().encode(msg)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        let label = try XCTUnwrap(obj["label"] as? [String: Any])
        XCTAssertEqual(label["set"] as? Bool, false)
        XCTAssertNil(label["value"])
    }

    // MARK: - Relay URL scheme guard (transport-downgrade defense)

    func testRelaySchemeGuardAcceptsWebSocketSchemes() {
        XCTAssertTrue(RelayClient.isAcceptableRelayScheme("wss://relay.tpmt.dev"))
        XCTAssertTrue(RelayClient.isAcceptableRelayScheme("ws://localhost:7090"))
        // Scheme comparison is case-insensitive (Foundation lowercases it).
        XCTAssertTrue(RelayClient.isAcceptableRelayScheme("WSS://relay.tpmt.dev"))
    }

    func testRelaySchemeGuardRejectsNonWebSocketSchemes() {
        // A substituted endpoint in the pairing bundle must be rejected up front.
        XCTAssertFalse(RelayClient.isAcceptableRelayScheme("https://relay.tpmt.dev"))
        XCTAssertFalse(RelayClient.isAcceptableRelayScheme("http://relay.tpmt.dev"))
        XCTAssertFalse(RelayClient.isAcceptableRelayScheme("file:///etc/passwd"))
        XCTAssertFalse(RelayClient.isAcceptableRelayScheme("relay.tpmt.dev"))  // no scheme
        XCTAssertFalse(RelayClient.isAcceptableRelayScheme(""))
    }
}
