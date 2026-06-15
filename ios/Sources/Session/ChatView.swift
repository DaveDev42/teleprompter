import SwiftUI

/// The Chat tab (ADR-0001 Phase 3, M4). Renders hook-event records as structured
/// message rows — **hooks-only** by design (CLAUDE.md "Key Design Decisions"):
/// PTY `io` records never reach here; they belong to the Terminal tab (M5).
///
/// Sessions arrive via `hello`; the relay client auto-attaches the first one and
/// backfills its history, so on a fresh connect this tab fills itself without any
/// selection UI. Multiple sessions are flattened oldest-first across all sids —
/// per-session navigation lands with M5's session switcher.
struct ChatView: View {
    @ObservedObject var store: SessionStore

    /// All chat items across sessions, oldest first (ascending seq within a sid).
    private var items: [ChatItem] {
        store.chatItems.values.flatMap { $0 }.sorted {
            $0.ts != $1.ts ? $0.ts < $1.ts : $0.seq < $1.seq
        }
    }

    var body: some View {
        NavigationStack {
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
            .navigationTitle("Chat")
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
