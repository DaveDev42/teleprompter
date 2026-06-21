import XCTest

@testable import Teleprompter

/// Unit tests for the `session.stop` / `session.delete` control-message wire
/// shapes (Task #93, M1/M2). Byte-exactness matters — the daemon parses by exact
/// `t` literal and key in `parseRelayControlMessage`
/// (`packages/protocol/src/relay-guard.ts` cases "session.stop" / "session.delete",
/// both validated by `isString(raw["sid"])`). Offline: encode the structs and
/// assert the JSON, no relay needed.
final class SessionOpsEncodeTests: XCTestCase {
    private let sid = "sess-smoketest"

    private func decode(_ data: Data) -> [String: String] {
        let obj = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        return obj.mapValues { "\($0)" }
    }

    /// `session.stop` carries the exact `t` literal and the sid — two fields only.
    func testSessionStopShape() {
        let data = try! JSONEncoder().encode(SessionStop(sid: sid))
        let obj = decode(data)
        XCTAssertEqual(obj["t"], "session.stop")
        XCTAssertEqual(obj["sid"], sid)
        XCTAssertEqual(obj.count, 2)
    }

    /// `session.delete` carries the exact `t` literal and the sid — two fields only.
    func testSessionDeleteShape() {
        let data = try! JSONEncoder().encode(SessionDelete(sid: sid))
        let obj = decode(data)
        XCTAssertEqual(obj["t"], "session.delete")
        XCTAssertEqual(obj["sid"], sid)
        XCTAssertEqual(obj.count, 2)
    }
}
