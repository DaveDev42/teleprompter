import SwiftUI

/// The Terminal tab (ADR-0001 Phase 3, M5 → A1 ANSI upgrade). Renders the
/// `k == "io"` byte stream for a session using a real VT100/xterm emulator
/// (SwiftTerm, Phase 3.x milestone A1) and offers a composer for `in.chat`
/// input.
///
/// **ANSI emulation (A1)**: `SwiftTermView` handles cursor movement, SGR
/// colour, erase/clear, alt-screen, and scrollback. The raw-byte `ScrollView`
/// + `Text` block has been replaced with `SwiftTermView`.
///
/// **Probe accumulator preserved**: `SessionStore.terminalOutput[sid]` (the
/// raw String accumulator used by `RelayClient.checkInputEcho` to detect the
/// `"tp-input-probe"` echo) is NOT rerouted through SwiftTerm.  Both paths run
/// independently — the probe/smoke invariant is unaffected by this upgrade.
/// PTY io lives here, never in Chat (CLAUDE.md: Chat is hooks-only).
struct TerminalView: View {
    @ObservedObject var store: SessionStore
    /// Sends a chat line into the given session. Wired to the relay client's
    /// `sendInput` by the app; takes (sid, text).
    let onSend: (String, String) -> Void

    @State private var draft = ""

    /// The session whose terminal we show. M5 renders the first known session
    /// (the one the relay client auto-attached); a session picker lands later.
    private var sid: String? {
        store.sessions.keys.sorted().first
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if sid == nil {
                    ContentUnavailableView(
                        "No session",
                        systemImage: "terminal",
                        description: Text("Attach a running session to see its terminal."))
                } else {
                    SwiftTermView(store: store, sid: sid!, onSend: onSend)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("terminal-output")
                    composer
                }
            }
            .navigationTitle("Terminal")
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Send to session…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .onSubmit(send)
                .accessibilityIdentifier("terminal-input")
            Button("Send", action: send)
                .disabled(draft.isEmpty || sid == nil)
        }
        .padding(8)
    }

    private func send() {
        guard let sid, !draft.isEmpty else { return }
        onSend(sid, draft)
        draft = ""
    }
}
