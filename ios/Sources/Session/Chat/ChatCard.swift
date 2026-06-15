import SwiftUI

// MARK: - Timestamp formatter

private let tsFormatter: DateFormatter = {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = .none
    return f
}()

private func formattedTime(_ ts: Double) -> String {
    tsFormatter.string(from: Date(timeIntervalSince1970: ts))
}

// MARK: - Copy button

/// A small copy-to-clipboard button rendered at the top-right of a card.
private struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            copyToClipboard(text)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.caption2)
                .foregroundStyle(copied ? .green : .secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : "Copy message")
    }

    private func copyToClipboard(_ s: String) {
        #if os(iOS)
        UIPasteboard.general.string = s
        #elseif os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #endif
    }
}

// MARK: - User card

/// Renders a user-prompt card (right-aligned bubble, `PrePrompt` event).
/// The Chat tab is hooks-only: user messages come from `PrePrompt` hook
/// events — not from PTY io records (CLAUDE.md Key Design Decisions).
struct UserChatCard: View {
    let item: ChatItem

    /// `PrePrompt` carries the prompt text in `last_assistant_message` because
    /// that field is decoded from the event bytes by `SessionStore.chatItem`.
    /// When not available, fall back to a short label.
    private var promptText: String {
        if let msg = item.lastAssistantMessage, !msg.isEmpty { return msg }
        return "(user prompt)"
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 44)
            VStack(alignment: .trailing, spacing: 4) {
                HStack(alignment: .top, spacing: 8) {
                    CopyButton(text: promptText)
                    Text(promptText)
                        .font(.body)
                        .foregroundStyle(.white)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.accentColor)
                )
                Text(formattedTime(item.ts))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 4)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(promptText)")
    }
}

// MARK: - Assistant card

/// Renders Claude's response (left-aligned bubble, `Stop`/`StopFailure` events).
/// The `last_assistant_message` field of a `Stop` event is the canonical
/// assistant response (CLAUDE.md Key Design Decisions).
struct AssistantChatCard: View {
    let item: ChatItem
    let isFailure: Bool
    let text: String

    var body: some View {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            EmptyView()
        } else {
            HStack(alignment: .bottom, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    // Header row: label + copy + optional error badge
                    HStack(spacing: 6) {
                        if isFailure {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.yellow)
                                .font(.caption)
                        }
                        Text(isFailure ? "Claude (error)" : "Claude")
                            .font(.caption.bold())
                            .foregroundStyle(isFailure ? .yellow : Color.accentColor)
                        Spacer()
                        CopyButton(text: text)
                    }

                    ChatMarkdownView(text: text)
                        .foregroundStyle(.primary)

                    Text(formattedTime(item.ts))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(.regularMaterial)
                )
                Spacer(minLength: 44)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Claude: \(text)")
        }
    }
}

// MARK: - Tool card

/// Renders a tool invocation card (`PreToolUse` / `PostToolUse`).
struct ToolChatCard: View {
    let item: ChatItem
    let toolName: String
    let isDone: Bool

    var body: some View {
        HStack(spacing: 10) {
            // Status indicator dot
            Circle()
                .fill(isDone ? Color.green : Color.orange)
                .frame(width: 7, height: 7)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(toolName)
                        .font(.callout.monospaced())
                        .foregroundStyle(.primary)
                    Spacer()
                    // Status badge
                    Text(isDone ? "Done" : "Running")
                        .font(.caption2.bold())
                        .foregroundStyle(isDone ? .green : .orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule()
                                .fill((isDone ? Color.green : Color.orange).opacity(0.15))
                        )
                }
                Text(formattedTime(item.ts))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.regularMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(.quaternary, lineWidth: 0.5)
                )
        )
        .accessibilityLabel("Tool \(toolName), \(isDone ? "completed" : "running")")
    }
}

// MARK: - System / notification card

/// Renders a system notification card (catch-all for unknown hook events,
/// `Notification`, etc.). Centred pill style.
struct SystemChatCard: View {
    let item: ChatItem

    private var label: String {
        item.hookEventName
            .replacingOccurrences(of: "(?<!^)(?=[A-Z])", with: " ",
                                  options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    var body: some View {
        HStack {
            Spacer()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(.regularMaterial)
                )
            Spacer()
        }
        .accessibilityLabel(label)
    }
}

// MARK: - Streaming / working indicator

/// Animated "thinking" indicator while the assistant has not yet produced a
/// Stop event. Shown as a pulse when the last chat item in a running session
/// is not a Stop/StopFailure event.
struct AssistantWorkingIndicator: View {
    @State private var phase = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color.accentColor.opacity(phase ? 0.9 : 0.3))
                        .frame(width: 7, height: 7)
                        .animation(
                            .easeInOut(duration: 0.5)
                                .repeatForever()
                                .delay(Double(i) * 0.15),
                            value: phase
                        )
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.regularMaterial)
            )
            Spacer(minLength: 44)
        }
        .onAppear { phase = true }
        .accessibilityLabel("Claude is responding")
    }
}

// MARK: - Dispatch

/// Top-level card dispatcher: picks the correct card view for a `ChatItem`.
struct ChatItemCard: View {
    let item: ChatItem

    var body: some View {
        let kind = ChatEventCardKind(item: item)
        Group {
            switch kind {
            case .user:
                UserChatCard(item: item)
            case .assistant(let text, let isFailure):
                AssistantChatCard(item: item, isFailure: isFailure, text: text)
            case .toolRunning(let name):
                ToolChatCard(item: item, toolName: name, isDone: false)
            case .toolDone(let name):
                ToolChatCard(item: item, toolName: name, isDone: true)
            case .system:
                SystemChatCard(item: item)
            }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}
