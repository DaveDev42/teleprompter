import Foundation
import os

/// One renderable chat row, distilled from a `SessionRec` whose `k == "event"`
/// (ADR-0001 Phase 3, M4). The Chat tab is **hooks-only** (CLAUDE.md "Key Design
/// Decisions"): PTY `io` records go to the Terminal tab and never become chat
/// items. The identity is the record's `seq` — monotonic per session, so it
/// doubles as the SwiftUI `id` and the dedup key.
struct ChatItem: Identifiable, Equatable {
    let seq: Int // == SessionRec.seq; SwiftUI identity + dedup key
    let sid: String
    let hookEventName: String
    let toolName: String? // PreToolUse/PostToolUse only
    let lastAssistantMessage: String? // Stop/StopFailure only
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

    /// Highest `seq` ingested per sid. A record is applied only when its `seq`
    /// exceeds this — so an overlapping resume `batch` (which returns `seq > c`,
    /// but the relay cache may also replay) never double-renders. Also the cursor
    /// the next `resume` should pass as `c`.
    private var cursors: [String: Int] = [:]

    private let log = Logger(
        subsystem: "dev.tpmt.teleprompter",
        category: "session",
    )

    // MARK: - Persistence

    private static let persistKey = "tp.sessions.v1"

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

    /// Record/refresh a session's metadata (from `hello` sessions or a `state`
    /// frame). Does not touch chat items or the cursor.
    func upsertSessions(_ metas: [SessionMeta]) {
        for m in metas { sessions[m.sid] = m }
        persistSessions()
    }

    /// Apply a daemon `state` reply: refresh metadata for one session.
    func appendState(_ meta: SessionMeta) {
        sessions[meta.sid] = meta
        persistSessions()
    }

    /// Remove one session from local state. Also clears its chat/terminal data.
    /// NOTE: This is local-only — there is no `session.delete` relay message.
    /// The daemon-side delete must be triggered separately (CLI or future relay op).
    func removeSession(_ sid: String) {
        sessions.removeValue(forKey: sid)
        chatItems.removeValue(forKey: sid)
        terminalOutput.removeValue(forKey: sid)
        cursors.removeValue(forKey: sid)
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
        guard rec.seq > cursor(for: rec.sid) else { return } // dedup / out-of-order
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
            break // meta: cursor only
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
    /// event. Subtype fields (`tool_name`, `last_assistant_message`) are decoded
    /// from the same bytes against their narrow structs.
    static func chatItem(from rec: SessionRec) -> ChatItem? {
        guard let data = Data(base64Encoded: rec.d) else { return nil }
        let decoder = JSONDecoder()
        guard let base = try? decoder.decode(HookEventBase.self, from: data) else {
            return nil
        }
        let toolName = try? decoder.decode(HookEventTool.self, from: data).tool_name
        let lastMsg = try? decoder.decode(HookEventStop.self, from: data)
            .last_assistant_message
        return ChatItem(
            seq: rec.seq,
            sid: rec.sid,
            hookEventName: base.hook_event_name,
            toolName: toolName,
            lastAssistantMessage: lastMsg ?? nil,
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
