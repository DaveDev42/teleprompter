import { existsSync, readFileSync } from "fs";
import { join } from "path";
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

function readExistingSettings(cwd: string): SettingsJson | null {
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return null;
  try {
    return JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return null;
  }
}

export function buildSettings(hookSocketPath: string, cwd?: string): string {
  const command = captureHookCommand(hookSocketPath);
  const tpHookEntry: HookEntry = {
    matcher: "",
    hooks: [{ type: "command", command, timeout: 10 }],
  };

  // Read existing project settings
  const existing = cwd ? readExistingSettings(cwd) : null;
  const existingHooks = existing?.hooks ?? {};

  // Merge: append TP hook entry to each event's existing hooks
  const hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> = {};
  for (const event of HOOK_EVENTS) {
    const existingEntries = existingHooks[event] ?? [];
    hooks[event] = [...existingEntries, tpHookEntry];
  }

  // Preserve non-hooks fields from existing settings
  const settings: SettingsJson = { ...existing, hooks };
  return JSON.stringify(settings);
}
