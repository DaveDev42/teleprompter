export type ClaudeHookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "StopFailure"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionRequest"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "Elicitation"
  | "ElicitationResult";

export interface HookEventBase {
  session_id: string;
  hook_event_name: ClaudeHookEvent;
  cwd: string;
  [key: string]: unknown;
}

export interface StopEvent extends HookEventBase {
  hook_event_name: "Stop";
  last_assistant_message?: string;
}

export interface PreToolUseEvent extends HookEventBase {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
}

export interface PostToolUseEvent extends HookEventBase {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_result?: unknown;
}
