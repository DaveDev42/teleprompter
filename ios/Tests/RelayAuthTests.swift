import XCTest

@testable import Teleprompter

/// Unit tests for M2 relay connect + frontend auth (ADR-0001 Phase 3).
///
/// The relay validates `relay.auth` by exact key + a `validTokens.get(token)`
/// lookup, so the wire shape and the token bytes must match the TS side exactly.
/// These tests assert (a) the encoded `relay.auth` is byte-for-byte the six-field
/// literal the live tests send (`unpair-e2e.test.ts:78-86`,
/// `multi-frontend.test.ts:79-88`), (b) the token equals the cross-stack golden
/// from `wire-vectors.json` (proving the Swift FFI `deriveRelayToken` matches the
/// relay's expectation), and (c) the server replies decode. No relay is needed —
/// this is the offline contract guard the M2 plan specifies.
final class RelayAuthTests: XCTestCase {
    // The golden vector secret (`wire-vectors.json` kdf.pairingSecret_hex):
    // 32 incrementing bytes 0x00..0x1f → relayToken a16760de…4e7aa5c9.
    private let goldenSecret = Data((0..<32).map { UInt8($0) })
    private let goldenRelayToken =
        "a16760de00195ffd72a318d567eca9c2ee0fa7003e7e87cfec03538c4e7aa5c9"
    private let daemonPk = Data(repeating: 0x02, count: 32)

    private func makePairing(
        daemonId: String = "daemon-test",
        frontendId: String = "frontend-A",
        relay: String = "wss://relay.tpmt.dev"
    ) -> Pairing {
        Pairing(
            pairingSecret: goldenSecret,
            daemonPublicKey: daemonPk,
            relayURL: relay,
            daemonId: daemonId,
            frontendId: frontendId,
            version: 3,
            pairingId: "pairing-test",
            hostname: "",
            minAdvertisedV: 0)
    }

    // MARK: token parity

    /// The FFI token used in `relay.auth` is the lowercase-hex
    /// BLAKE2b-256(secret || "relay-auth") — byte-equal to the relay's golden.
    func testRelayTokenMatchesCrossStackGolden() {
        let token = deriveRelayToken(pairingSecret: goldenSecret)
        XCTAssertEqual(token, goldenRelayToken)
        XCTAssertEqual(token.count, 64)
        XCTAssertEqual(token, token.lowercased())
        XCTAssertTrue(token.allSatisfy { $0.isHexDigit })
    }

    // MARK: relay.auth wire shape

    /// The encoded `relay.auth` is exactly the six-field object the live frontend
    /// tests send. Decode-and-compare (field order in JSON is not significant to
    /// the relay) against the verbatim literal.
    func testRelayAuthEncodesToTheSixFieldLiteral() throws {
        let auth = RelayAuth(
            daemonId: "daemon-multi",
            token: goldenRelayToken,
            frontendId: "frontend-A")
        let data = try JSONEncoder().encode(auth)
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        // Exactly these six keys — nothing extra leaks onto the wire.
        XCTAssertEqual(Set(obj.keys), ["t", "v", "role", "daemonId", "token", "frontendId"])
        XCTAssertEqual(obj["t"] as? String, "relay.auth")
        XCTAssertEqual(obj["v"] as? Int, 2)
        XCTAssertEqual(obj["role"] as? String, "frontend")
        XCTAssertEqual(obj["daemonId"] as? String, "daemon-multi")
        XCTAssertEqual(obj["token"] as? String, goldenRelayToken)
        XCTAssertEqual(obj["frontendId"] as? String, "frontend-A")
    }

    /// `v` is the integer 2 (not a string) — the wire guard requires a number.
    func testProtocolVersionIsIntegerTwo() throws {
        XCTAssertEqual(RelayProtocol.version, 2)
        let data = try JSONEncoder().encode(
            RelayAuth(
                daemonId: "d", token: "t", frontendId: "f"))
        let json = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(json.contains("\"v\":2"), "v must serialize as a bare number, got: \(json)")
    }

    // MARK: server message decoding

    func testAuthOkDecodesWithResumeFields() throws {
        let json = """
            {"t":"relay.auth.ok","daemonId":"daemon-test","resumeToken":"rt-abc","resumeExpiresAt":1750000000000,"resumed":false}
            """
        let ok = try JSONDecoder().decode(RelayAuthOk.self, from: Data(json.utf8))
        XCTAssertEqual(ok.t, "relay.auth.ok")
        XCTAssertEqual(ok.daemonId, "daemon-test")
        XCTAssertEqual(ok.resumeToken, "rt-abc")
        XCTAssertEqual(ok.resumeExpiresAt, 1_750_000_000_000)
        XCTAssertEqual(ok.resumed, false)
    }

    /// `resumeToken`/`resumeExpiresAt`/`resumed` are optional — a minimal auth.ok decodes.
    func testAuthOkDecodesWithoutOptionalFields() throws {
        let json = #"{"t":"relay.auth.ok","daemonId":"daemon-test"}"#
        let ok = try JSONDecoder().decode(RelayAuthOk.self, from: Data(json.utf8))
        XCTAssertEqual(ok.daemonId, "daemon-test")
        XCTAssertNil(ok.resumeToken)
        XCTAssertNil(ok.resumed)
    }

    func testAuthErrDecodes() throws {
        let json = #"{"t":"relay.auth.err","e":"Invalid token or daemon ID"}"#
        let err = try JSONDecoder().decode(RelayAuthErr.self, from: Data(json.utf8))
        XCTAssertEqual(err.t, "relay.auth.err")
        XCTAssertEqual(err.e, "Invalid token or daemon ID")
    }

    func testPresenceDecodes() throws {
        let json = """
            {"t":"relay.presence","daemonId":"daemon-test","online":true,"sessions":["s1","s2"],"lastSeen":1750000000000}
            """
        let p = try JSONDecoder().decode(RelayPresence.self, from: Data(json.utf8))
        XCTAssertTrue(p.online)
        XCTAssertEqual(p.sessions, ["s1", "s2"])
        XCTAssertEqual(p.daemonId, "daemon-test")
    }

    func testEnvelopeExtractsTagFromAnyMessage() throws {
        let json =
            #"{"t":"relay.presence","daemonId":"d","online":false,"sessions":[],"lastSeen":0}"#
        let env = try JSONDecoder().decode(RelayServerEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(env.t, "relay.presence")
    }

    // MARK: client lifecycle

    func testClientStartsIdle() {
        let client = RelayClient(pairing: makePairing())
        XCTAssertEqual(client.state, .idle)
        XCTAssertNil(client.resumeToken)
    }

    /// An invalid relay URL fails fast without opening a socket.
    func testConnectFailsOnInvalidURL() {
        let client = RelayClient(pairing: makePairing(relay: ""))
        client.connect()
        guard case .failed = client.state else {
            return XCTFail("expected .failed for empty relay URL, got \(client.state)")
        }
    }

    func testMarkerConstantsAreStable() {
        // scripts/ios.sh greps these verbatim — changing them is a wire break.
        XCTAssertEqual(RelayClient.authOkMarker, "TP_RELAY_AUTH_OK")
        XCTAssertEqual(RelayClient.authFailMarker, "TP_RELAY_AUTH_FAIL")
    }
}
