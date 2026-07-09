import SwiftUI

/// Which pane is visible inside a session detail screen.
enum SessionPane: String, CaseIterable, Hashable {
    case chat, terminal

    var title: String {
        switch self {
        case .chat: return "Chat"
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

    // Per-session window pop-out (macOS + iPadOS). Same target scene the session
    // list's context menu uses — `openWindow(id:"session", value: sid)`. Gated
    // on `canPopOut` so the toolbar button appears on macOS + iPad but not on
    // iPhone. Re-opening the current session's window is harmless: SwiftUI dedups
    // by presentation value and just re-focuses the existing window.
    #if os(macOS) || os(iOS)
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    #endif
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

    /// Whether to offer the "Open in New Window" toolbar button. macOS: always.
    /// iPad (regular width, multi-scene capable): yes. iPhone: never. Mirrors
    /// `SessionListView.canPopOut` exactly.
    private var canPopOut: Bool {
        #if os(macOS)
        return true
        #elseif os(iOS)
        return supportsMultipleWindows && horizontalSizeClass == .regular
        #else
        return false
        #endif
    }

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

    /// BATCH F (#10/#15): the current disconnect/throttle cause for the
    /// session's daemon, if any — same single-daemon convenience as
    /// `daemonOnline` above.
    private var connectionCause: String? {
        guard let pairings, let did = pairings.daemonIds.first else { return nil }
        return pairings.connectionCause(for: did)
    }

    var body: some View {
        VStack(spacing: 0) {
            // H9: Connection banner — shows "Disconnected" / "Reconnected" with
            // VoiceOver live-region announcements. Always present in the hierarchy.
            ConnectionBanner(connected: daemonOnline, cause: connectionCause)

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
        // M1: Stop control — kills the Claude process for a running session.
        // Shown only when the session is running and a PairingViewModel is
        // available to route the `session.stop` relay control message. The new
        // state ("stopped") arrives via the daemon's `state` broadcast.
        .toolbar {
            if let pairings, sessionStore.sessions[sid]?.state == "running" {
                ToolbarItem(placement: .primaryAction) {
                    Button(role: .destructive) {
                        pairings.stopSession(sid, from: sessionStore)
                    } label: {
                        Label("Stop", systemImage: "stop.circle")
                    }
                    .disabled(!daemonOnline)
                    .accessibilityIdentifier("session-stop")
                }
            }
            // Pop this session into its own window/scene (macOS + iPad). Independent
            // of session state — always offered when the platform supports it. When
            // this detail is ALREADY a session window, re-opening the same sid just
            // re-focuses the existing window (SwiftUI dedups by presentation value),
            // so no guard against "already popped out" is needed.
            #if os(macOS) || os(iOS)
            if canPopOut {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        openWindow(id: "session", value: sid)
                    } label: {
                        Label("Open in New Window", systemImage: "macwindow.badge.plus")
                    }
                    .accessibilityIdentifier("session-popout-\(sid)")
                }
            }
            #endif
        }
        // FIX #5: gate macOS session commands — a detail screen is on-screen.
        // Depth-counted (detailAppeared/Disappeared) so the appear-before-
        // disappear order during a ⌘[/⌘] session swap can't strand the gate.
        .onAppear {
            nav.detailAppeared()
            // The terminal view owns the keyboard whenever the Terminal pane is
            // showing — seed the gate from the initial pane.
            nav.terminalPaneActive = (pane == .terminal)
        }
        .onDisappear {
            nav.detailDisappeared()
            // FIX #4: a torn-down composer can't fire its own focus-loss change,
            // so clear the flag here too — otherwise it stays stuck `true` and
            // permanently disables the session shortcuts.
            nav.composerHasFocus = false
            // The terminal is no longer on screen; release the terminal gate so
            // the session chords aren't left disabled after this detail closes.
            nav.terminalPaneActive = false
        }
        // Consume the pane-switch intent (⌃⌘C / ⌘T) and clear it so it fires once.
        .onChange(of: nav.paneIntent) { _, intent in
            guard let intent else { return }
            pane = intent
            nav.paneIntent = nil
        }
        // FIX #4: switching panes tears down the previous composer; reset focus so
        // a stale `true` doesn't survive the transition and disable the shortcuts.
        // Also track which pane owns the keyboard: the SwiftTerm view captures
        // every keystroke on the Terminal pane (FIX #6), so the session chords
        // must be inert there too — not just while a composer TextField is focused.
        .onChange(of: pane) { _, newPane in
            nav.composerHasFocus = false
            nav.terminalPaneActive = (newPane == .terminal)
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
    /// Hidden buttons carrying the session-screen keyboard chords. Two gating
    /// tiers mirror `MacCommands`:
    ///   • Pane switches (⌃⌘C / ⌘T) stay reachable while the Terminal pane owns
    ///     the keyboard — gated on `composerHasFocus` only — so they remain the
    ///     escape hatch out of the terminal (FIX #3).
    ///   • Movement chords (⌘[ / ⌘] / ⌘K) get the full `inputCapturing` gate so
    ///     they don't steal a keystroke from a focused composer (FIX #3) or the
    ///     terminal PTY (FIX #6).
    @ViewBuilder
    private var sessionShortcutButtons: some View {
        let composing = nav.composerHasFocus
        let capturing = nav.inputCapturing
        ZStack {
            Button("") { pane = .chat }
                .keyboardShortcut("c", modifiers: [.control, .command])
                .disabled(composing)
            Button("") { pane = .terminal }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(composing)
            Button("") { nav.step(-1) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(capturing)
            Button("") { nav.step(1) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(capturing)
            Button("") { nav.showQuickSwitcher = true }
                .keyboardShortcut("k", modifiers: .command)
                .disabled(capturing)
        }
        .opacity(0)
        .accessibilityHidden(true)
    }
    #endif
}
