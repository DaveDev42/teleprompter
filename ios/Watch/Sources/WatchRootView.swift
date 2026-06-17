import SwiftUI

/// Glance-style root view for the Teleprompter watch app (ADR-0002 Phase B3).
///
/// Shows the connection status and the session list. Each session row navigates
/// to `WatchSessionDetailView` for the last assistant message + approve/deny.
/// This is a read-mostly glance UI — no terminal, no input composer, no QR scan.
struct WatchRootView: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: WatchPairingViewModel

    /// Sorted sessions: running ones first, then by most-recently-updated.
    private var sortedSessions: [SessionMeta] {
        sessionStore.sessions.values.sorted {
            if $0.state != $1.state {
                return $0.state == "running"  // running first
            }
            return $0.updatedAt > $1.updatedAt
        }
    }

    var body: some View {
        NavigationStack {
            List {
                // Connection status row at the top.
                Section {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(pairings.anyConnected ? Color.green : Color.gray)
                            .frame(width: 8, height: 8)
                        Text(pairings.anyConnected ? "Connected" : "Offline")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                // Session list.
                Section("Sessions") {
                    let sessions = sortedSessions
                    if sessions.isEmpty {
                        Text("No sessions")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sessions, id: \.sid) { session in
                            NavigationLink(
                                destination: WatchSessionDetailView(
                                    session: session,
                                    sessionStore: sessionStore,
                                    pairings: pairings
                                )
                            ) {
                                WatchSessionRow(
                                    session: session,
                                    lastMessage: sessionStore.lastAssistantMessage(for: session.sid)
                                )
                            }
                        }
                    }
                }
            }
            .navigationTitle("Teleprompter")
        }
    }
}

// MARK: - Session row

private struct WatchSessionRow: View {
    let session: SessionMeta
    let lastMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Circle()
                    .fill(session.state == "running" ? Color.green : Color.gray)
                    .frame(width: 6, height: 6)
                Text(String(session.sid.prefix(8)))
                    .font(.footnote.monospaced())
                    .lineLimit(1)
            }
            if let msg = lastMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - SessionStore convenience

extension SessionStore {
    /// Most recent Stop event's `last_assistant_message` for a session.
    func lastAssistantMessage(for sid: String) -> String? {
        chatItems[sid]?.last { $0.lastAssistantMessage != nil }?.lastAssistantMessage
    }
}
