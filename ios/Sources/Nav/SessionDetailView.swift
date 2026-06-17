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
/// segmented Picker at the top.
///
/// **Tab-only switch (no swipe pager):** the panes are switched purely by the
/// segmented control. A horizontal `.page` swipe pager was removed because it
/// fought both the chat's vertical scroll and the terminal's own pan/scroll
/// gestures (the Expo baseline was tap-only for the same reason). Pane changes
/// cross-fade for a light sense of motion without a draggable surface.
///
/// H9: `ConnectionBanner` and `SessionStoppedBanner` are instantiated here
/// (above the segmented control, matching the Expo layout) so their visual
/// banners and VoiceOver live-region announcements fire. `pairings` is optional
/// so existing call sites (SessionsTab) continue to compile without changes
/// while the richer path activates when provided.
struct SessionDetailView: View {
    let sid: String
    @ObservedObject var sessionStore: SessionStore
    /// Injected from callers that have a `PairingViewModel` (H9 banners).
    /// Nil-safe: all banner logic short-circuits when pairings is absent.
    var pairings: PairingViewModel? = nil
    let onSend: (String, String) -> Void

    @State private var pane: SessionPane = .chat

    /// Shared app-wide navigation model (keyboard shortcuts, pane intents).
    /// Accessed directly via the process-lifetime singleton, mirroring
    /// `SessionNavigator.shared`. Reading its `@Observable` properties inside
    /// `body` establishes SwiftUI dependency tracking for `.onChange`/`.disabled`.
    private var nav: AppNavigationModel { AppNavigationModel.shared }

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

            // Segmented Picker — the sole pane switch (tap-only, no swipe pager).
            Picker("Pane", selection: $pane) {
                ForEach(SessionPane.allCases, id: \.self) { p in
                    Text(p.title).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 6)
            .accessibilityIdentifier("session-pane-picker")

            // Pane content — switched by the segmented control. Each pane fills
            // the remaining space; a cross-fade gives motion without a draggable
            // surface that would conflict with the panes' own scroll gestures.
            ZStack {
                switch pane {
                case .chat:
                    // H1: pass onSend so ChatComposer renders (gated on `if let onSend`).
                    ChatView(store: sessionStore, sid: sid, onSend: onSend)
                        .transition(.opacity)
                case .terminal:
                    TerminalView(store: sessionStore, sid: sid, onSend: onSend)
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.easeInOut(duration: 0.18), value: pane)
        }
        .navigationTitle(String(sid.prefix(12)))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        // FIX #5: gate macOS session commands — a detail screen is on-screen.
        .onAppear { nav.hasActiveDetail = true }
        .onDisappear {
            nav.hasActiveDetail = false
            // FIX #4: a torn-down composer can't fire its own focus-loss change,
            // so clear the flag here too — otherwise it stays stuck `true` and
            // permanently disables the session shortcuts.
            nav.composerHasFocus = false
        }
        // Consume the pane-switch intent (⌃⌘C / ⌘T) and clear it so it fires once.
        .onChange(of: nav.paneIntent) { intent in
            guard let intent else { return }
            pane = intent
            nav.paneIntent = nil
        }
        // FIX #4: switching panes tears down the previous composer; reset focus so
        // a stale `true` doesn't survive the transition and disable the shortcuts.
        .onChange(of: pane) { _ in
            nav.composerHasFocus = false
        }
        // iOS/iPadOS/visionOS: no menu bar — carry the SESSION-scoped chords on
        // hidden zero-opacity buttons that exist only while this detail screen is
        // up. macOS routes the same chords through `MacCommands`, so guard with
        // `#if !os(macOS)` to avoid duplicate-shortcut registration.
        #if !os(macOS)
        .background(sessionShortcutButtons)
        #endif
    }

    #if !os(macOS)
    /// Hidden buttons carrying the session-screen keyboard chords. Each is
    /// `.disabled(nav.composerHasFocus)` so they go inert while a composer field
    /// is first responder (FIX #3) — letting the chords reach the composer.
    @ViewBuilder
    private var sessionShortcutButtons: some View {
        let typing = nav.composerHasFocus
        ZStack {
            Button("") { pane = .chat }
                .keyboardShortcut("c", modifiers: [.control, .command])
                .disabled(typing)
            Button("") { pane = .terminal }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(typing)
            Button("") { nav.step(-1) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(typing)
            Button("") { nav.step(1) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(typing)
            Button("") { nav.showQuickSwitcher = true }
                .keyboardShortcut("k", modifiers: .command)
                .disabled(typing)
        }
        .opacity(0)
        .accessibilityHidden(true)
    }
    #endif
}
