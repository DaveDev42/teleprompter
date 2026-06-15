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
struct SessionDetailView: View {
    let sid: String
    @ObservedObject var sessionStore: SessionStore
    let onSend: (String, String) -> Void

    @State private var pane: SessionPane = .chat

    var body: some View {
        VStack(spacing: 0) {
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
                ChatView(store: sessionStore, sid: sid)
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
