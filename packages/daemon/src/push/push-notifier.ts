import {
  createLogger,
  type PushInterruptionLevel,
  type RecordKind,
} from "@teleprompter/protocol";

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

/**
 * Hook events that warrant a *time-sensitive* iOS interruption level — i.e.
 * notifications that should break through Focus / Do Not Disturb (when the user
 * has allowed time-sensitive notifications for the app). These are the
 * "Claude is blocked and needs you right now" events: a permission prompt, an
 * elicitation question, or the generic attention Notification. Missing one of
 * these means the agent sits idle until the user happens to check, so the
 * heightened delivery is justified.
 *
 * Events that are merely *informational* (e.g. a future Stop / completion
 * event — "your task finished") deliberately stay off this list and fall back
 * to the default "active" level, which respects Focus. Per-event
 * differentiation (rather than a blanket level) is the explicit design: urgent
 * events cut through, informational ones don't nag.
 *
 * Today this set equals NOTIFY_EVENTS because every event we currently push on
 * is attention-needed; it is kept as a separate set so adding an informational
 * NOTIFY_EVENT later only requires *not* adding it here.
 */
const TIME_SENSITIVE_EVENTS = new Set([
  "Notification",
  "PermissionRequest",
  "Elicitation",
]);

/**
 * Map a hook event name to the iOS interruption level its push should carry.
 * Pure + exported for unit testing. Defaults to "active" for anything not
 * explicitly marked time-sensitive.
 */
export function interruptionLevelFor(eventName: string): PushInterruptionLevel {
  return TIME_SENSITIVE_EVENTS.has(eventName) ? "time-sensitive" : "active";
}

interface PushMessage {
  title: string;
  body: string;
}

interface RecordInfo {
  sid: string;
  kind: RecordKind;
  name?: string | undefined;
  ns?: string | undefined;
  /**
   * Decoded JSON payload of the hook event (the raw object claude wrote to
   * stdin). Optional because callers that don't need message-derived
   * titles/bodies can omit it; we'll fall back to generic copy.
   */
  payload?: Record<string, unknown> | undefined;
}

export interface PushNotifierDeps {
  /**
   * Called to send (or queue) a push notification via the relay.
   * `sealed` is the opaque relay blob ("tpps1.<v>.<b64>") — daemon treats it
   * as opaque and never unwraps it. For legacy plaintext back-compat the
   * relay's unseal() returns the blob directly when it doesn't start with "tpps1.".
   */
  sendPush: (
    frontendId: string,
    sealed: string,
    title: string,
    body: string,
    interruptionLevel: PushInterruptionLevel,
    data: { sid: string; event: string },
  ) => void;
  /** Persist a newly registered sealed token to store for daemon-restart recovery. */
  persistToken: (
    frontendId: string,
    daemonId: string,
    sealed: string,
    platform: "ios" | "android",
  ) => void;
  /** Load all persisted sealed tokens on startup. */
  loadTokens: () => Array<{
    frontendId: string;
    daemonId: string;
    sealed: string;
    platform: "ios" | "android";
  }>;
  /** Delete a persisted token (e.g. on unseal failure or unregister). */
  deleteToken: (frontendId: string) => void;
}

/**
 * In-memory token entry. The daemon NEVER stores plaintext tokens after Path X
 * is active. `sealed` is the opaque blob from the relay.
 */
interface TokenEntry {
  sealed: string;
  platform: "ios" | "android";
  daemonId: string;
}

export class PushNotifier {
  private tokens = new Map<string, TokenEntry>();
  private deps: PushNotifierDeps;

  constructor(deps: PushNotifierDeps) {
    this.deps = deps;
    // Seed from persisted tokens on startup (daemon-restart recovery).
    const stored = deps.loadTokens();
    for (const t of stored) {
      this.tokens.set(t.frontendId, {
        sealed: t.sealed,
        platform: t.platform,
        daemonId: t.daemonId,
      });
    }
    if (stored.length > 0) {
      log.info(`seeded ${stored.length} push token(s) from store on startup`);
    }
  }

  /**
   * Register a sealed push token for a frontend. Stores in the in-memory Map
   * AND persists to store via deps.persistToken.
   *
   * For back-compat with old relays that never send relay.push.token, the
   * caller may pass a legacy plaintext token as `sealed` — the relay's
   * unseal() will classify it as "legacy" and use it verbatim.
   */
  registerSealedToken(
    frontendId: string,
    daemonId: string,
    sealed: string,
    platform: "ios" | "android",
  ): void {
    this.tokens.set(frontendId, { sealed, platform, daemonId });
    this.deps.persistToken(frontendId, daemonId, sealed, platform);
    log.info(
      `registered sealed push token for frontend ${frontendId} (${platform})`,
    );
  }

  unregisterToken(frontendId: string): void {
    this.tokens.delete(frontendId);
    this.deps.deleteToken(frontendId);
    log.info(`unregistered push token for frontend ${frontendId}`);
  }

  /**
   * Called when the relay replies with PUSH_UNSEAL_FAILED for a given
   * frontendId. Drops the stale entry from the Map and from the store so
   * future notification events don't keep sending to a dead token. The app
   * will re-register on next connect.
   */
  handleUnsealFailed(frontendId: string): void {
    if (!this.tokens.has(frontendId)) {
      log.debug(
        `handleUnsealFailed: no token for frontend ${frontendId}, ignoring`,
      );
      return;
    }
    this.tokens.delete(frontendId);
    this.deps.deleteToken(frontendId);
    log.warn(
      `dropped stale token for frontend ${frontendId} after PUSH_UNSEAL_FAILED`,
    );
  }

  /**
   * Called when the relay replies with PUSH_TOKEN_DEAD — APNs returned 400
   * (BadDeviceToken) or 410 (Unregistered). Drops the stale entry from the
   * Map and from the store so future notification events don't keep sending to
   * a permanently-dead APNs token. The app will re-register on next connect.
   *
   * The relay.err wire type does not carry a frontendId, so we drop ALL tokens
   * for this daemon and let them re-register. This is the same behaviour as
   * handleUnsealFailed — a known v1 limitation noted in the relay-client.
   */
  handleTokenDead(frontendId: string): void {
    if (!this.tokens.has(frontendId)) {
      log.debug(
        `handleTokenDead: no token for frontend ${frontendId}, ignoring`,
      );
      return;
    }
    this.tokens.delete(frontendId);
    this.deps.deleteToken(frontendId);
    log.warn(
      `dropped dead APNs token for frontend ${frontendId} after PUSH_TOKEN_DEAD`,
    );
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
    const level = interruptionLevelFor(rec.name);

    for (const [frontendId, entry] of this.tokens) {
      log.info(
        `sending push notification to ${frontendId} for event ${rec.name} sid=${rec.sid} level=${level}`,
      );
      this.deps.sendPush(frontendId, entry.sealed, msg.title, msg.body, level, {
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
      typeof payload?.["message"] === "string" ? payload["message"].trim() : "";
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
      typeof payload?.["tool_name"] === "string" ? payload["tool_name"] : null;
    return {
      title: "Permission needed",
      body: tool
        ? `Approve ${tool} to continue`
        : "Tool permission approval required",
    };
  }

  if (eventName === "Elicitation") {
    const question =
      typeof payload?.["message"] === "string"
        ? payload["message"]
        : typeof payload?.["question"] === "string"
          ? payload["question"]
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
