import type { ClaudeHookEvent } from "@teleprompter/protocol";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
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
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    // Sanitise hooks: if present, it must be a non-array object. Individual
    // event arrays that are not actually arrays are coerced to [] so that
    // `[...existingEntries, tpHookEntry]` never spreads a string char-by-char.
    const rawHooks = obj["hooks"];
    const hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> = {};
    if (
      rawHooks !== undefined &&
      typeof rawHooks === "object" &&
      rawHooks !== null &&
      !Array.isArray(rawHooks)
    ) {
      const rawHooksObj = rawHooks as Record<string, unknown>;
      for (const event of HOOK_EVENTS) {
        const val = rawHooksObj[event];
        hooks[event] = Array.isArray(val) ? (val as HookEntry[]) : [];
      }
    }
    return { ...obj, hooks } as SettingsJson;
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
