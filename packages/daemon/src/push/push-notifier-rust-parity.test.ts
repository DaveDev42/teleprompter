/**
 * Differential push-gate parity gate (ADR-0003 Phase 4, daemon inc4).
 *
 * The daemon-side `PushNotifier.onRecord` decides, for each hook event, whether
 * to fan out an APNs push and — if so — with what interruption level, title, and
 * body. That decision has three pure, load-bearing pieces (push-notifier.ts):
 *   - the NOTIFY_EVENTS gate (`:224`): only {Notification, PermissionRequest,
 *     Elicitation} are notify-eligible; every other event is dropped.
 *   - the tokenCount>0 gate (`:230`): with no registered device token there is
 *     nobody to send to, so the push is suppressed.
 *   - `interruptionLevelFor` (`:61`) + `buildPushMessage` (`:254`): the wire
 *     interruption level ("active" / "time-sensitive") and the per-event
 *     title/body copy, including the Notification title regex-selection and the
 *     code-point-safe truncation (a classic Bun↔Rust multibyte divergence trap).
 *
 * During the dual-run window a Bun daemon and a Rust `tp-daemon` may each own
 * different pairings; if their notify gate or push copy diverges, one impl
 * pushes where the other stays silent (or shows different text) for the same
 * event — a user-visible split. So this is a DIFFERENTIAL FUNCTION gate: drive
 * the SAME (eventName × tokenCount × payload) table through the Bun decision and
 * the Rust port (via `tp-daemon-probe push-gate`) and assert the outputs are
 * byte-identical across a grid that exercises every branch.
 *
 * The Rust side is driven through the same `tp-daemon-probe` binary the store /
 * worktree / reconnect gates use. Degrades by SKIP (not FAIL) when the probe
 * binary has not been built — build it with
 * `(cd rust && cargo build --bin tp-daemon-probe)`. Mirrors the store /
 * worktree / reconnect / runner-parity SKIP-when-unbuilt precedent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROBE CONTRACT (tp-daemon-probe <verb> [args...])
 *   push-gate <eventName> <tokenCount> [payloadJson]
 *     → stdout: JSON {shouldNotify, level, title, body}
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { buildPushMessage, interruptionLevelFor } from "./push-notifier";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");

/**
 * The notify-eligible event set. Mirrors push-notifier.ts:25-29 (private const
 * NOTIFY_EVENTS) — the Rust probe replicates the same list independently, and
 * this gate asserts they agree on a grid that includes non-notify events.
 */
const NOTIFY_EVENTS = new Set([
  "Notification",
  "PermissionRequest",
  "Elicitation",
]);

/** The Bun-side push-gate decision, assembled from the module's exported pure fns. */
function bunGate(
  eventName: string,
  tokenCount: number,
  payload?: Record<string, unknown>,
): { shouldNotify: boolean; level: string; title: string; body: string } {
  const shouldNotify = NOTIFY_EVENTS.has(eventName) && tokenCount > 0;
  const level = interruptionLevelFor(eventName);
  const msg = buildPushMessage(eventName, payload);
  return { shouldNotify, level, title: msg.title, body: msg.body };
}

/** Prefer the release binary; fall back to debug. Returns null if neither built. */
function findProbe(): string | null {
  for (const profile of ["release", "debug"]) {
    const p = join(REPO_ROOT, "rust", "target", profile, "tp-daemon-probe");
    if (existsSync(p)) return p;
  }
  return null;
}

const probeBin = findProbe();

/** `push-gate` verb → the Rust decision {shouldNotify, level, title, body}. */
function rustGate(
  eventName: string,
  tokenCount: number,
  payload?: Record<string, unknown>,
): { shouldNotify: boolean; level: string; title: string; body: string } {
  const args = ["push-gate", eventName, String(tokenCount)];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  const r = spawnSync(probeBin as string, args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`probe ${args.join(" ")} failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout) as {
    shouldNotify: boolean;
    level: string;
    title: string;
    body: string;
  };
}

// Each case: an (eventName, tokenCount, payload) the daemon might see. The grid
// deliberately spans: every notify-eligible event, a non-notify event, the
// tokenCount==0 suppression, the Notification title regex arms (permission /
// wait-idle / generic), the PermissionRequest tool / no-tool arms, the
// Elicitation message / question / empty arms, and a multibyte-truncation case.
const CASES: Array<{
  name: string;
  event: string;
  tokens: number;
  payload?: Record<string, unknown>;
}> = [
  {
    name: "Notification / permission message / 2 tokens",
    event: "Notification",
    tokens: 2,
    payload: { message: "Claude needs your permission to use Bash" },
  },
  {
    name: "Notification / wait message / 1 token",
    event: "Notification",
    tokens: 1,
    payload: { message: "Waiting — idle for input" },
  },
  {
    name: "Notification / generic message / 1 token",
    event: "Notification",
    tokens: 1,
    payload: { message: "Something happened" },
  },
  {
    name: "Notification / empty message / 3 tokens (default body)",
    event: "Notification",
    tokens: 3,
    payload: { message: "   " },
  },
  {
    name: "Notification / no payload / 1 token",
    event: "Notification",
    tokens: 1,
  },
  {
    name: "Notification / tokenCount 0 (suppressed)",
    event: "Notification",
    tokens: 0,
    payload: { message: "nobody to send to" },
  },
  {
    name: "PermissionRequest / tool_name / 1 token",
    event: "PermissionRequest",
    tokens: 1,
    payload: { tool_name: "Bash" },
  },
  {
    name: "PermissionRequest / no tool_name / 2 tokens",
    event: "PermissionRequest",
    tokens: 2,
    payload: {},
  },
  {
    name: "PermissionRequest / long tool_name (truncated) / 1 token",
    event: "PermissionRequest",
    tokens: 1,
    payload: { tool_name: "x".repeat(300) },
  },
  {
    name: "Elicitation / message / 1 token",
    event: "Elicitation",
    tokens: 1,
    payload: { message: "Which file?" },
  },
  {
    name: "Elicitation / question fallback / 1 token",
    event: "Elicitation",
    tokens: 1,
    payload: { question: "Which branch?" },
  },
  {
    name: "Elicitation / empty (default body) / 1 token",
    event: "Elicitation",
    tokens: 1,
    payload: {},
  },
  {
    name: "Elicitation / multibyte truncation / 1 token",
    event: "Elicitation",
    tokens: 1,
    // 200 flag emoji (each a surrogate pair) — must truncate on a code-point
    // boundary identically in both impls (never a lone surrogate).
    payload: { message: "🇰🇷".repeat(200) },
  },
  {
    name: "non-notify event Stop / 5 tokens (suppressed, level active)",
    event: "Stop",
    tokens: 5,
    payload: {},
  },
  {
    name: "unknown event / 1 token (suppressed, safe default copy)",
    event: "SomethingElse",
    tokens: 1,
    payload: { message: "ignored" },
  },
];

const maybe = probeBin ? describe : describe.skip;

maybe("push-gate Bun↔Rust differential parity", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const bun = bunGate(c.event, c.tokens, c.payload);
      const rust = rustGate(c.event, c.tokens, c.payload);
      // Full struct equality: shouldNotify + level + title + body must match.
      expect(rust).toEqual(bun);
    });
  }

  test("gate is byte-identical across a tokenCount sweep for every notify event", () => {
    for (const event of [
      "Notification",
      "PermissionRequest",
      "Elicitation",
      "Stop",
    ]) {
      for (const tokens of [0, 1, 2, 7]) {
        const payload = { message: "sweep", tool_name: "Bash", question: "q?" };
        expect(rustGate(event, tokens, payload)).toEqual(
          bunGate(event, tokens, payload),
        );
      }
    }
  });
});
