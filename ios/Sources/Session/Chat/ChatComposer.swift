import SwiftUI

/// Chat input composer bar at the bottom of the Chat tab.
///
/// Sends user messages as `in.chat` via the `onSend(sid, text)` callback,
/// which is wired to `RelayClient.sendInput(sid:kind:.chat text:)` by the
/// app host (SessionDetailView → ContentView → RelayClient). No relay ops are
/// added here — the existing send path is reused unchanged.
struct ChatComposer: View {
    let sid: String
    /// `(sid, text)` — matches the `onSend` signature in SessionDetailView.
    let onSend: (String, String) -> Void

    @State private var draft = ""
    @FocusState private var focused: Bool

    /// `true` when the session is no longer running. Disables input.
    var sessionStopped: Bool = false

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sessionStopped
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                // Multi-line text field — grows up to ~5 lines then scrolls.
                TextField(
                    sessionStopped ? "Session ended" : "Send a message…",
                    text: $draft,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .disabled(sessionStopped)
                .submitLabel(.send)
                .onSubmit {
                    // onSubmit fires only for single-line submit (Return key on
                    // iOS hardware keyboard). The user uses the button for multi-
                    // line messages. Keep this for fast single-line sends.
                    sendIfReady()
                }
                .accessibilityLabel("Message input")
                .accessibilityIdentifier("chat-input")

                // Send button
                Button(action: sendIfReady) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(canSend ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .accessibilityLabel("Send message")
                .accessibilityIdentifier("chat-send")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private func sendIfReady() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sessionStopped else { return }
        onSend(sid, trimmed)
        draft = ""
    }
}
