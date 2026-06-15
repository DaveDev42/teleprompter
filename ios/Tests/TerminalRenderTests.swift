import XCTest
@testable import Teleprompter

/// Unit tests for M5 terminal rendering (ADR-0001 Phase 3): how `SessionStore`
/// turns `k == "io"` records into the Terminal tab's byte stream. Mirrors
/// `ChatRenderTests` (the Chat-tab counterpart). The daemon always base64-encodes
/// io `d` (`command-dispatcher.ts:665`), so decode is unconditional; `io` must
/// land in `terminalOutput`, never in `chatItems` (Chat is hooks-only). Offline:
/// feed records straight into the store, no relay.
@MainActor
final class TerminalRenderTests: XCTestCase {
    private let sid = "sess-smoketest"

    /// Build an `io` record whose `d` is the base64 of `text` at the given `seq`.
    private func ioRec(_ text: String, seq: Int) -> SessionRec {
        SessionRec(
            t: "rec",
            sid: sid,
            seq: seq,
            k: "io",
            ns: "runner",
            n: nil,
            d: Data(text.utf8).base64EncodedString(),
            ts: 1_700_000_000_000,
        )
    }

    /// A single io record decodes its base64 `d` and lands in `terminalOutput`.
    func testIoRecAppendsDecodedBytes() {
        let store = SessionStore()
        store.appendRec(ioRec("hello world\n", seq: 1))
        XCTAssertEqual(store.terminalOutput[sid], "hello world\n")
        // io is NOT a chat item — Chat is hooks-only.
        XCTAssertNil(store.chatItems[sid])
    }

    /// Successive io records concatenate in seq order.
    func testIoRecsConcatenate() {
        let store = SessionStore()
        store.appendRec(ioRec("foo", seq: 1))
        store.appendRec(ioRec("bar", seq: 2))
        store.appendRec(ioRec("baz", seq: 3))
        XCTAssertEqual(store.terminalOutput[sid], "foobarbaz")
    }

    /// A replayed io record (seq ≤ cursor) is dropped — no double append. The
    /// relay's 10-frame cache plus an overlapping resume batch can replay; the
    /// cursor gate must keep the terminal idempotent.
    func testIoRecDedupByCursor() {
        let store = SessionStore()
        store.appendRec(ioRec("once", seq: 5))
        store.appendRec(ioRec("DUP", seq: 5)) // same seq → dropped
        store.appendRec(ioRec("DUP2", seq: 3)) // older seq → dropped
        XCTAssertEqual(store.terminalOutput[sid], "once")
    }

    /// `ioText` returns nil on `d` that is not valid base64 (the only failure
    /// mode — lossy UTF-8 decode never fails on valid base64).
    func testIoTextRejectsNonBase64() {
        let rec = SessionRec(
            t: "rec", sid: sid, seq: 1, k: "io", ns: "runner", n: nil,
            d: "not!!base64", ts: 0,
        )
        XCTAssertNil(SessionStore.ioText(from: rec))
    }

    /// An io record with undecodable `d` advances the cursor but appends nothing,
    /// so it neither crashes nor blocks a later valid record.
    func testIoRecBadPayloadIsSkipped() {
        let store = SessionStore()
        let bad = SessionRec(
            t: "rec", sid: sid, seq: 1, k: "io", ns: "runner", n: nil,
            d: "not!!base64", ts: 0,
        )
        store.appendRec(bad)
        XCTAssertNil(store.terminalOutput[sid])
        store.appendRec(ioRec("after", seq: 2))
        XCTAssertEqual(store.terminalOutput[sid], "after")
    }

    /// Interleaved event + io records split cleanly across the two tabs: events
    /// to `chatItems`, io to `terminalOutput`, sharing one cursor.
    func testEventAndIoSplitByTab() {
        let store = SessionStore()
        // seq 1: a Stop hook event (base64 JSON). HookEventBase requires
        // session_id/hook_event_name/cwd, so include all three.
        let eventJSON = try! JSONSerialization.data(withJSONObject: [
            "session_id": sid,
            "hook_event_name": "Stop",
            "cwd": "/tmp/smoke",
            "last_assistant_message": "done",
        ])
        let eventRec = SessionRec(
            t: "rec", sid: sid, seq: 1, k: "event", ns: "claude", n: nil,
            d: eventJSON.base64EncodedString(), ts: 0,
        )
        store.appendRec(eventRec)
        store.appendRec(ioRec("$ ls\n", seq: 2))
        XCTAssertEqual(store.chatItems[sid]?.count, 1)
        XCTAssertEqual(store.chatItems[sid]?.first?.lastAssistantMessage, "done")
        XCTAssertEqual(store.terminalOutput[sid], "$ ls\n")
    }
}
