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
struct MacCommands: Commands {
    let pairings: PairingViewModel

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
