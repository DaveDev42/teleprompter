import SwiftUI

/// Which pane is visible inside a session detail screen.
enum SessionPane: String, CaseIterable, Hashable {
    case chat, terminal

    var title: String {
        switch self {
        case .chat:     return "Chat"
        case .terminal: return "Terminal"
        }
    }
}

/// Per-session detail screen. Shows Chat and Terminal panes toggled by a
/// segmented Picker at the top AND left/right swipe (via `.page` TabView
/// style). The selection binding is shared so both controls stay in sync.
///
/// H9: `ConnectionBanner` and `SessionStoppedBanner` are instantiated here
/// so their visual banners and VoiceOver live-region announcements fire.
/// `pairings` is optional so existing call sites (SessionsTab) continue to
/// compile without changes while the richer path activates when provided.
struct SessionDetailView: View {
    let sid: String
    @ObservedObject var sessionStore: SessionStore
    /// Injected from callers that have a `PairingViewModel` (H9 banners).
    /// Nil-safe: all banner logic short-circuits when pairings is absent.
    var pairings: PairingViewModel? = nil
    let onSend: (String, String) -> Void

    @State private var pane: SessionPane = .chat

    /// `true` when the daemon associated with this session is online.
    /// Resolves via pairings.isOnline(first daemon) — single-daemon convenience
    /// for now; a session→daemon map lands when N daemons each serve their own sessions.
    private var daemonOnline: Bool {
        guard let pairings, let did = pairings.daemonIds.first else { return false }
        return pairings.isOnline(did)
    }

    var body: some View {
        VStack(spacing: 0) {
            // H9: Connection banner — shows "Disconnected" / "Reconnected" with
            // VoiceOver live-region announcements. Always present in the hierarchy.
            ConnectionBanner(connected: daemonOnline)

            // H9: Session-stopped banner — shows "Session ended — read-only view"
            // when the session state is "stopped". Always present.
            SessionStoppedBanner(stopped: sessionStore.sessions[sid]?.state == "stopped")

            // Segmented Picker — syncs bidirectionally with the swipeable TabView.
            Picker("Pane", selection: $pane) {
                ForEach(SessionPane.allCases, id: \.self) { p in
                    Text(p.title).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 6)

            // Swipeable pager — .page style with no dots (the Picker is the indicator).
            TabView(selection: $pane) {
                // H1: pass onSend so ChatComposer renders (gated on `if let onSend`).
                ChatView(store: sessionStore, sid: sid, onSend: onSend)
                    .tag(SessionPane.chat)

                TerminalView(store: sessionStore, sid: sid, onSend: onSend)
                    .tag(SessionPane.terminal)
            }
            #if os(iOS)
            .tabViewStyle(.page(indexDisplayMode: .never))
            #endif
        }
        .navigationTitle(String(sid.prefix(12)))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}
