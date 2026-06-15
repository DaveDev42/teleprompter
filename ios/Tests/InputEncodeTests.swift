import XCTest
@testable import Teleprompter

/// Unit tests for M5 input encoding (ADR-0001 Phase 3): the wire shape of the
/// `in.chat` / `in.term` frames the app seals and publishes. Byte-exactness
/// matters — the daemon parses by exact key and `t` literal
/// (`relay-client.ts:578-586`), and `in.chat`'s `d` is plain text (daemon adds
/// the newline) while `in.term`'s `d` is base64 of raw PTY bytes
/// (`session-proto.ts:46-56`, `runner.ts:186`). Offline: encode the structs and
/// assert the JSON, no relay needed.
final class InputEncodeTests: XCTestCase {
    private let sid = "sess-smoketest"

    private func decode(_ data: Data) -> [String: String] {
        let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        return obj.mapValues { "\($0)" }
    }

    /// `in.chat` carries the exact `t` literal and plain-text `d` (no newline —
    /// the daemon appends it). Three fields only.
    func testInChatShape() {
        let data = try! JSONEncoder().encode(SessionInChat(sid: sid, d: "hello"))
        let obj = decode(data)
        XCTAssertEqual(obj["t"], "in.chat")
        XCTAssertEqual(obj["sid"], sid)
        XCTAssertEqual(obj["d"], "hello") // plain text, no trailing \n
        XCTAssertEqual(obj.count, 3)
    }

    /// The app must NOT add its own newline to `in.chat` (the daemon does).
    func testInChatDoesNotAddNewline() {
        let data = try! JSONEncoder().encode(SessionInChat(sid: sid, d: "ls -la"))
        let obj = decode(data)
        XCTAssertEqual(obj["d"], "ls -la")
        XCTAssertFalse((obj["d"] ?? "").hasSuffix("\n"))
    }

    /// `in.term` carries the exact `t` literal; `d` is base64 of the raw bytes.
    func testInTermShapeIsBase64() {
        let raw = "echo hi\r"
        let d = Data(raw.utf8).base64EncodedString()
        let data = try! JSONEncoder().encode(SessionInTerm(sid: sid, d: d))
        let obj = decode(data)
        XCTAssertEqual(obj["t"], "in.term")
        XCTAssertEqual(obj["sid"], sid)
        XCTAssertEqual(obj["d"], d)
        // Round-trip: decoding the base64 yields the original raw bytes.
        XCTAssertEqual(Data(base64Encoded: obj["d"]!), Data(raw.utf8))
        XCTAssertEqual(obj.count, 3)
    }
}
