import XCTest

@testable import Teleprompter

/// Unit tests for the push wire messages (Task #94 / #99): the outbound
/// `relay.push.register` the app sends to register its APNs token, and the
/// inbound `relay.notification` the relay delivers in-band while the app is
/// connected. Byte-exactness matters — the relay parses by exact `t` literal +
/// camelCase keys (`rust/tp-proto/src/relay_client.rs RelayClientMessage::
/// PushRegister`, `packages/protocol/src/types/relay.ts`). Offline: encode/decode
/// the structs and assert the JSON, no relay needed.
final class PushRegisterEncodeTests: XCTestCase {

    private func decode(_ data: Data) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    // MARK: - relay.push.register (outbound)

    /// `relay.push.register` carries the exact `t` literal and the THREE camelCase
    /// keys the relay/daemon expect: `frontendId`, `token`, `platform`. A rename
    /// to snake_case (`frontend_id`) or any extra key silently breaks the wire
    /// (the Rust `req_string(obj, "frontendId")` parse fails → the message is
    /// dropped, token never registered).
    func testPushRegisterShape() {
        let msg = RelayPushRegister(
            frontendId: "fe-abc123", token: "deadbeefcafe", platform: "ios")
        let obj = decode(try! JSONEncoder().encode(msg))
        XCTAssertEqual(obj["t"] as? String, "relay.push.register")
        XCTAssertEqual(obj["frontendId"] as? String, "fe-abc123")
        XCTAssertEqual(obj["token"] as? String, "deadbeefcafe")
        XCTAssertEqual(obj["platform"] as? String, "ios")
        // Exactly four keys — no snake_case alias, no stray fields.
        XCTAssertEqual(obj.count, 4)
        XCTAssertNil(obj["frontend_id"], "must be camelCase frontendId, not snake_case")
    }

    /// The platform string is the lowercase form the Rust `Platform` enum
    /// serializes to (`#[serde(rename_all = "lowercase")]` → `"ios"`). The app
    /// only ever sends `"ios"` today (the sole APNs target).
    func testPushRegisterPlatformIsLowercaseIos() {
        let obj = decode(
            try! JSONEncoder().encode(
                RelayPushRegister(frontendId: "f", token: "t", platform: "ios")))
        XCTAssertEqual(obj["platform"] as? String, "ios")
    }

    // MARK: - relay.notification (inbound)

    /// A full `relay.notification` with a `data` routing payload decodes all
    /// fields, including the nested `{ sid, daemonId, event }`.
    func testNotificationDecodeWithData() throws {
        let json = """
            {"t":"relay.notification","title":"Claude finished",
             "body":"Session done","data":{"sid":"sess-1","daemonId":"d-1","event":"Stop"}}
            """
        let note = try JSONDecoder().decode(RelayNotification.self, from: Data(json.utf8))
        XCTAssertEqual(note.t, "relay.notification")
        XCTAssertEqual(note.title, "Claude finished")
        XCTAssertEqual(note.body, "Session done")
        XCTAssertEqual(note.data?.sid, "sess-1")
        XCTAssertEqual(note.data?.daemonId, "d-1")
        XCTAssertEqual(note.data?.event, "Stop")
    }

    /// `data` is optional: a notification with no routing payload (the field is
    /// absent on the wire) decodes with `data == nil` — not a decode failure.
    func testNotificationDecodeWithoutData() throws {
        let json = """
            {"t":"relay.notification","title":"Hi","body":"there"}
            """
        let note = try JSONDecoder().decode(RelayNotification.self, from: Data(json.utf8))
        XCTAssertEqual(note.title, "Hi")
        XCTAssertEqual(note.body, "there")
        XCTAssertNil(note.data)
    }

    /// A `data: null` on the wire (which the relay guard rejects on the TS side,
    /// but a defensive decoder must not crash on) decodes safely to `nil` rather
    /// than throwing — so a stray null never wedges the receive loop.
    func testNotificationDecodeWithNullData() throws {
        let json = """
            {"t":"relay.notification","title":"Hi","body":"there","data":null}
            """
        let note = try JSONDecoder().decode(RelayNotification.self, from: Data(json.utf8))
        XCTAssertEqual(note.title, "Hi")
        XCTAssertNil(note.data)
    }
}
