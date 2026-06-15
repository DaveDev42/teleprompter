import SwiftUI

/// Sessions tab — root of the session navigation stack. Lists all known sessions
/// (populated from `hello` frames via the relay client). Tapping a session row
/// drills into `SessionDetailView` where Chat and Terminal are toggled by a
/// segmented Picker and left/right swipe.
struct SessionsTab: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    var body: some View {
        NavigationStack {
            SessionListView(sessionStore: sessionStore, pairings: pairings)
                .navigationTitle("Sessions")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
        }
    }
}

/// The actual session list (extracted for reuse + testing).
struct SessionListView: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    /// Sessions sorted: running first, then by updatedAt descending.
    private var sortedSessions: [SessionMeta] {
        sessionStore.sessions.values.sorted { a, b in
            let aRunning = (a.state == "running")
            let bRunning = (b.state == "running")
            if aRunning != bRunning { return aRunning }
            return a.updatedAt > b.updatedAt
        }
    }

    var body: some View {
        Group {
            if sortedSessions.isEmpty {
                ContentUnavailableView(
                    "No sessions yet",
                    systemImage: "list.bullet",
                    description: Text("Connect a daemon via Settings → Daemons to see sessions."))
            } else {
                List(sortedSessions, id: \.sid) { meta in
                    NavigationLink(value: meta.sid) {
                        SessionRow(meta: meta)
                    }
                    .accessibilityIdentifier("session-\(meta.sid)")
                }
                .listStyle(.plain)
            }
        }
        .navigationDestination(for: String.self) { sid in
            SessionDetailView(
                sid: sid,
                sessionStore: sessionStore,
                onSend: { sid, text in pairings.sendInput(sid: sid, text: text) }
            )
        }
    }
}

/// One row in the session list.
private struct SessionRow: View {
    let meta: SessionMeta

    var body: some View {
        HStack(spacing: 10) {
            // Status dot
            Circle()
                .fill(meta.state == "running" ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(meta.sid.prefix(16))
                    .font(.callout.monospaced())
                    .lineLimit(1)

                if !meta.cwd.isEmpty {
                    Text(abbreviatingWithTildeInPath(meta.cwd))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Text(relativeTimestamp(meta.updatedAt))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }

    private func abbreviatingWithTildeInPath(_ path: String) -> String {
        // homeDirectoryForCurrentUser is macOS-only; on iOS use NSHomeDirectory().
        #if os(macOS)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        #else
        let home = NSHomeDirectory()
        #endif
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func relativeTimestamp(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000) // ms → s
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
