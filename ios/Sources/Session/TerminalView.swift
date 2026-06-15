import SwiftUI

/// The Terminal tab (ADR-0001 Phase 3, M5). Renders the raw `k == "io"` byte
/// stream for a session and offers a composer that sends `in.chat` input.
///
/// This is **raw byte append**, not a full ANSI terminal — escape sequences are
/// shown verbatim. Full emulation (SwiftTerm/libghostty) is a Phase 3.x
/// follow-up; M5's scope is "bytes append + input send" (native-phase3-plan.md).
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

    private var output: String {
        guard let sid else { return "" }
        return store.terminalOutput[sid] ?? ""
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
                    ScrollView {
                        ScrollViewReader { _ in
                            Text(output.isEmpty ? "(no output yet)" : output)
                                .font(.system(.caption, design: .monospaced))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                                .padding(8)
                                .accessibilityIdentifier("terminal-output")
                        }
                    }
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
