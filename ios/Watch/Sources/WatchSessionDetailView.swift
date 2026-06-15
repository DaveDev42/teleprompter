import SwiftUI

/// Session detail card for the Teleprompter watch app (ADR-0002 Phase B3).
///
/// Shows the last assistant response and recent hook events. Provides Approve/Deny
/// buttons that send "y\n"/"n\n" to the running session — the "lightweight
/// approve/deny" experience described in ADR-0002 §watchOS.
struct WatchSessionDetailView: View {
    let session: SessionMeta
    @ObservedObject var sessionStore: SessionStore
    let pairings: WatchPairingViewModel

    /// Recent hook events for this session (last 5, newest first).
    private var recentEvents: [ChatItem] {
        let items = sessionStore.chatItems[session.sid] ?? []
        return Array(items.suffix(5).reversed())
    }

    /// Last assistant message from the most recent Stop event.
    private var lastMessage: String? {
        sessionStore.lastAssistantMessage(for: session.sid)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {

                // Status header.
                HStack(spacing: 6) {
                    Circle()
                        .fill(session.state == "running" ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)
                    Text(session.state.capitalized)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(String(session.sid.prefix(8)))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }

                // Last assistant response.
                if let msg = lastMessage, !msg.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Last Response")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(msg)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("No response yet")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                // Approve / Deny buttons (only when session is running).
                if session.state == "running" {
                    HStack(spacing: 8) {
                        Button {
                            pairings.sendInput(sid: session.sid, text: "y\n")
                        } label: {
                            Label("Approve", systemImage: "checkmark")
                                .font(.footnote)
                        }
                        .tint(.green)

                        Button {
                            pairings.sendInput(sid: session.sid, text: "n\n")
                        } label: {
                            Label("Deny", systemImage: "xmark")
                                .font(.footnote)
                        }
                        .tint(.red)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle)
                }

                // Recent hook events.
                if !recentEvents.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Recent Events")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        ForEach(recentEvents) { item in
                            HStack(spacing: 4) {
                                Image(systemName: hookEventIcon(item.hookEventName))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                Text(item.hookEventName)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                if let tool = item.toolName {
                                    Text("· \(tool)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 8)
        }
        .navigationTitle(String(session.sid.prefix(8)))
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Helpers

    private func hookEventIcon(_ name: String) -> String {
        switch name {
        case "Stop", "StopFailure": return "stop.circle"
        case "PreToolUse":          return "arrow.right.circle"
        case "PostToolUse":         return "checkmark.circle"
        case "Notification":        return "bell"
        default:                    return "circle"
        }
    }
}
