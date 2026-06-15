import Foundation

/// Semantic card kind derived from a Claude hook event name.
///
/// The Chat tab is **hooks-only** (CLAUDE.md): only `k == "event"` records
/// reach here. Each `hook_event_name` maps to a visual card style; unknown
/// events fall back to `.system`.
enum ChatEventCardKind {
    /// User prompt submitted to Claude (`PrePrompt`).
    case user
    /// Claude's final response text (`Stop` / `StopFailure`).
    /// - Parameters:
    ///   - text: The `last_assistant_message` string (may be empty).
    ///   - isFailure: true when the event is `StopFailure`.
    case assistant(text: String, isFailure: Bool)
    /// A tool invocation in progress (`PreToolUse`).
    case toolRunning(name: String)
    /// A completed tool invocation (`PostToolUse`).
    case toolDone(name: String)
    /// Catch-all for `Notification` and any other hook events.
    case system

    /// Derive the card kind from a `ChatItem`.
    init(item: ChatItem) {
        switch item.hookEventName {
        case "PrePrompt":
            self = .user
        case "Stop":
            self = .assistant(
                text: item.lastAssistantMessage ?? "",
                isFailure: false)
        case "StopFailure":
            self = .assistant(
                text: item.lastAssistantMessage ?? "",
                isFailure: true)
        case "PreToolUse":
            self = .toolRunning(name: item.toolName ?? item.hookEventName)
        case "PostToolUse":
            self = .toolDone(name: item.toolName ?? item.hookEventName)
        default:
            self = .system
        }
    }
}
