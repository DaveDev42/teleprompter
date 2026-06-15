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
/// `@MainActor` because the `@Published` mutations drive view updates — the relay
/// client hops here before calling in (it already marshals onto the main actor
/// for its other published state).
@MainActor
final class SessionStore: ObservableObject {
    /// sid → ordered chat items (oldest first, ascending `seq`).
    @Published private(set) var chatItems: [String: [ChatItem]] = [:]
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

    /// The resume cursor for `sid`: the highest applied `seq`, or 0 if none.
    /// `resume { c }` returns records with `seq > c`, so passing this backfills
    /// exactly the gap.
    func cursor(for sid: String) -> Int { cursors[sid] ?? 0 }

    /// Record/refresh a session's metadata (from `hello` sessions or a `state`
    /// frame). Does not touch chat items or the cursor.
    func upsertSessions(_ metas: [SessionMeta]) {
        for m in metas { sessions[m.sid] = m }
    }

    /// Apply a daemon `state` reply: refresh metadata for one session.
    func appendState(_ meta: SessionMeta) {
        sessions[meta.sid] = meta
    }

    /// Apply a history `batch` (oldest first). Each record runs through the same
    /// cursor-gated path as a live `rec`, so a batch that overlaps already-applied
    /// records is idempotent.
    func appendBatch(sid: String, recs: [SessionRec]) {
        for rec in recs { appendRec(rec) }
    }

    /// Apply one record. Advances the cursor; turns `event` records into chat
    /// items. `io`/`meta` records advance the cursor (so resume doesn't re-fetch
    /// them) but do not render in Chat — `io` belongs to the Terminal tab (M5).
    func appendRec(_ rec: SessionRec) {
        guard rec.seq > cursor(for: rec.sid) else { return } // dedup / out-of-order
        cursors[rec.sid] = rec.seq

        guard rec.k == "event" else { return } // io/meta: cursor only, no chat row

        guard let item = Self.chatItem(from: rec) else {
            log.error("event rec decode failed seq=\(rec.seq, privacy: .public)")
            return
        }
        chatItems[rec.sid, default: []].append(item)
    }

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
