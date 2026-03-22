import type { ClaudeHookEvent } from "@teleprompter/protocol";
import { captureHookCommand } from "./capture-hook";

const HOOK_EVENTS: ClaudeHookEvent[] = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Elicitation",
  "ElicitationResult",
];

interface HookEntry {
  matcher: string;
  hooks: { type: "command"; command: string; timeout: number }[];
}

interface SettingsJson {
  hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>>;
  [key: string]: unknown;
}

export function buildSettings(hookSocketPath: string): string {
  const command = captureHookCommand(hookSocketPath);
  const hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> = {};

  for (const event of HOOK_EVENTS) {
    hooks[event] = [
      {
        matcher: "",
        hooks: [{ type: "command", command, timeout: 10 }],
      },
    ];
  }

  const settings: SettingsJson = { hooks };
  return JSON.stringify(settings);
}
