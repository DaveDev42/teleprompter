import SwiftUI

/// Glance-style root view for the Teleprompter watch app (ADR-0002 Phase B3).
///
/// Shows the connection status and the session list. Each session row navigates
/// to `WatchSessionDetailView` for the last assistant message + approve/deny.
/// This is a read-mostly glance UI — no terminal, no input composer, no QR scan.
struct WatchRootView: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: WatchPairingViewModel

    /// Sessions in `SessionStore`'s canonical order (running first, then
    /// most-recently-updated), shared with the phone app so both stay in sync.
    ///
    /// The pinned-first key of that order is inert here: pinning is device-local
    /// and the watch has no pin affordance, so its pin set is always empty.
    /// Adopting the shared comparator also fixes a subtle local bug — the old
    /// inline one short-circuited on `state` inequality, so a `stopped` row and
    /// an `error` row compared as equal and skipped the `updatedAt` tiebreak.
    private var sortedSessions: [SessionMeta] {
        sessionStore.orderedSessions
    }

    /// The status row. Three states rather than a Connected/Offline binary,
    /// because on a device with no pairing UI the most useful thing to say is
    /// "the iPhone hasn't sent you anything yet" — which "Offline" hid. See
    /// `WatchConnectionState`.
    private var statusColor: Color {
        switch pairings.connectionState {
        case .noPairings: return .gray
        case .connecting: return .yellow
        case .connected: return .green
        }
    }

    private var statusText: String {
        switch pairings.connectionState {
        case .noPairings: return "Open Teleprompter on iPhone"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        }
    }

    var body: some View {
        NavigationStack {
            List {
                // Connection status row at the top.
                Section {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                        Text(statusText)
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
