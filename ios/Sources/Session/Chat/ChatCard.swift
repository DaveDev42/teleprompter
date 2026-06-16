import SwiftUI
// ChatMarkdown.swift exports chatBodyFont(settings:) from the same module.

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

/// Renders a user-prompt card (right-aligned bubble, `UserPromptSubmit` event).
/// The Chat tab is hooks-only: user messages come from `UserPromptSubmit` hook
/// events — not from PTY io records (CLAUDE.md Key Design Decisions).
struct UserChatCard: View {
    let item: ChatItem
    let promptText: String // H2: carried from ChatEventCardKind.user(text:)

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 44)
            VStack(alignment: .trailing, spacing: 4) {
                HStack(alignment: .top, spacing: 8) {
                    CopyButton(text: promptText.isEmpty ? "(user prompt)" : promptText)
                    Text(promptText.isEmpty ? "(user prompt)" : promptText)
                        .font(chatBodyFont(settings: SettingsStore.shared))
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
        .accessibilityLabel("You: \(promptText.isEmpty ? "(user prompt)" : promptText)")
    }
}

// MARK: - Assistant card

/// Renders Claude's response (left-aligned bubble, `Stop`/`StopFailure` events).
/// The `last_assistant_message` field of a `Stop` event is the canonical
/// assistant response (CLAUDE.md Key Design Decisions).
/// For `StopFailure`, the `error` field is shown instead (L6).
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
/// For `PostToolUse`, shows a collapsed summary of `tool_input` and `tool_result`
/// when available (I1).
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

                // I1: Show tool_input/tool_result summary when available (PostToolUse only).
                if isDone {
                    if let input = item.toolInput, !input.isEmpty {
                        Text("in: \(input)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.tail)
                    }
                    if let result = item.toolResult, !result.isEmpty {
                        Text("out: \(result)")
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .truncationMode(.tail)
                    }
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

// MARK: - Permission card

/// Renders a permission request card (`PermissionRequest` event, M5).
/// Shown as a warning-style card with a lock icon and the tool name.
struct PermissionChatCard: View {
    let item: ChatItem
    let tool: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "lock.shield")
                .foregroundStyle(.orange)
                .font(.callout)

            VStack(alignment: .leading, spacing: 2) {
                Text("Permission requested")
                    .font(.caption.bold())
                    .foregroundStyle(.orange)
                Text(tool)
                    .font(.callout.monospaced())
                    .foregroundStyle(.primary)
                Text(formattedTime(item.ts))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.orange.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.orange.opacity(0.3), lineWidth: 0.5)
                )
        )
        .accessibilityLabel("Permission requested for \(tool)")
    }
}

// MARK: - Elicitation card

/// Renders an elicitation / input-requested card (`Elicitation` event, M5).
/// Shown as an info-style card indicating Claude is requesting user input.
struct ElicitationChatCard: View {
    let item: ChatItem
    let message: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "text.bubble")
                .foregroundStyle(Color.accentColor)
                .font(.callout)

            VStack(alignment: .leading, spacing: 2) {
                Text("Input requested")
                    .font(.caption.bold())
                    .foregroundStyle(Color.accentColor)
                if !message.isEmpty {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(formattedTime(item.ts))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            Spacer()
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
        .accessibilityLabel("Input requested: \(message)")
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
            case .user(let text):
                UserChatCard(item: item, promptText: text)
            case .assistant(let text, let isFailure):
                AssistantChatCard(item: item, isFailure: isFailure, text: text)
            case .toolRunning(let name):
                ToolChatCard(item: item, toolName: name, isDone: false)
            case .toolDone(let name):
                ToolChatCard(item: item, toolName: name, isDone: true)
            case .permission(let tool):
                PermissionChatCard(item: item, tool: tool)
            case .elicitation(let message):
                ElicitationChatCard(item: item, message: message)
            case .system:
                SystemChatCard(item: item)
            }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}
