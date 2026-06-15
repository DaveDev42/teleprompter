import SwiftUI

/// Chat pane (ADR-0001 Phase 3, M4). Renders hook-event records as structured
/// message rows — **hooks-only** by design (CLAUDE.md "Key Design Decisions"):
/// PTY `io` records never reach here; they belong to the Terminal pane (M5).
///
/// When `sid` is provided (SessionDetailView), only that session's items are shown.
/// When `sid` is nil, all sessions are flattened oldest-first (legacy/standalone use).
struct ChatView: View {
    @ObservedObject var store: SessionStore
    /// When non-nil, show only this session's chat items.
    var sid: String? = nil

    /// Chat items to display — scoped to `sid` when provided, else all sessions.
    private var items: [ChatItem] {
        if let sid {
            return store.chatItems[sid] ?? []
        }
        return store.chatItems.values.flatMap { $0 }.sorted {
            $0.ts != $1.ts ? $0.ts < $1.ts : $0.seq < $1.seq
        }
    }

    var body: some View {
        Group {
            if items.isEmpty {
                ContentUnavailableView(
                    "No messages yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Attach a running session to see its hook events."))
            } else {
                List(items) { item in
                    ChatItemRow(item: item)
                }
                .listStyle(.plain)
            }
        }
    }
}

/// One hook-event row. A `Stop` event shows its `last_assistant_message` (the
/// canonical assistant response); a tool event shows the tool name; everything
/// else shows just the event label.
private struct ChatItemRow: View {
    let item: ChatItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.hookEventName)
                .font(.caption.bold())
                .foregroundStyle(.tint)
                .accessibilityIdentifier("event-name-\(item.seq)")
            if let msg = item.lastAssistantMessage, !msg.isEmpty {
                Text(msg)
                    .font(.body)
            } else if let tool = item.toolName {
                Text(tool)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
