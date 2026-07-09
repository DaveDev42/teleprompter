import SwiftUI

#if os(macOS) || os(iOS)
/// A single session shown in its OWN top-level window / scene (messenger-style
/// pop-out), driven by the value-carrying `WindowGroup(id: "session", …)` in
/// `TeleprompterApp`. Opened via `openWindow(id: "session", value: sid)` from a
/// session row's context menu (macOS + iPad) or the session detail's pop-out
/// toolbar button (iPad). The body is platform-neutral — a `NavigationStack`
/// around `SessionDetailView` — so it renders identically as a macOS window and
/// as an iPad scene; `.frame(minWidth:minHeight:)` is honored on the desktop
/// and harmlessly ignored on iOS (the scene fills the space).
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
///
/// Known limitation (pre-existing on macOS; carried to iPad by parity): the
/// keyboard/menu nav intents live on the `AppNavigationModel.shared` SINGLETON,
/// which every open session window + the main window's pushed detail observe at
/// once. A ⌘[/⌘] step or ⌃⌘C/⌘T pane switch fired from the menu bar / a hardware
/// keyboard is therefore not scoped to the focused window. This is exactly how
/// macOS already behaves with multiple session windows; iPad inherits it. Scoping
/// nav intents per-window is deliberately out of scope for the window-split work.
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
