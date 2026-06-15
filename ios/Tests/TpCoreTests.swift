import XCTest
@testable import Teleprompter

/// FFI tests for the Rust core (`tp-core`) exercised through the app target.
/// Proves the UniFFI bindings link and behave on the iOS Simulator runtime —
/// the Swift-side counterpart to the Rust golden-vector tests
/// (`rust/tp-core/tests/wire_vectors.rs`).
final class TpCoreTests: XCTestCase {
    func testVersionIsLinked() {
        XCTAssertFalse(tpCoreVersion().isEmpty, "tp-core FFI not linked")
    }

    func testFullRoundTripSucceeds() throws {
        // The same end-to-end check ContentView runs on appear; here we assert
        // it does not throw and returns a non-empty version.
        let version = try TpCoreCheck.roundTrip()
        XCTAssertFalse(version.isEmpty)
        XCTAssertTrue(TpCoreCheck.summary().hasPrefix("TP_CORE_OK"))
    }

    func testCodecFrameRoundTrip() throws {
        let json = Data(#"{"k":"io","n":42}"#.utf8)
        let bin = Data([9, 8, 7])
        let frame = encodeFrame(json: json, binary: bin)
        let frames = try decodeFrames(chunk: frame)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].json, json)
        XCTAssertEqual(frames[0].binary, bin)
    }

    func testAeadTamperFails() throws {
        let key = Data(repeating: 0x33, count: 32)
        let nonce = Data(repeating: 0x44, count: 24)
        let sealed = try seal(plaintext: Data("x".utf8), key: key, nonce: nonce)
        // Flip a character in the base64 to corrupt the ciphertext/tag.
        var bytes = Array(sealed.utf8)
        bytes[bytes.count - 2] = bytes[bytes.count - 2] == 65 ? 66 : 65 // 'A'<->'B'
        let tampered = String(decoding: bytes, as: UTF8.self)
        XCTAssertThrowsError(try open(encoded: tampered, key: key)) { err in
            // UniFFI maps Rust TpError::Crypto to a Swift TpError case.
            XCTAssertTrue("\(err)".lowercased().contains("crypto"))
        }
    }

    func testKxCrossover() throws {
        let d = try kxSeedKeypair(seed: Data(repeating: 0xAA, count: 32))
        let f = try kxSeedKeypair(seed: Data(repeating: 0xBB, count: 32))
        let dk = try kxServerSessionKeys(pk: d.publicKey, sk: d.secretKey, peerPk: f.publicKey)
        let fk = try kxClientSessionKeys(pk: f.publicKey, sk: f.secretKey, peerPk: d.publicKey)
        XCTAssertEqual(dk.rx, fk.tx)
        XCTAssertEqual(dk.tx, fk.rx)
    }

    func testPairingRoundTrip() throws {
        let data = FfiPairingData(
            ps: Data(repeating: 0x01, count: 32).base64EncodedString(),
            pk: Data(repeating: 0x02, count: 32).base64EncodedString(),
            relay: "wss://relay.tpmt.dev",
            did: "daemon-test",
            v: 3)
        let url = try encodePairingData(data: data)
        XCTAssertTrue(url.hasPrefix("tp://p?d="))
        let back = try decodePairingData(raw: url)
        XCTAssertEqual(back.did, "daemon-test")
        XCTAssertEqual(back.relay, "wss://relay.tpmt.dev")
        XCTAssertEqual(back.ps, data.ps)
    }
}
