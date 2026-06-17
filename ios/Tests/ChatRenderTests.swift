import XCTest

@testable import Teleprompter

/// Unit tests for M4 live session render (ADR-0001 Phase 3): the `SessionStore`
/// transform from `SessionRec` (the daemon's wire record) to renderable
/// `ChatItem`s. No relay/Simulator needed — this is the offline contract guard
/// the M4 plan specifies, mirroring the daemon's encoding rules:
///   - `d` is ALWAYS base64 of the payload, for every `k`
///     (`command-dispatcher.ts:950`);
///   - a `k == "event"` record's payload is UTF-8 JSON of a hook event
///     (`event.ts:19-24`);
///   - the canonical Stop response is `last_assistant_message` (CLAUDE.md);
///   - PTY `io` records never become chat items (hooks-only Chat tab);
///   - `seq` is monotonic per session and gates dedup (the resume cursor).
@MainActor
final class ChatRenderTests: XCTestCase {
    private let sid = "sess-smoketest"

    /// Build a wire-shaped event record whose base64 `d` decodes to the given
    /// hook-event JSON object — exactly how the daemon frames it.
    private func eventRec(seq: Int, json: [String: Any]) -> SessionRec {
        let data = try! JSONSerialization.data(withJSONObject: json)
        return SessionRec(
            t: "rec", sid: sid, seq: seq, k: "event",
            ns: nil, n: nil,
            d: data.base64EncodedString(),
            ts: Double(seq))
    }

    private func ioRec(seq: Int, text: String) -> SessionRec {
        SessionRec(
            t: "rec", sid: sid, seq: seq, k: "io",
            ns: "stdout", n: nil,
            d: Data(text.utf8).base64EncodedString(),
            ts: Double(seq))
    }

    // MARK: event decode → chat item

    /// A Stop event surfaces its `last_assistant_message` (the canonical reply).
    func testStopEventRendersAssistantMessage() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 1,
                json: [
                    "session_id": sid,
                    "hook_event_name": "Stop",
                    "cwd": "/tmp/smoke",
                    "last_assistant_message": "hello from claude",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].hookEventName, "Stop")
        XCTAssertEqual(items[0].lastAssistantMessage, "hello from claude")
        XCTAssertNil(items[0].toolName)
        XCTAssertEqual(items[0].seq, 1)
    }

    /// A PreToolUse event surfaces its tool name, no assistant message.
    func testToolEventRendersToolName() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 2,
                json: [
                    "session_id": sid,
                    "hook_event_name": "PreToolUse",
                    "cwd": "/tmp/smoke",
                    "tool_name": "Bash",
                    "tool_input": ["command": "ls"],
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].hookEventName, "PreToolUse")
        XCTAssertEqual(items[0].toolName, "Bash")
        XCTAssertNil(items[0].lastAssistantMessage)
    }

    // MARK: hooks-only / dedup / cursor

    /// PTY `io` records advance the cursor but never render as chat items.
    func testIoRecordsAreNotChatItems() {
        let store = SessionStore()
        store.appendRec(ioRec(seq: 1, text: "$ ls\n"))
        XCTAssertNil(store.chatItems[sid])
        // Cursor advanced past the io record (so resume won't re-fetch it).
        XCTAssertEqual(store.cursor(for: sid), 1)
    }

    /// A record whose seq is <= the cursor is dropped (idempotent overlap): a
    /// resume `batch` that re-delivers an applied record must not double-render.
    func testDuplicateSeqIsDeduped() {
        let store = SessionStore()
        let rec = eventRec(
            seq: 1,
            json: [
                "session_id": sid, "hook_event_name": "Stop", "cwd": "/tmp/smoke",
                "last_assistant_message": "once",
            ])
        store.appendRec(rec)
        store.appendRec(rec)  // same seq → ignored
        XCTAssertEqual(store.chatItems[sid]?.count, 1)
    }

    /// `appendBatch` applies records oldest-first and advances the cursor to the
    /// last seq; the cursor is then what the next `resume { c }` passes.
    func testBatchAppliesInOrderAndAdvancesCursor() {
        let store = SessionStore()
        let batch = [
            eventRec(
                seq: 1,
                json: [
                    "session_id": sid, "hook_event_name": "UserPromptSubmit",
                    "cwd": "/tmp/smoke",
                ]),
            eventRec(
                seq: 2,
                json: [
                    "session_id": sid, "hook_event_name": "Stop", "cwd": "/tmp/smoke",
                    "last_assistant_message": "done",
                ]),
        ]
        store.appendBatch(sid: sid, recs: batch)
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items.map(\.seq), [1, 2])
        XCTAssertEqual(items.last?.lastAssistantMessage, "done")
        XCTAssertEqual(store.cursor(for: sid), 2)
    }

    /// A re-`resume` after a batch (cursor=2) backfills only seq>cursor records —
    /// re-applying the same batch is a no-op (proves the resume loop converges).
    func testReResumeOverBatchIsIdempotent() {
        let store = SessionStore()
        let batch = [
            eventRec(
                seq: 1,
                json: [
                    "session_id": sid, "hook_event_name": "Stop", "cwd": "/tmp/smoke",
                    "last_assistant_message": "a",
                ])
        ]
        store.appendBatch(sid: sid, recs: batch)
        store.appendBatch(sid: sid, recs: batch)  // overlap → ignored
        XCTAssertEqual(store.chatItems[sid]?.count, 1)
        XCTAssertEqual(store.cursor(for: sid), 1)
    }

    // MARK: malformed payloads

    /// A non-base64 `d` is rejected without crashing and produces no chat item,
    /// but still advances the cursor (so the stream doesn't stall on a bad rec).
    func testMalformedPayloadProducesNoItem() {
        let store = SessionStore()
        let bad = SessionRec(
            t: "rec", sid: sid, seq: 1, k: "event",
            ns: nil, n: nil, d: "%%%not-base64%%%", ts: 1)
        store.appendRec(bad)
        XCTAssertNil(store.chatItems[sid])
        XCTAssertEqual(store.cursor(for: sid), 1)
    }

    // MARK: H2 — UserPromptSubmit carries prompt text

    /// `UserPromptSubmit` decodes `user_prompt` as the prompt text (H2).
    func testUserPromptSubmitDecodesPromptText() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 10,
                json: [
                    "session_id": sid,
                    "hook_event_name": "UserPromptSubmit",
                    "cwd": "/tmp/smoke",
                    "user_prompt": "hello world",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].hookEventName, "UserPromptSubmit")
        XCTAssertEqual(items[0].prompt, "hello world")
        // ChatEventCardKind maps this to .user(text:)
        let kind = ChatEventCardKind(item: items[0])
        if case .user(let text) = kind {
            XCTAssertEqual(text, "hello world")
        } else {
            XCTFail("Expected .user kind for UserPromptSubmit")
        }
    }

    /// Falls back to `prompt` field when `user_prompt` is absent (H2).
    func testUserPromptSubmitFallsBackToPromptField() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 11,
                json: [
                    "session_id": sid,
                    "hook_event_name": "UserPromptSubmit",
                    "cwd": "/tmp/smoke",
                    "prompt": "fallback prompt",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items[0].prompt, "fallback prompt")
    }

    // MARK: L6 — StopFailure shows error field

    /// `StopFailure` uses the `error` field, not `last_assistant_message` (L6).
    func testStopFailureDecodesErrorField() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 20,
                json: [
                    "session_id": sid,
                    "hook_event_name": "StopFailure",
                    "cwd": "/tmp/smoke",
                    "error": "something went wrong",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items[0].hookEventName, "StopFailure")
        XCTAssertEqual(items[0].errorText, "something went wrong")
        let kind = ChatEventCardKind(item: items[0])
        if case .assistant(let text, let isFailure) = kind {
            XCTAssertTrue(isFailure)
            XCTAssertEqual(text, "something went wrong")
        } else {
            XCTFail("Expected .assistant(isFailure: true) for StopFailure")
        }
    }

    // MARK: M5 — PermissionRequest and Elicitation

    /// `PermissionRequest` maps to `.permission(tool:)` kind (M5).
    func testPermissionRequestMapsToPemissionKind() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 30,
                json: [
                    "session_id": sid,
                    "hook_event_name": "PermissionRequest",
                    "cwd": "/tmp/smoke",
                    "tool_name": "Bash",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items[0].hookEventName, "PermissionRequest")
        XCTAssertEqual(items[0].permissionTool, "Bash")
        let kind = ChatEventCardKind(item: items[0])
        if case .permission(let tool) = kind {
            XCTAssertEqual(tool, "Bash")
        } else {
            XCTFail("Expected .permission kind for PermissionRequest")
        }
    }

    /// `Elicitation` maps to `.elicitation(message:)` kind (M5).
    func testElicitationMapsToElicitationKind() {
        let store = SessionStore()
        store.appendRec(
            eventRec(
                seq: 31,
                json: [
                    "session_id": sid,
                    "hook_event_name": "Elicitation",
                    "cwd": "/tmp/smoke",
                    "message": "What is your name?",
                ]))
        let items = store.chatItems[sid] ?? []
        XCTAssertEqual(items[0].hookEventName, "Elicitation")
        XCTAssertEqual(items[0].message, "What is your name?")
        let kind = ChatEventCardKind(item: items[0])
        if case .elicitation(let msg) = kind {
            XCTAssertEqual(msg, "What is your name?")
        } else {
            XCTFail("Expected .elicitation kind for Elicitation")
        }
    }

    // MARK: session metadata

    /// `appendState` upserts metadata without touching chat items or the cursor.
    func testStateUpsertsMetaOnly() {
        let store = SessionStore()
        let meta = SessionMeta(
            sid: sid, state: "running", cwd: "/tmp/smoke",
            createdAt: 1, updatedAt: 2, lastSeq: 0)
        store.appendState(meta)
        XCTAssertEqual(store.sessions[sid]?.state, "running")
        XCTAssertNil(store.chatItems[sid])
        XCTAssertEqual(store.cursor(for: sid), 0)
    }
}
