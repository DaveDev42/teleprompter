/**
 * Boundary type guard for Claude Code hook events (hook socket → Runner).
 *
 * The runner's `HookReceiver` listens on a per-session Unix socket
 * (`hook-{sid}.sock`) and previously cast `JSON.parse(text)` straight to
 * `HookEventBase`, then immediately read `event.hook_event_name` and forwarded
 * the value into the record pipeline. A truncated payload, a hook from a
 * mismatched Claude Code version, or any object missing the discriminant would
 * sail through as a "valid" event with `undefined` where the collector expects
 * a string.
 *
 * This guard narrows the raw value to a `HookEventBase` — validating the three
 * fields the runner relies on (`hook_event_name` narrowed to the
 * `ClaudeHookEvent` union, `session_id`, `cwd`) — and returns `null` for
 * anything malformed. It is the hook-socket sibling of `parseIpcMessage`
 * (Runner↔Daemon IPC), but a separate function because `HookEventBase` is a
 * distinct open interface (it carries an arbitrary `[key: string]: unknown`
 * payload), not a member of the closed `IpcMessage` union.
 *
 * Unlike the closed-union guards, this one is deliberately *forgiving about
 * extra fields*: `HookEventBase` has an index signature, so the per-event
 * payload (`tool_name`, `tool_input`, `last_assistant_message`, …) rides
 * through unchanged. It validates the envelope, not the variant-specific body.
 */

import type { ClaudeHookEvent, HookEventBase } from "./types/event";

type PlainObject = { [key: string]: unknown };

function isObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOOK_EVENT_NAMES: ReadonlySet<ClaudeHookEvent> = new Set([
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
]);

function isHookEventName(v: unknown): v is ClaudeHookEvent {
  return typeof v === "string" && HOOK_EVENT_NAMES.has(v as ClaudeHookEvent);
}

/**
 * Parse a raw (JSON.parsed) hook-socket payload into a typed `HookEventBase`.
 * Returns `null` for a non-object, a missing/unknown `hook_event_name`, or a
 * missing `session_id`/`cwd`. The arbitrary per-event payload is preserved.
 */
export function parseHookEvent(raw: unknown): HookEventBase | null {
  if (!isObject(raw)) return null;
  if (!isHookEventName(raw["hook_event_name"])) return null;
  if (typeof raw["session_id"] !== "string") return null;
  if (typeof raw["cwd"] !== "string") return null;
  // The envelope is valid; `HookEventBase`'s index signature carries the rest
  // of the payload (tool_name, tool_input, …) through unchanged. We return the
  // original object — not a reconstruction — precisely because those extra
  // fields are part of the contract for the typed sub-interfaces (StopEvent,
  // PreToolUseEvent, …) that downstream code narrows to.
  return raw as HookEventBase;
}
