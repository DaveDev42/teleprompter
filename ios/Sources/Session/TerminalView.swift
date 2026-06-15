import SwiftUI

/// Terminal pane (ADR-0001 Phase 3, M5 → Tranche E interactive upgrade). Renders the
/// `k == "io"` byte stream for a session using a real VT100/xterm emulator
/// (SwiftTerm) and offers a composer for `in.chat` input.
///
/// When `sid` is provided (SessionDetailView), it shows exactly that session's
/// terminal. When `sid` is nil (legacy standalone use), it falls back to
/// `store.sessions.keys.sorted().first` so the smoke harness / direct use still works.
///
/// **ANSI emulation**: `SwiftTermView` handles cursor movement, SGR colour,
/// erase/clear, alt-screen, and scrollback.
///
/// **Interactive (Tranche E)**:
/// - Hardware keyboard input (iPad / macOS) routes through SwiftTerm's `send`
///   delegate → `store.terminalSendBytes` → `RelayClient.sendInput(kind:.term)`.
/// - The on-screen text composer sends `in.chat` lines via `onSend`.
/// - `sizeChanged` → `store.terminalResize` → `RelayClient.sendResize`.
/// - History backfill: `store.terminalHistory` is called at attach time to replay
///   io bytes already buffered by `RelayClient.ioHistory` before the view appeared.
///
/// The three relay callbacks are installed on `store` by `RelayClient` (Tranche E,
/// `TerminalOps.swift`) so `SessionDetailView` does not need to be changed.
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
    /// Sends a chat line (in.chat) into the given session. Wired to
    /// `RelayClient.sendInput(kind:.chat)` by the app; takes (sid, text).
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
                let sid = resolvedSid!
                SwiftTermView(
                    store: store,
                    sid: sid,
                    onSend: onSend,
                    onTermInput: { bytes in store.terminalSendBytes?(sid, bytes) },
                    onResize: { cols, rows in store.terminalResize?(sid, cols, rows) },
                    fetchHistory: { store.terminalHistory?(sid) }
                )
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
