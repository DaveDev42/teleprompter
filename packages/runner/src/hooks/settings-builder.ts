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
  // Known events keyed by ClaudeHookEvent; unknown future/custom events stored
  // under additional string keys so they survive a round-trip through tp.
  hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> &
    Record<string, HookEntry[]>;
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
    // Widened to also accept unknown string keys so future/custom hook events
    // can be stored without a type error (see pass-through loop below).
    const hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> &
      Record<string, HookEntry[]> = {} as Partial<
      Record<ClaudeHookEvent, HookEntry[]>
    > &
      Record<string, HookEntry[]>;
    if (
      rawHooks !== undefined &&
      typeof rawHooks === "object" &&
      rawHooks !== null &&
      !Array.isArray(rawHooks)
    ) {
      const rawHooksObj = rawHooks as Record<string, unknown>;
      // Populate known events first (coerce non-arrays to [] for safety so
      // `[...existingEntries, tpHookEntry]` never spreads a string char-by-char).
      const knownSet = new Set<string>(HOOK_EVENTS);
      for (const event of HOOK_EVENTS) {
        const val = rawHooksObj[event];
        hooks[event] = Array.isArray(val) ? (val as HookEntry[]) : [];
      }
      // Preserve unknown hook event keys verbatim — a newer Claude Code version
      // or a custom hook event would otherwise be silently dropped when tp
      // rewrites the merged settings, causing data loss in the user's config.
      // Non-array values under unknown keys are skipped (junk guard).
      for (const key of Object.keys(rawHooksObj)) {
        if (!knownSet.has(key)) {
          const val = rawHooksObj[key];
          if (Array.isArray(val)) {
            hooks[key] = val as HookEntry[];
          }
        }
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

  // Merge: append TP hook entry to each known event's existing hooks.
  // Unknown event keys (preserved by readExistingSettings) are passed through
  // unchanged so user-defined custom hooks survive the round-trip.
  const hooks: Partial<Record<ClaudeHookEvent, HookEntry[]>> &
    Record<string, HookEntry[]> = { ...existingHooks };
  for (const event of HOOK_EVENTS) {
    const existingEntries = existingHooks[event] ?? [];
    hooks[event] = [...existingEntries, tpHookEntry];
  }

  // Preserve non-hooks fields from existing settings
  const settings: SettingsJson = { ...existing, hooks };
  return JSON.stringify(settings);
}
