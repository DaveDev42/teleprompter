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

    /// `SessionStore.persistKey` — mirrored here (it's private). `SessionStore.init`
    /// hydrates `sessions` from this UserDefaults key, so a prior test that calls
    /// `appendState` (which persists) would leak a running `sess-smoketest` into the
    /// next test's fresh store. Clearing it per-test keeps `isWorking`'s
    /// state == "running" AND-gate honest (esp. the "unknown session" case).
    nonisolated private static let persistKey = "tp.sessions.v1"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: Self.persistKey)
        super.tearDown()
    }

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

    // MARK: isWorking — turn-lifecycle scan (busy-indicator inversion fix)

    /// Mark `sid` as a live (running) session so `isWorking` passes its AND-gate.
    private func markRunning(_ store: SessionStore, seq: Int = 0) {
        store.appendState(
            SessionMeta(
                sid: sid, state: "running", cwd: "/tmp/smoke",
                createdAt: 1, updatedAt: 2, lastSeq: seq))
    }

    private func userPromptRec(seq: Int) -> SessionRec {
        eventRec(
            seq: seq,
            json: [
                "session_id": sid, "hook_event_name": "UserPromptSubmit",
                "cwd": "/tmp/smoke", "user_prompt": "do a thing",
            ])
    }

    private func stopRec(seq: Int) -> SessionRec {
        eventRec(
            seq: seq,
            json: [
                "session_id": sid, "hook_event_name": "Stop", "cwd": "/tmp/smoke",
                "last_assistant_message": "done",
            ])
    }

    private func postToolRec(seq: Int) -> SessionRec {
        eventRec(
            seq: seq,
            json: [
                "session_id": sid, "hook_event_name": "PostToolUse",
                "cwd": "/tmp/smoke", "tool_name": "Bash",
            ])
    }

    /// An aggregated (sid == nil) view is never "working".
    func testIsWorkingNilSidIsNeverWorking() {
        let store = SessionStore()
        XCTAssertFalse(store.isWorking(sid: nil))
    }

    /// No lifecycle event yet (empty chat) on a running session → idle.
    func testIsWorkingEmptyChatIsIdle() {
        let store = SessionStore()
        markRunning(store)
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A submitted prompt with no closing Stop → busy.
    func testIsWorkingOpenTurnIsBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        XCTAssertTrue(store.isWorking(sid: sid))
    }

    /// A completed turn (prompt → Stop) → idle.
    func testIsWorkingClosedTurnIsIdle() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(stopRec(seq: 2))
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// REGRESSION (false-IDLE): an in-flight turn whose latest event is a
    /// non-boundary `PostToolUse` (Claude is mid-tool, streaming io) is still
    /// busy — the old trailing-item heuristic couldn't see past the tool event
    /// to the open prompt, and worse, live io never becomes a chat item at all.
    func testIsWorkingMidToolIsBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(postToolRec(seq: 2))  // mid-turn, not a boundary
        XCTAssertTrue(store.isWorking(sid: sid))
    }

    /// REGRESSION (false-BUSY): a finished session whose trailing event is a
    /// non-`Stop` (`PostToolUse`) must read idle. The old heuristic returned
    /// busy for any trailing item that wasn't `.assistant`, showing the typing
    /// dots forever on an idle session.
    func testIsWorkingTrailingPostToolAfterStopIsIdle() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(stopRec(seq: 2))
        store.appendRec(postToolRec(seq: 3))  // a stray post-Stop tool event
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A StopFailure also closes the turn → idle.
    func testIsWorkingStopFailureClosesTurn() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(
            eventRec(
                seq: 2,
                json: [
                    "session_id": sid, "hook_event_name": "StopFailure",
                    "cwd": "/tmp/smoke", "error": "boom",
                ]))
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A new turn after a completed one (prompt → Stop → prompt) → busy again.
    func testIsWorkingNewTurnAfterStopIsBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(stopRec(seq: 2))
        store.appendRec(userPromptRec(seq: 3))  // second turn opens
        XCTAssertTrue(store.isWorking(sid: sid))
    }

    /// AND-gate: an open turn on a NON-running (stopped) session is never busy —
    /// a killed/finished process can't be "working" no matter what events remain.
    func testIsWorkingStoppedSessionIsNeverBusy() {
        let store = SessionStore()
        store.appendState(
            SessionMeta(
                sid: sid, state: "stopped", cwd: "/tmp/smoke",
                createdAt: 1, updatedAt: 2, lastSeq: 0))
        store.appendRec(userPromptRec(seq: 1))  // an open turn…
        XCTAssertFalse(store.isWorking(sid: sid))  // …but process is dead
    }

    /// AND-gate: unknown session (no state at all) is never busy.
    func testIsWorkingUnknownSessionIsNeverBusy() {
        let store = SessionStore()
        store.appendRec(userPromptRec(seq: 1))
        XCTAssertFalse(store.isWorking(sid: sid))  // no SessionMeta → not running
    }

    // MARK: isWorking — permission/elicitation are NOT "busy" (Batch C — FIX #5)
    //
    // A pending PermissionRequest/Elicitation means Claude is blocked on the
    // *user*, not thinking — the animated "typing" dots must not show. Before
    // this fix, the last turn-lifecycle event scanned by `isWorking` was still
    // the open `UserPromptSubmit` (permission/elicitation events were treated
    // as non-boundary, like PostToolUse), so the indicator kept pulsing under
    // a card that was actually just waiting on the user to tap Approve/Deny
    // or reply.

    private func permissionRec(seq: Int) -> SessionRec {
        eventRec(
            seq: seq,
            json: [
                "session_id": sid, "hook_event_name": "PermissionRequest",
                "cwd": "/tmp/smoke", "tool_name": "Bash",
            ])
    }

    private func elicitationRec(seq: Int) -> SessionRec {
        eventRec(
            seq: seq,
            json: [
                "session_id": sid, "hook_event_name": "Elicitation",
                "cwd": "/tmp/smoke", "message": "What is your name?",
            ])
    }

    /// A pending PermissionRequest as the latest event → NOT busy (blocked on user).
    func testIsWorkingPermissionRequestIsNotBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(permissionRec(seq: 2))
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A pending Elicitation as the latest event → NOT busy (blocked on user).
    func testIsWorkingElicitationIsNotBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(elicitationRec(seq: 2))
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A PermissionRequest followed by more tool activity (still no Stop) stays
    /// NOT busy — PermissionRequest is itself a boundary, so trailing
    /// non-boundary events after it don't resurrect "busy" without a fresh
    /// UserPromptSubmit.
    func testIsWorkingPostToolAfterPermissionIsStillNotBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(permissionRec(seq: 2))
        store.appendRec(postToolRec(seq: 3))
        XCTAssertFalse(store.isWorking(sid: sid))
    }

    /// A new turn after a permission prompt (prompt → PermissionRequest →
    /// prompt) → busy again, same as the Stop case.
    func testIsWorkingNewTurnAfterPermissionIsBusy() {
        let store = SessionStore()
        markRunning(store)
        store.appendRec(userPromptRec(seq: 1))
        store.appendRec(permissionRec(seq: 2))
        store.appendRec(userPromptRec(seq: 3))
        XCTAssertTrue(store.isWorking(sid: sid))
    }

    // MARK: composer honesty gate (Batch B — FIX #3/#4/#7)
    //
    // `ChatView.sessionStopped` is the disable-gate handed down to
    // `ChatComposer`. Before this batch it only checked `state == "stopped"`,
    // so a crashed ("error") session left the composer enabled and a typed
    // message would silently vanish into the fire-and-forget `onSend` with no
    // ack. These tests pin the broadened gate (state-terminal OR daemon
    // offline) directly — no SwiftUI render pass needed since `sessionStopped`
    // / `disabledReason` are pure computed properties over `SessionStore` +
    // `daemonOnline`.

    private func chatMeta(state: String) -> SessionMeta {
        SessionMeta(
            sid: sid, state: state, cwd: "/tmp/smoke",
            createdAt: 1, updatedAt: 2, lastSeq: 0)
    }

    func testComposerEnabledWhenRunningAndOnline() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "running"))
        let view = ChatView(store: store, sid: sid, daemonOnline: true)
        XCTAssertFalse(view.sessionStopped)
        XCTAssertNil(view.disabledReason)
    }

    func testComposerDisabledWhenStopped() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "stopped"))
        let view = ChatView(store: store, sid: sid, daemonOnline: true)
        XCTAssertTrue(view.sessionStopped)
        XCTAssertEqual(view.disabledReason, "Session ended — read-only.")
    }

    /// FIX #3: an "error" (crashed) session must disable the composer too —
    /// previously only "stopped" did, so a crashed session silently ate input.
    func testComposerDisabledWhenErrored() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "error"))
        let view = ChatView(store: store, sid: sid, daemonOnline: true)
        XCTAssertTrue(view.sessionStopped)
        XCTAssertEqual(view.disabledReason, "Session crashed — read-only.")
    }

    /// FIX #7: a running session with the daemon offline must also disable
    /// the composer — the gate previously ignored connectivity entirely.
    func testComposerDisabledWhenRunningButDaemonOffline() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "running"))
        let view = ChatView(store: store, sid: sid, daemonOnline: false)
        XCTAssertTrue(view.sessionStopped)
        XCTAssertEqual(view.disabledReason, "Daemon offline — can't send.")
    }

    /// `daemonOnline` defaults to `true` (call sites that don't pass it keep
    /// today's state-only gating) — see the TODO on `ChatView.daemonOnline`.
    func testComposerDaemonOnlineDefaultsTrue() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "running"))
        let view = ChatView(store: store, sid: sid)
        XCTAssertFalse(view.sessionStopped)
    }

    /// A nil sid (aggregated view) never renders a composer, so the gate is
    /// vacuously "not stopped" regardless of any session's state.
    func testComposerNilSidIsNeverStopped() {
        let store = SessionStore()
        store.appendState(chatMeta(state: "error"))
        let view = ChatView(store: store, sid: nil, daemonOnline: false)
        XCTAssertFalse(view.sessionStopped)
        XCTAssertNil(view.disabledReason)
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
