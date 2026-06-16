import SwiftUI

/// Shared visual chrome for the Chat and Terminal composer *input lines*.
///
/// The two panes have *different input semantics* and therefore keep separate
/// composer types (`ChatComposer` sends whole prompts; `TerminalComposer`
/// forwards raw keystrokes / control sequences). What they share is the *look*
/// of the input line: a leading accessory slot, a rounded growing text field,
/// and a trailing circular send affordance. This struct centralises that line
/// so both composers read and feel identical without forcing one input model
/// onto the other.
///
/// Anything above the input line (the terminal key-row, a divider) is the
/// owning composer's responsibility — the chrome is intentionally just the
/// `[leading] [field] (⬆)` row.
///
/// Layout (left → right):
/// ```
/// [leading]  [ rounded text field … ]  ( ⬆ send )
/// ```
struct SessionComposerChrome<Leading: View, Field: View>: View {
    /// Leading accessory (voice button for chat, key-row toggle for terminal).
    /// Pass `EmptyView()` when none is needed.
    @ViewBuilder var leading: () -> Leading
    /// The text-entry control, owned by the caller so each composer keeps its
    /// own field configuration (multiline vs single-line, autocorrect, etc.).
    @ViewBuilder var field: () -> Field
    /// Whether the send button is enabled.
    let canSend: Bool
    /// Send action, invoked by the trailing button.
    let onSend: () -> Void
    /// Accessibility label for the send button (e.g. "Send message" / "Send line").
    var sendLabel: String = "Send"

    /// Ergonomic init: scalar args first, the two `@ViewBuilder` closures last so
    /// call sites can use trailing-closure syntax and read top-to-bottom.
    init(
        canSend: Bool,
        onSend: @escaping () -> Void,
        sendLabel: String = "Send",
        @ViewBuilder leading: @escaping () -> Leading,
        @ViewBuilder field: @escaping () -> Field
    ) {
        self.canSend = canSend
        self.onSend = onSend
        self.sendLabel = sendLabel
        self.leading = leading
        self.field = field
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            leading()

            field()

            Button(action: onSend) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(canSend ? Color.accentColor : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(sendLabel)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}
