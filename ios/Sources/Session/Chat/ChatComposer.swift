import SwiftUI

/// Chat input composer bar at the bottom of the Chat tab.
///
/// Sends user messages as `in.chat` via the `onSend(sid, text)` callback,
/// which is wired to `RelayClient.sendInput(sid:kind:.chat text:)` by the
/// app host (SessionDetailView → ContentView → RelayClient). No relay ops are
/// added here — the existing send path is reused unchanged.
///
/// Unlike `TerminalComposer` (which forwards raw keystrokes / control
/// sequences), the chat composer sends a whole *prompt* as one message:
/// multi-line, autocorrected, voice-enabled. The two share their input-line
/// look via `SessionComposerChrome` but keep their own input semantics.
///
/// Tranche G (Voice): hosts a `VoiceButton` to the left of the send button.
/// The `VoiceStore` is created lazily here so each chat session owns its own
/// voice state; it is wired to call `onSend(sid, refinedPrompt)` when a
/// refined prompt arrives from the Realtime API.
struct ChatComposer: View {
    let sid: String
    /// `(sid, text)` — matches the `onSend` signature in SessionDetailView.
    let onSend: (String, String) -> Void
    /// Injected so Voice can read the terminal viewport for context injection.
    var sessionStore: SessionStore? = nil

    @State private var draft = ""
    @FocusState private var focused: Bool
    /// Per-session voice store (created once, torn down with the view).
    @State private var voice = VoiceStore()

    /// `true` when the composer must refuse input — despite the name, this is
    /// really "cannot interact": the caller (`ChatView.sessionStopped`) sets it
    /// whenever the session state is terminal (`stopped`/`error`) OR the owning
    /// daemon is unreachable (see `ChatView` for the connectivity-wiring TODO).
    /// Disables the text field, the send button (via `canSend`), and the voice
    /// button — all three routes into `onSend`.
    var sessionStopped: Bool = false

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sessionStopped
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            SessionComposerChrome(
                canSend: canSend,
                onSend: sendIfReady,
                sendLabel: "Send message",
                leading: {
                    // Voice button (Tranche G) — hidden when no API key or session stopped.
                    VoiceButton(voice: voice, disabled: sessionStopped)
                },
                field: {
                    // Multi-line text field — grows up to ~5 lines then scrolls.
                    TextField(
                        sessionStopped ? "Can't send right now" : "Send a message…",
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
                }
            )
        }
        .background(.bar)
        .onAppear {
            // Wire up VoiceStore dependencies.
            voice.sessionStore = sessionStore
            voice.activeSid = sid
            // FIX #7 (Batch B): the voice button is visually disabled while
            // `sessionStopped`, but a prompt can still arrive here from an
            // in-flight recognition that started before the state flipped
            // (e.g. daemon went offline mid-utterance). Re-check at delivery
            // time so a stray prompt never fires into the void.
            voice.onPromptReady = { [sid] prompt in
                guard !self.sessionStopped else { return }
                onSend(sid, prompt)
            }
        }
        .onChange(of: sid) { _, newSid in
            voice.activeSid = newSid
            voice.onPromptReady = { prompt in
                guard !self.sessionStopped else { return }
                onSend(newSid, prompt)
            }
        }
        // Publish first-responder state so macOS/hardware-keyboard session
        // shortcuts (⌃⌘C/⌘T/⌘[/⌘]/⌘K) stay inert while the user is typing.
        .onChange(of: focused) { _, isFocused in
            AppNavigationModel.shared.composerHasFocus = isFocused
        }
        // FIX #4: a torn-down composer must not leave focus stuck `true`
        // (which would permanently disable the session shortcuts).
        .onDisappear {
            AppNavigationModel.shared.composerHasFocus = false
        }
    }

    /// FIX #4 (Batch B): `onSend` is fire-and-forget with no delivery ack (see
    /// `RelayClient.sendInput` — it can drop silently before kx completes, or
    /// on a network error, and only logs). We cannot detect *that* failure
    /// here. What we CAN guarantee is that a send blocked by a gate we DO
    /// know about (empty draft, or `sessionStopped` — stopped/errored session,
    /// or offline daemon once wired) never loses the user's text: the guard
    /// below returns before `onSend`/`draft = ""`, so the draft survives for
    /// the user to retry once the session/connection recovers.
    private func sendIfReady() {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !sessionStopped else { return }
        onSend(sid, trimmed)
        draft = ""
    }
}
