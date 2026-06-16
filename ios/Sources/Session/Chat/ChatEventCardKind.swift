import Foundation

/// Semantic card kind derived from a Claude hook event name.
///
/// The Chat tab is **hooks-only** (CLAUDE.md): only `k == "event"` records
/// reach here. Each `hook_event_name` maps to a visual card style; unknown
/// events fall back to `.system`.
enum ChatEventCardKind {
    /// User prompt submitted to Claude (`UserPromptSubmit`).
    case user(text: String)
    /// Claude's final response text (`Stop` / `StopFailure`).
    /// - Parameters:
    ///   - text: The response text (last_assistant_message for Stop; error for StopFailure).
    ///   - isFailure: true when the event is `StopFailure`.
    case assistant(text: String, isFailure: Bool)
    /// A tool invocation in progress (`PreToolUse`).
    case toolRunning(name: String)
    /// A completed tool invocation (`PostToolUse`).
    case toolDone(name: String)
    /// A permission request requiring user approval (`PermissionRequest`).
    case permission(tool: String)
    /// An elicitation / input-requested event (`Elicitation`).
    case elicitation(message: String)
    /// Catch-all for `Notification` and any other hook events.
    case system

    /// Derive the card kind from a `ChatItem`.
    init(item: ChatItem) {
        switch item.hookEventName {
        case "UserPromptSubmit":
            // H2: real hook event name; carry the prompt text for the bubble.
            self = .user(text: item.prompt ?? "")
        case "Stop":
            self = .assistant(
                text: item.lastAssistantMessage ?? "",
                isFailure: false)
        case "StopFailure":
            // L6: error lives in `error` field, not last_assistant_message.
            self = .assistant(
                text: item.errorText ?? "Assistant response failed",
                isFailure: true)
        case "PreToolUse":
            self = .toolRunning(name: item.toolName ?? item.hookEventName)
        case "PostToolUse":
            self = .toolDone(name: item.toolName ?? item.hookEventName)
        case "PermissionRequest":
            // M5: render as distinct permission card; tool_name may be absent.
            self = .permission(tool: item.permissionTool ?? "unknown")
        case "Elicitation":
            // M5: render as distinct elicitation card.
            self = .elicitation(message: item.message ?? "Input requested")
        default:
            self = .system
        }
    }
}
