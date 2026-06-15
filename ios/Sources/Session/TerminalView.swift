import SwiftUI

/// Terminal pane (ADR-0001 Phase 3, M5 → A1 ANSI upgrade). Renders the
/// `k == "io"` byte stream for a session using a real VT100/xterm emulator
/// (SwiftTerm, Phase 3.x milestone A1) and offers a composer for `in.chat` input.
///
/// When `sid` is provided (SessionDetailView), it shows exactly that session's
/// terminal. When `sid` is nil (legacy standalone use), it falls back to
/// `store.sessions.keys.sorted().first` so the smoke harness / direct use still works.
///
/// **ANSI emulation (A1)**: `SwiftTermView` handles cursor movement, SGR colour,
/// erase/clear, alt-screen, and scrollback.
///
/// **Probe accumulator preserved**: `SessionStore.terminalOutput[sid]` (the raw
/// String accumulator used by `RelayClient.checkInputEcho` to detect the
/// `"tp-input-probe"` echo) is NOT rerouted through SwiftTerm. Both paths run
/// independently — the probe/smoke invariant is unaffected by this upgrade.
/// PTY io lives here, never in Chat (CLAUDE.md: Chat is hooks-only).
struct TerminalView: View {
    @ObservedObject var store: SessionStore
    /// When non-nil, show exactly this session. When nil, fall back to first known.
    var sid: String? = nil
    /// Sends a chat line into the given session. Wired to the relay client's
    /// `sendInput` by the app; takes (sid, text).
    let onSend: (String, String) -> Void

    @State private var draft = ""

    /// Resolved session id: explicit `sid` param wins; fallback to first known session.
    private var resolvedSid: String? {
        if let sid { return sid }
        return store.sessions.keys.sorted().first
    }

    var body: some View {
        VStack(spacing: 0) {
            if resolvedSid == nil {
                ContentUnavailableView(
                    "No session",
                    systemImage: "terminal",
                    description: Text("Attach a running session to see its terminal."))
            } else {
                SwiftTermView(store: store, sid: resolvedSid!, onSend: onSend)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("terminal-output")
                composer
            }
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
                .disabled(draft.isEmpty || resolvedSid == nil)
        }
        .padding(8)
    }

    private func send() {
        guard let sid = resolvedSid, !draft.isEmpty else { return }
        onSend(sid, draft)
        draft = ""
    }
}
