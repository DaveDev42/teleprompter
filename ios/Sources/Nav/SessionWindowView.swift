import SwiftUI

#if os(macOS)
/// A single session shown in its OWN top-level window (messenger-style
/// pop-out), driven by the value-carrying `WindowGroup(id: "session", …)` in
/// `TeleprompterApp`. Opened via `openWindow(value: sid)` from a session row's
/// context menu.
///
/// Why this exists: the app's main window is a value-less `WindowGroup`, so the
/// system "New Window" command could only ever clone the main window (there is
/// no value to differentiate instances). This view is the destination of the
/// per-session `WindowGroup(for: String.self)`, so a chosen session lives in a
/// dedicated window instead of duplicating the main window.
///
/// State sharing: `sessionStore` and `pairings` are the SAME app-lifetime
/// instances the main window uses (passed down from the App struct's `@State`),
/// so records stream live into both the main window's detail and this pop-out.
/// Passing `pairings` also lights up the H9 connection / stopped banners, same
/// as the in-app detail.
struct SessionWindowView: View {
    let sid: String
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    /// A stable, human-readable window title: the session's cwd leaf (matching
    /// the Sessions list label) with a short sid fallback. Recomputed as the
    /// store updates so a renamed/re-cwd'd session keeps a sensible title.
    private var windowTitle: String {
        guard let meta = sessionStore.sessions[sid] else {
            return String(sid.prefix(16))
        }
        if meta.cwd.isEmpty { return String(sid.prefix(16)) }
        let leaf = meta.cwd
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/")
            .last
            .map(String.init)
        return leaf ?? meta.cwd
    }

    var body: some View {
        NavigationStack {
            SessionDetailView(
                sid: sid,
                sessionStore: sessionStore,
                pairings: pairings,
                onSend: { sid, text in pairings.sendInput(sid: sid, text: text) }
            )
            .navigationTitle(windowTitle)
        }
        .frame(minWidth: 480, minHeight: 360)
        .accessibilityIdentifier("session-window-\(sid)")
    }
}
#endif
