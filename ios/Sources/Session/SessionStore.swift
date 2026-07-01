import Foundation
import os

/// One renderable chat row, distilled from a `SessionRec` whose `k == "event"`
/// (ADR-0001 Phase 3, M4). The Chat tab is **hooks-only** (CLAUDE.md "Key Design
/// Decisions"): PTY `io` records go to the Terminal tab and never become chat
/// items. The identity is the record's `seq` — monotonic per session, so it
/// doubles as the SwiftUI `id` and the dedup key.
struct ChatItem: Identifiable, Equatable {
    let seq: Int  // == SessionRec.seq; SwiftUI identity + dedup key
    let sid: String
    let hookEventName: String
    let toolName: String?  // PreToolUse/PostToolUse only
    let lastAssistantMessage: String?  // Stop only (success)
    let errorText: String?  // StopFailure only (L6)
    let prompt: String?  // UserPromptSubmit only (H2)
    let toolInput: String?  // PostToolUse compact JSON (I1)
    let toolResult: String?  // PostToolUse compact JSON (I1)
    let message: String?  // Elicitation message (M5)
    let permissionTool: String?  // PermissionRequest tool_name (M5)
    let ts: Double

    var id: Int { seq }
}

/// Holds decrypted session state for the UI: per-session metadata (`state`) and
/// the ordered chat items derived from `event` records. The relay receive loop
/// feeds it `appendState`/`appendRec`/`appendBatch`; SwiftUI observes the
/// `@Published` fields.
///
/// Sessions are persisted to `UserDefaults` so the list survives app relaunch.
/// The live relay data (chatItems, terminalOutput) is always in-memory only.
///
/// `@MainActor` because the `@Published` mutations drive view updates — the relay
/// client hops here before calling in (it already marshals onto the main actor
/// for its other published state).
@MainActor
final class SessionStore: ObservableObject {
    /// sid → ordered chat items (oldest first, ascending `seq`).
    @Published private(set) var chatItems: [String: [ChatItem]] = [:]
    /// sid → concatenated terminal output, oldest first. Built by appending each
    /// `k == "io"` record's decoded bytes (M5 Terminal tab). This is raw byte
    /// append — full ANSI emulation is a Phase 3.x follow-up (the plan scopes M5
    /// to "bytes append + input send").
    @Published private(set) var terminalOutput: [String: String] = [:]
    /// sid → latest known metadata (from `hello` and `state` frames).
    @Published private(set) var sessions: [String: SessionMeta] = [:]

    /// Per-daemon session buckets: daemonId → { sid → SessionMeta }.
    ///
    /// H3 fix: mirrors Expo `session-store.ts setSessions` which replaces the
    /// daemon's slice entirely on each `hello`. By replacing (not merging) we
    /// automatically drop sessions that the daemon no longer reports — ghost rows
    /// from daemon-deleted sessions never persist. The flat `sessions` dict is
    /// rebuilt by merging all buckets after each replace.
    private var sessionsByDaemon: [String: [String: SessionMeta]] = [:]

    /// Highest `seq` ingested per sid. A record is applied only when its `seq`
    /// exceeds this — so an overlapping resume `batch` (which returns `seq > c`,
    /// but the relay cache may also replay) never double-renders. Also the cursor
    /// the next `resume` should pass as `c`.
    private var cursors: [String: Int] = [:]

    private let log = Logger(
        subsystem: "dev.tpmt.app",
        category: "session",
    )

    // MARK: - Persistence

    private static let persistKey = "tp.sessions.v1"

    /// Initialise the store and immediately hydrate from `UserDefaults` so the
    /// session list is populated before the first relay `hello` arrives. The
    /// load is synchronous on the main actor (harmless at init time: the UI
    /// hasn't rendered yet).
    init() {
        // Load synchronously — `self` is on the main actor at this point because
        // the whole class is `@MainActor`, so `sessions` can be mutated safely.
        if let data = UserDefaults.standard.data(forKey: Self.persistKey),
            let decoded = try? JSONDecoder().decode([String: SessionMeta].self, from: data)
        {
            // Hydrate before first render; relay hello will upsert on top.
            sessions = decoded
        }
    }

    /// Load persisted sessions from UserDefaults. Called once at app init.
    /// Relay data (chatItems, terminalOutput) is always ephemeral — not persisted.
    func loadPersisted() {
        guard let data = UserDefaults.standard.data(forKey: Self.persistKey),
            let decoded = try? JSONDecoder().decode([String: SessionMeta].self, from: data)
        else { return }
        // Merge: live sessions (from relay hello) take precedence over persisted.
        for (sid, meta) in decoded where sessions[sid] == nil {
            sessions[sid] = meta
        }
    }

    /// Write current sessions to UserDefaults. Called after any sessions mutation.
    private func persistSessions() {
        guard let data = try? JSONEncoder().encode(sessions) else { return }
        UserDefaults.standard.set(data, forKey: Self.persistKey)
    }

    // MARK: - Session CRUD

    /// The resume cursor for `sid`: the highest applied `seq`, or 0 if none.
    /// `resume { c }` returns records with `seq > c`, so passing this backfills
    /// exactly the gap.
    func cursor(for sid: String) -> Int { cursors[sid] ?? 0 }

    /// `true` when Claude is actively working a turn for `sid`: a prompt was
    /// submitted and no matching `Stop`/`StopFailure` has closed it yet.
    ///
    /// This is the SoT for the Chat "typing" indicator, extracted from `ChatView`
    /// so it can be unit-tested against synthetic event streams. The previous
    /// implementation keyed off ONLY the trailing chat item's kind ("not a Stop ⇒
    /// busy"), which was inverted in practice:
    ///   - False-BUSY when idle: a session whose last event is a
    ///     `PostToolUse`/`Notification`/`SubagentStop`/unknown (all non-Stop)
    ///     showed the typing dots even though the turn was done.
    ///   - False-IDLE when busy: live output streams as `io` records to the
    ///     Terminal tab and never becomes a chat item, so a long working stretch
    ///     with a stale trailing `Stop` (or empty chat) showed nothing.
    ///
    /// Fix: scan the event stream from the end for the most recent *turn-lifecycle*
    /// event (`UserPromptSubmit` / `Stop` / `StopFailure`) — busy iff that event is
    /// a `UserPromptSubmit`. Intermediate events (`PostToolUse`, `Notification`, …)
    /// are not boundaries and never force "busy". Then AND-gate on the session
    /// being alive (`state == "running"`): a stopped/errored/unknown session is
    /// never "working", which also clears the false-busy first-screen for any dead
    /// session. Aggregated (`sid == nil`) views are never "working".
    func isWorking(sid: String?) -> Bool {
        guard let sid else { return false }
        // A non-running (stopped/errored/absent) session is never working.
        guard sessions[sid]?.state == "running" else { return false }
        // Walk from the end to the most recent turn-lifecycle event.
        for item in (chatItems[sid] ?? []).reversed() {
            switch item.hookEventName {
            case "UserPromptSubmit":
                return true  // a turn is open; no Stop has closed it yet
            case "Stop", "StopFailure":
                return false  // the last turn completed
            default:
                continue  // PostToolUse / Notification / etc. — not a boundary
            }
        }
        return false  // no lifecycle event yet → idle
    }

    /// Replace all sessions for one daemon with the list from a fresh `hello`.
    ///
    /// H3 fix: mirrors Expo `session-store.ts setSessions`. By replacing the
    /// daemon's entire bucket (not merging), sessions that the daemon no longer
    /// reports (deleted on the daemon side) automatically disappear from the UI.
    ///
    /// H4 fix: pending-* placeholders live only in-memory and are never placed in
    /// a daemon bucket, so they are implicitly discarded here. Additionally, any
    /// remaining `pending-*` key in the flat `sessions` dict is stripped after the
    /// merge — handles the edge case where a placeholder was added before kx.
    ///
    /// Call sites: `RelayClient.onHello` (passing the `daemonId` from the client).
    func replaceSessionsForDaemon(daemonId: String, sessions metas: [SessionMeta]) {
        // Build the daemon's fresh bucket.
        var bucket: [String: SessionMeta] = [:]
        for m in metas { bucket[m.sid] = m }
        sessionsByDaemon[daemonId] = bucket

        // Rebuild flat sessions dict from all daemon buckets.
        var merged: [String: SessionMeta] = [:]
        for (_, daemonBucket) in sessionsByDaemon {
            for (sid, meta) in daemonBucket { merged[sid] = meta }
        }
        // H4: strip any pending-* placeholders that slipped into sessions.
        for sid in merged.keys where sid.hasPrefix("pending-") {
            merged.removeValue(forKey: sid)
        }
        sessions = merged
        persistSessions()
    }

    /// Record/refresh a session's metadata (from a `state` frame).
    /// Does not touch chat items or the cursor. NOTE: for `hello`-driven updates
    /// use `replaceSessionsForDaemon` instead — that one prevents ghost rows.
    func upsertSessions(_ metas: [SessionMeta]) {
        for m in metas { sessions[m.sid] = m }
        persistSessions()
    }

    /// Apply a daemon `state` reply: refresh metadata for one session.
    func appendState(_ meta: SessionMeta) {
        sessions[meta.sid] = meta
        persistSessions()
    }

    /// Which daemon owns `sid`, if any. Used to route a `session.stop` /
    /// `session.delete` control message to the correct relay client in a
    /// multi-daemon setup. Returns the first daemon bucket containing the sid
    /// (a sid is unique to one daemon).
    func daemonId(for sid: String) -> String? {
        for (did, bucket) in sessionsByDaemon where bucket[sid] != nil {
            return did
        }
        return nil
    }

    /// Remove one session from local state. Also clears its chat/terminal data
    /// and removes the sid from every daemon bucket so that the next
    /// `replaceSessionsForDaemon` call (for any daemon) does not re-insert it.
    func removeSession(_ sid: String) {
        sessions.removeValue(forKey: sid)
        chatItems.removeValue(forKey: sid)
        terminalOutput.removeValue(forKey: sid)
        cursors.removeValue(forKey: sid)
        // Remove from all daemon buckets so a future replaceSessionsForDaemon
        // (even for an unrelated daemon) does not resurrect this sid as a ghost row.
        for key in sessionsByDaemon.keys { sessionsByDaemon[key]?.removeValue(forKey: sid) }
        persistSessions()
    }

    /// Remove multiple sessions from local state. Equivalent to calling
    /// `removeSession` for each sid.
    func removeSessions(_ sids: [String]) {
        for sid in sids { removeSessions(internal: sid) }
        persistSessions()
    }

    private func removeSessions(internal sid: String) {
        sessions.removeValue(forKey: sid)
        chatItems.removeValue(forKey: sid)
        terminalOutput.removeValue(forKey: sid)
        cursors.removeValue(forKey: sid)
        // Remove from all daemon buckets so a future replaceSessionsForDaemon
        // does not resurrect this sid as a ghost row.
        for key in sessionsByDaemon.keys { sessionsByDaemon[key]?.removeValue(forKey: sid) }
    }

    // MARK: - Record ingestion

    /// Apply a history `batch` (oldest first). Each record runs through the same
    /// cursor-gated path as a live `rec`, so a batch that overlaps already-applied
    /// records is idempotent.
    func appendBatch(sid: String, recs: [SessionRec]) {
        for rec in recs { appendRec(rec) }
    }

    /// Apply one record. Advances the cursor; routes by `k`: `event` → chat item
    /// (Chat tab), `io` → appended terminal bytes (Terminal tab, M5), `meta` →
    /// cursor only. `io` is deliberately NOT a chat item — the Chat tab is
    /// hooks-only (CLAUDE.md design decision).
    func appendRec(_ rec: SessionRec) {
        guard rec.seq > cursor(for: rec.sid) else { return }  // dedup / out-of-order
        cursors[rec.sid] = rec.seq

        switch rec.k {
        case "event":
            guard let item = Self.chatItem(from: rec) else {
                log.error("event rec decode failed seq=\(rec.seq, privacy: .public)")
                return
            }
            chatItems[rec.sid, default: []].append(item)
        case "io":
            guard let text = Self.ioText(from: rec) else {
                log.error("io rec decode failed seq=\(rec.seq, privacy: .public)")
                return
            }
            // LOAD-BEARING: this String accumulator is the source for
            // checkInputEcho / TP_INPUT_OK — never remove or reroute this line.
            terminalOutput[rec.sid, default: ""] += text
            // ADDITIVE: fire the byte sink for the SwiftTerm ANSI emulator.
            // Runs only on successful decode, only after the String append.
            if let d = Self.ioData(from: rec) { terminalByteSink?(rec.sid, d) }
        default:
            break  // meta: cursor only
        }
    }

    /// Decode a `k == "io"` record's base64 `d` into raw bytes.
    /// Returns nil only if `d` is not valid base64.
    static func ioData(from rec: SessionRec) -> Data? {
        Data(base64Encoded: rec.d)
    }

    /// Decode a `k == "io"` record's base64 `d` into UTF-8 text for the Terminal
    /// tab. `d` is always base64 (daemon encodes raw PTY bytes unconditionally,
    /// `command-dispatcher.ts:665`). Lossy UTF-8 so a chunk that splits a
    /// multi-byte sequence still appends (the next chunk completes it visually);
    /// returns nil only if `d` is not valid base64 at all.
    static func ioText(from rec: SessionRec) -> String? {
        guard let d = ioData(from: rec) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }

    /// Optional byte sink for the SwiftTerm ANSI emulator (A1 milestone).
    /// Called on MainActor after every successfully-decoded `io` record, with
    /// the session id and raw PTY bytes. Registration is additive — the String
    /// accumulator (`terminalOutput`) is NOT rerouted through this sink; both
    /// paths run independently. The smoke probe (`TP_INPUT_OK`) depends only on
    /// `terminalOutput`, so this sink has zero impact on smoke correctness.
    @MainActor var terminalByteSink: ((String, Data) -> Void)?

    /// Decode a `k == "event"` record's base64 `d` into a `ChatItem`. `d` is
    /// always base64 (daemon encodes unconditionally), then UTF-8 JSON of a hook
    /// event. Subtype fields are decoded from the same bytes against narrow structs.
    static func chatItem(from rec: SessionRec) -> ChatItem? {
        guard let data = Data(base64Encoded: rec.d) else { return nil }
        let decoder = JSONDecoder()
        guard let base = try? decoder.decode(HookEventBase.self, from: data) else {
            return nil
        }
        let toolDec = try? decoder.decode(HookEventTool.self, from: data)
        let stopDec = try? decoder.decode(HookEventStop.self, from: data)
        let promptDec = try? decoder.decode(HookEventPrompt.self, from: data)
        let permDec = try? decoder.decode(HookEventPermission.self, from: data)
        let elicDec = try? decoder.decode(HookEventElicitation.self, from: data)

        // H2: user prompt text — prefer `user_prompt`, fall back to `prompt`.
        let prompt = promptDec?.user_prompt ?? promptDec?.prompt

        // L6: StopFailure error text lives in `error` field, not last_assistant_message.
        let errorText = stopDec?.error

        return ChatItem(
            seq: rec.seq,
            sid: rec.sid,
            hookEventName: base.hook_event_name,
            toolName: toolDec?.tool_name,
            lastAssistantMessage: stopDec?.last_assistant_message,
            errorText: errorText,
            prompt: prompt,
            toolInput: toolDec?.tool_input?.displayValue,
            toolResult: toolDec?.tool_result?.displayValue,
            message: elicDec?.message,
            permissionTool: permDec?.tool_name,
            ts: rec.ts,
        )
    }
}

// MARK: - SessionMeta Codable conformance

/// Enable `SessionMeta` to be persisted in `UserDefaults`.
/// SessionMeta is defined in RelayMessages.swift with `Decodable` — we need full `Codable`.
extension SessionMeta: Encodable {
    enum CodingKeys: String, CodingKey {
        case sid, state, cwd, createdAt, updatedAt, lastSeq
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sid, forKey: .sid)
        try c.encode(state, forKey: .state)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(lastSeq, forKey: .lastSeq)
    }
}
