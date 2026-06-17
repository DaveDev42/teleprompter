import SwiftUI

/// Raw control sequences emitted by the terminal key-row.
///
/// Each case maps to the exact bytes a real terminal sends for that key, so the
/// remote PTY interprets them identically to a hardware keyboard. References:
/// ECMA-48 / xterm control sequences.
enum TerminalKey: Hashable {
    case escape          // \x1b
    case tab             // \x09
    case controlPrefix   // arms Ctrl- for the next typed character (handled in-composer)
    case up, down, left, right
    case literal(String) // a plain string inserted into the field (e.g. "/", "|")

    /// The bytes to send to the PTY for keys that emit directly. `nil` for keys
    /// handled in-composer (controlPrefix) or that insert into the text field
    /// (literal — those go through the field, not as raw bytes).
    var bytes: [UInt8]? {
        switch self {
        case .escape:  return [0x1b]
        case .tab:     return [0x09]
        case .up:      return Array("\u{1b}[A".utf8)
        case .down:    return Array("\u{1b}[B".utf8)
        case .right:   return Array("\u{1b}[C".utf8)
        case .left:    return Array("\u{1b}[D".utf8)
        case .controlPrefix, .literal:
            return nil
        }
    }

    /// SF Symbol or text shown on the key cap.
    var cap: String {
        switch self {
        case .escape:        return "esc"
        case .tab:           return "arrow.right.to.line"   // ⇥
        case .controlPrefix: return "control"
        case .up:            return "chevron.up"
        case .down:          return "chevron.down"
        case .left:          return "chevron.left"
        case .right:         return "chevron.right"
        case .literal(let s): return s
        }
    }

    /// Whether `cap` is an SF Symbol name (vs literal text).
    var capIsSymbol: Bool {
        switch self {
        case .tab, .up, .down, .left, .right, .controlPrefix: return true
        case .escape, .literal: return false
        }
    }

    var a11y: String {
        switch self {
        case .escape:        return "Escape"
        case .tab:           return "Tab"
        case .controlPrefix: return "Control modifier"
        case .up:            return "Up arrow"
        case .down:          return "Down arrow"
        case .left:          return "Left arrow"
        case .right:         return "Right arrow"
        case .literal(let s): return "Insert \(s)"
        }
    }
}

/// Practical accessory key-row for the Terminal composer (Blink/Termius-style).
///
/// Sends raw control sequences directly to the PTY via `sendBytes`, except:
///   - `.controlPrefix` arms a Ctrl modifier consumed by the *next* keystroke
///     (handled by the parent composer through `armControl`).
///   - `.literal` symbols are inserted into the text field via `insert`.
///
/// Horizontally scrollable so the full practical set fits on an iPhone width.
struct TerminalKeyRow: View {
    /// Whether the Ctrl modifier is currently armed (visual highlight).
    let controlArmed: Bool
    /// Emit raw bytes to the PTY.
    let sendBytes: ([UInt8]) -> Void
    /// Arm/toggle the Ctrl modifier for the next typed character.
    let armControl: () -> Void
    /// Insert a literal string into the text field.
    let insert: (String) -> Void
    /// Disabled when the session is stopped.
    var disabled: Bool = false

    /// The practical set, left → right.
    private let keys: [TerminalKey] = [
        .escape, .tab, .controlPrefix,
        .up, .down, .left, .right,
        .literal("/"), .literal("-"), .literal("~"), .literal("|"), .literal(":"),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(keys.enumerated()), id: \.offset) { _, key in
                    keyButton(key)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .background(.bar)
        .disabled(disabled)
        .accessibilityIdentifier("terminal-key-row")
    }

    @ViewBuilder
    private func keyButton(_ key: TerminalKey) -> some View {
        let armed = (key == .controlPrefix) && controlArmed
        Button {
            tap(key)
        } label: {
            Group {
                if key.capIsSymbol {
                    Image(systemName: key.cap)
                } else {
                    Text(key.cap)
                }
            }
            .font(.system(.subheadline, design: .monospaced))
            .frame(minWidth: 34, minHeight: 30)
            .padding(.horizontal, 4)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(armed ? Color.accentColor.opacity(0.85)
                                : Color.secondary.opacity(0.16))
            )
            .foregroundStyle(armed ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(key.a11y)
    }

    private func tap(_ key: TerminalKey) {
        switch key {
        case .controlPrefix:
            armControl()
        case .literal(let s):
            insert(s)
        default:
            if let b = key.bytes { sendBytes(b) }
        }
    }
}

/// Terminal input composer.
///
/// Unlike the Chat composer (which sends whole prompts as `in.chat`), this
/// composer forwards **raw keystrokes / control sequences** to the PTY:
///   - The text field forwards typed text byte-for-byte on submit (`in.term`
///     via `sendBytes`), with autocorrect/autocapitalisation disabled so code
///     and shell syntax are never mangled.
///   - The key-row (toggled by the leading keyboard button) emits Esc / Tab /
///     arrows / common symbols and an armable Ctrl modifier.
///   - Return sends a carriage return (`\r`) — the shell's line terminator.
///
/// `onSendChat` is retained for the rare case the user wants to send a line as
/// an `in.chat` message instead of raw bytes; it is wired to the same `onSend`
/// the rest of the app uses, but the default action is raw PTY forwarding.
struct TerminalComposer: View {
    let sid: String
    /// Send raw bytes to the PTY (`in.term`). Wired to `store.terminalSendBytes`.
    let sendBytes: ([UInt8]) -> Void
    /// Whether the session is stopped (read-only).
    var sessionStopped: Bool = false

    @State private var draft = ""
    @State private var showKeyRow = false
    /// When true, the next typed character is sent as a Ctrl- combination.
    @State private var controlArmed = false
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !draft.isEmpty && !sessionStopped
    }

    var body: some View {
        VStack(spacing: 0) {
            if showKeyRow {
                TerminalKeyRow(
                    controlArmed: controlArmed,
                    sendBytes: { bytes in
                        sendBytes(bytes)
                        controlArmed = false
                    },
                    armControl: { controlArmed.toggle() },
                    insert: { draft += $0 },
                    disabled: sessionStopped
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            Divider()

            SessionComposerChrome(
                canSend: canSend,
                onSend: sendLineRaw,
                sendLabel: "Send to terminal",
                leading: {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) { showKeyRow.toggle() }
                    } label: {
                        Image(systemName: showKeyRow ? "keyboard.chevron.compact.down" : "keyboard")
                            .font(.title3)
                            .foregroundStyle(showKeyRow ? Color.accentColor : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(sessionStopped)
                    .accessibilityLabel(showKeyRow ? "Hide key row" : "Show key row")
                    .accessibilityIdentifier("terminal-keyrow-toggle")
                },
                field: {
                    TextField(
                        sessionStopped ? "Session ended" : "Send to terminal…",
                        text: $draft
                    )
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    #if os(iOS) || os(visionOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.asciiCapable)
                    #endif
                    .focused($focused)
                    .disabled(sessionStopped)
                    .submitLabel(.return)
                    .onSubmit(sendLineRaw)
                    .accessibilityIdentifier("terminal-input")
                }
            )
        }
        .background(.bar)
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

    /// Forward the draft to the PTY as raw bytes followed by a carriage return.
    /// If Ctrl is armed and the draft is a single character, send the Ctrl-
    /// control code instead (e.g. armed + "c" → 0x03).
    private func sendLineRaw() {
        guard !sessionStopped else { return }
        if controlArmed, draft.count == 1, let ch = draft.first {
            if let code = controlCode(for: ch) {
                sendBytes([code])
            }
            controlArmed = false
            draft = ""
            return
        }
        guard !draft.isEmpty else { return }
        var bytes = Array(draft.utf8)
        bytes.append(0x0d) // carriage return — the shell line terminator
        sendBytes(bytes)
        draft = ""
    }

    /// Map a printable character to its Ctrl- control code (Ctrl-A = 1 … Ctrl-Z = 26).
    private func controlCode(for ch: Character) -> UInt8? {
        guard let ascii = ch.uppercased().first?.asciiValue,
              ascii >= 0x41, ascii <= 0x5a else { return nil }
        return ascii - 0x40 // 'A'(0x41) → 0x01
    }
}
