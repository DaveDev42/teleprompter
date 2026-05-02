import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PushNotifier");

/**
 * Hook events that should trigger a push notification on the user's device.
 *
 * Claude Code emits these for distinct attention-needed signals:
 * - `Notification` is the primary "user attention required" event. Claude
 *   fires it for permission prompts, idle timeouts, and other UI-blocking
 *   states. The payload carries a `message` string that we use to derive
 *   the push title/body.
 * - `PermissionRequest` is fired specifically when claude is about to ask
 *   the user to approve a tool invocation. It often (but not always)
 *   accompanies a Notification — we keep it on the list as a belt-and-
 *   suspenders signal so we still notify if Notification is somehow
 *   suppressed.
 * - `Elicitation` is fired when claude needs the user to answer a
 *   structured prompt (MCP elicitation flow).
 */
const NOTIFY_EVENTS = new Set([
  "Notification",
  "PermissionRequest",
  "Elicitation",
]);

interface PushMessage {
  title: string;
  body: string;
}

interface RecordInfo {
  sid: string;
  kind: string;
  name?: string;
  ns?: string;
  /**
   * Decoded JSON payload of the hook event (the raw object claude wrote to
   * stdin). Optional because callers that don't need message-derived
   * titles/bodies can omit it; we'll fall back to generic copy.
   */
  payload?: Record<string, unknown>;
}

export interface PushNotifierDeps {
  sendPush: (
    frontendId: string,
    token: string,
    title: string,
    body: string,
    data: { sid: string; event: string },
  ) => void;
}

interface TokenEntry {
  token: string;
  platform: "ios" | "android";
}

export class PushNotifier {
  private tokens = new Map<string, TokenEntry>();
  private deps: PushNotifierDeps;

  constructor(deps: PushNotifierDeps) {
    this.deps = deps;
  }

  registerToken(
    frontendId: string,
    token: string,
    platform: "ios" | "android",
  ): void {
    this.tokens.set(frontendId, { token, platform });
    log.info(`registered push token for frontend ${frontendId} (${platform})`);
  }

  unregisterToken(frontendId: string): void {
    this.tokens.delete(frontendId);
    log.info(`unregistered push token for frontend ${frontendId}`);
  }

  onRecord(rec: RecordInfo): void {
    if (rec.kind !== "event") return;
    if (!rec.name || !NOTIFY_EVENTS.has(rec.name)) return;

    const tokenCount = this.tokens.size;
    log.info(
      `notify-eligible event: name=${rec.name} sid=${rec.sid} tokens=${tokenCount}`,
    );
    if (tokenCount === 0) return;

    const msg = buildPushMessage(rec.name, rec.payload);

    for (const [frontendId, entry] of this.tokens) {
      log.info(
        `sending push notification to ${frontendId} for event ${rec.name} sid=${rec.sid}`,
      );
      this.deps.sendPush(frontendId, entry.token, msg.title, msg.body, {
        sid: rec.sid,
        event: rec.name,
      });
    }
  }
}

/**
 * Pure helper — exposed for testing — that turns a hook event name + raw
 * payload into the push notification copy. Centralised so the title/body
 * heuristics live in one place; the rules are intentionally simple and
 * conservative because claude's payload shape is loosely documented.
 */
export function buildPushMessage(
  eventName: string,
  payload?: Record<string, unknown>,
): PushMessage {
  if (eventName === "Notification") {
    const message =
      typeof payload?.message === "string" ? payload.message.trim() : "";
    if (message.length > 0) {
      // Claude's Notification "message" field already reads like a sentence
      // ("Claude needs your permission to use Bash"). Use it verbatim as
      // the body and pick a title that matches the broad intent.
      const title = /permission/i.test(message)
        ? "Permission needed"
        : /wait|idle/i.test(message)
          ? "Waiting for input"
          : "Claude needs attention";
      return { title, body: truncate(message, 178) };
    }
    return {
      title: "Claude needs attention",
      body: "Tap to open the session",
    };
  }

  if (eventName === "PermissionRequest") {
    const tool =
      typeof payload?.tool_name === "string" ? payload.tool_name : null;
    return {
      title: "Permission needed",
      body: tool
        ? `Approve ${tool} to continue`
        : "Tool permission approval required",
    };
  }

  if (eventName === "Elicitation") {
    const question =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.question === "string"
          ? payload.question
          : "";
    return {
      title: "Response needed",
      body:
        question.trim().length > 0
          ? truncate(question.trim(), 178)
          : "Claude is waiting for your answer",
    };
  }

  // Unknown — should not happen because callers filter on NOTIFY_EVENTS,
  // but provide a safe default.
  return {
    title: "Claude needs attention",
    body: "Tap to open the session",
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
