#if os(macOS)
import SwiftUI
import AppKit

/// macOS menu-bar commands (ADR-0002 Phase A4 — native macOS UX polish).
///
/// SwiftUI `.commands` attaches to the app `Scene`, so the whole macOS-specific
/// menu surface lives here behind `#if os(macOS)` — iOS never compiles this file
/// and its `TabView` shell is untouched.
///
/// Scope (A4): operate on the single active daemon, matching the current
/// single-daemon flow (the views already address `clients.values.first`). A
/// per-daemon selection menu lands with the N-daemon switcher.
///
/// - **New Pairing** (⌘N): surfaces how to pair (the app pairs via `tp://` deep
///   links opened by `tp pair`; there is no in-app QR scanner on macOS yet, so
///   this shows guidance rather than opening a sheet).
/// - **Disconnect** (⌘⌫): removes the active pairing (tears down its relay client).
/// - **Copy daemon id** (⌘⇧C): copies the active daemon id to the pasteboard.
/// - **Keyboard Shortcuts** (⌘/): opens the shortcut help sheet.
///
/// Navigation (ADR-0002 A4 keyboard nav): every keyboard-driven navigation
/// action mutates the shared `AppNavigationModel` so the menu bar and the
/// `MacRootView` sidebar/detail stay a single source of truth.
/// - **Tab nav** (⌘1/⌘2/⌘3): jump to Sessions / Daemons / Settings.
/// - **Session screen** — two gating tiers (all also require `hasActiveDetail`,
///   FIX #5): pane switches (⌃⌘C Chat, ⌘T Terminal) gate on `composerHasFocus`
///   only so they stay reachable from the terminal (the escape hatch); movement
///   chords (⌘[ Prev, ⌘] Next, ⌘K Quick Switch) gate on the full
///   `inputCapturing` — inert while typing in a composer (FIX #3) AND while the
///   Terminal pane owns the keyboard (FIX #6).
struct MacCommands: Commands {
    let pairings: PairingViewModel
    @Binding var showShortcutHelp: Bool
    /// Shared, app-wide navigation state (the single tab/pane/step source of
    /// truth). The menu bar drives it; `MacRootView` and `SessionDetailView`
    /// consume it. See `AppNavigationModel`.
    let nav: AppNavigationModel

    var body: some Commands {
        // Replace the default "New Item" (⌘N) slot with pairing-oriented actions
        // so the File menu speaks the app's vocabulary instead of a no-op New.
        CommandGroup(replacing: .newItem) {
            Button("New Pairing…") { showPairingHelp() }
                .keyboardShortcut("n", modifiers: .command)

            Divider()

            Button("Copy Daemon ID") { copyActiveDaemonId() }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(pairings.daemonIds.isEmpty)

            Button("Disconnect") { disconnectActive() }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(pairings.daemonIds.isEmpty)
        }

        // Tab navigation (⌘1/⌘2/⌘3). These stay active even while typing — they
        // switch the top-level tab, not the in-session pane — so they carry no
        // composer-focus guard. Placed after the sidebar group for a natural
        // View-menu ordering.
        CommandGroup(after: .sidebar) {
            Button("Sessions") { nav.selectedTab = .sessions }
                .keyboardShortcut("1", modifiers: .command)
            Button("Daemons") { nav.selectedTab = .daemons }
                .keyboardShortcut("2", modifiers: .command)
            Button("Settings") { nav.selectedTab = .settings }
                .keyboardShortcut("3", modifiers: .command)
        }

        // Session-screen navigation. Two gating tiers:
        //
        //  • Pane switches (⌃⌘C Chat, ⌘T Terminal) are the user's escape hatch
        //    OUT of the terminal, so they must stay reachable while the Terminal
        //    pane owns the keyboard — gate them only on `composerHasFocus ||
        //    !hasActiveDetail` (FIX #3 + #5). ⌃⌘C / ⌘T are distinct chords the PTY
        //    does not consume (Ctrl+C → SIGINT is ^C, not ⌃⌘C).
        //
        //  • Movement chords (⌘[ Prev, ⌘] Next, ⌘K Quick Switch) emit bracket/k
        //    keystrokes the terminal cares about and would silently swap the
        //    session mid-command, so they get the full `inputCapturing` gate —
        //    inert while a composer is focused AND while the Terminal pane owns
        //    the keyboard (FIX #6) — plus `!hasActiveDetail` (FIX #5).
        CommandMenu("Session") {
            Button("Chat") { nav.cyclePane(to: .chat) }
                .keyboardShortcut("c", modifiers: [.control, .command])
                .disabled(nav.composerHasFocus || !nav.hasActiveDetail)
            Button("Terminal") { nav.cyclePane(to: .terminal) }
                .keyboardShortcut("t", modifiers: .command)
                .disabled(nav.composerHasFocus || !nav.hasActiveDetail)

            Divider()

            Button("Previous Session") { nav.step(-1) }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(nav.inputCapturing || !nav.hasActiveDetail)
            Button("Next Session") { nav.step(1) }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(nav.inputCapturing || !nav.hasActiveDetail)

            Divider()

            Button("Quick Switch Session…") { nav.showQuickSwitcher = true }
                .keyboardShortcut("k", modifiers: .command)
                .disabled(nav.inputCapturing || !nav.hasActiveDetail)
        }

        // Help menu: Keyboard Shortcuts (⌘/).
        CommandGroup(after: .help) {
            Button("Keyboard Shortcuts") { showShortcutHelp = true }
                .keyboardShortcut("/", modifiers: .command)
        }
    }

    // MARK: - Actions

    /// The app is paired out-of-band via `tp pair` (which prints a `tp://` deep
    /// link / QR). There is no in-app scanner on macOS, so guide the user instead
    /// of opening a dead sheet.
    private func showPairingHelp() {
        let alert = NSAlert()
        alert.messageText = "Pair a new daemon"
        alert.informativeText = """
            Run `tp pair new` on the machine running the daemon, then open the \
            printed tp:// link on this Mac (it deep-links into Teleprompter).
            """
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func copyActiveDaemonId() {
        guard let did = pairings.daemonIds.first else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(did, forType: .string)
    }

    private func disconnectActive() {
        guard let did = pairings.daemonIds.first else { return }
        pairings.remove(did)
    }
}
#endif
