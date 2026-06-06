import type { PushInterruptionLevel } from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("Push");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const DEFAULT_RATE_LIMIT_PER_MINUTE = 5;
const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const DEDUP_CLEANUP_INTERVAL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;

export type DeliveryResult =
  | "ws"
  | "push"
  | "rate_limited"
  | "deduped"
  | "error";

/**
 * A single push ticket as returned by the Expo Push API. For a single-message
 * send the response shape is `{ data: ExpoPushTicket }` historically, but Expo
 * actually returns `{ data: [ExpoPushTicket] }` (an array) — we tolerate both.
 * `status: "error"` carries a human `message` plus machine `details.error`
 * (e.g. "DeviceNotRegistered", "InvalidCredentials").
 */
interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Pull the ticket out of an Expo Push API 200 response, tolerating both the
 * array form (`{ data: [ticket] }`) and the bare-object form (`{ data: ticket }`).
 * Returns null if the body can't be parsed — caller treats that as "no ticket
 * error visible", since a malformed-but-200 body is not itself a delivery error.
 */
async function parseExpoTicket(
  response: Response,
): Promise<ExpoPushTicket | null> {
  try {
    const json = (await response.json()) as {
      data?: ExpoPushTicket | ExpoPushTicket[];
    };
    const data = json?.data;
    if (Array.isArray(data)) return data[0] ?? null;
    if (data && typeof data === "object") return data;
    return null;
  } catch {
    return null;
  }
}

export interface PushRequest {
  frontendId: string;
  daemonId: string;
  token: string;
  title: string;
  body: string;
  isFrontendConnected: boolean;
  /**
   * iOS interruption level forwarded to the Expo Push API. Absent → "active"
   * (normal delivery, respects Focus). "time-sensitive" breaks through Focus /
   * DND when the user has allowed it, and additionally forces APNs priority 10
   * (see the payload builder) since a low-priority push can be deferred and
   * would defeat the point of time-sensitive.
   */
  interruptionLevel?: PushInterruptionLevel;
  data?: { sid: string; daemonId: string; event: string };
}

export interface PushServiceOptions {
  rateLimitPerMinute?: number;
  dedupWindowMs?: number;
  /** Override the rate-limit window duration in ms (default: 60 000). For testing. */
  rateLimitWindowMs?: number;
  fetchFn?: typeof fetch;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class PushService {
  private readonly rateLimitPerMinute: number;
  private readonly dedupWindowMs: number;
  private readonly rateLimitWindowMs: number;
  private readonly fetchFn: typeof fetch;

  /** frontendId → rate limit state */
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  /** dedupKey → timestamp of first seen */
  private readonly dedupSeen = new Map<string, number>();

  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options: PushServiceOptions = {}) {
    this.rateLimitPerMinute =
      options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    this.dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;
    this.fetchFn = options.fetchFn ?? fetch;

    this.cleanupInterval = setInterval(() => {
      this.cleanupDedup();
    }, DEDUP_CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the interval is still running
    if (typeof this.cleanupInterval.unref === "function") {
      this.cleanupInterval.unref();
    }
  }

  async sendOrDeliver(req: PushRequest): Promise<DeliveryResult> {
    const {
      frontendId,
      daemonId,
      token,
      title,
      body,
      isFrontendConnected,
      interruptionLevel,
      data,
    } = req;
    const rateLimitKey = `${daemonId}:${frontendId}`;

    // Step 1: WebSocket delivery takes priority
    if (isFrontendConnected) {
      log.debug(`frontend ${frontendId} connected — skipping push`);
      return "ws";
    }

    const now = Date.now();

    // Step 2: Dedup check (don't record yet — only record on success)
    if (data) {
      const dedupKey = `${frontendId}:${data.sid}:${data.event}`;
      const seenAt = this.dedupSeen.get(dedupKey);
      if (seenAt !== undefined && now - seenAt < this.dedupWindowMs) {
        log.debug(`deduped push for key ${dedupKey}`);
        return "deduped";
      }
    }

    // Step 3: Rate limit check (don't increment yet — only increment on success).
    // M14 fix: if an existing window has expired, reset it now so that expired
    // state does not permanently bypass the limit on subsequent calls (whether
    // the push succeeds or fails). This ensures the count+windowStart are always
    // in a consistent "current window" state before the check runs.
    let rl = this.rateLimits.get(rateLimitKey);
    if (rl && now - rl.windowStart >= this.rateLimitWindowMs) {
      // Window has expired — reset to a fresh window so the limit applies
      // correctly within the new window.
      rl.count = 0;
      rl.windowStart = now;
    }
    if (rl && rl.count >= this.rateLimitPerMinute) {
      log.warn(`rate limited push for frontendId ${frontendId}`);
      return "rate_limited";
    }

    // Step 4: Call Expo Push API
    try {
      // interruptionLevel maps to APNs `aps.interruption-level`. For
      // time-sensitive we also lift priority to "high" (APNs priority 10):
      // a normal-priority push can be throttled/coalesced by the system, which
      // would defeat the whole point of breaking through Focus. "active" (the
      // default) is left without an explicit priority so Expo/APNs use their
      // own default. The fields are top-level on the Expo message, not nested
      // under ios/aps.
      const isTimeSensitive = interruptionLevel === "time-sensitive";
      const payload = {
        to: token,
        title,
        body,
        data,
        sound: "default",
        ...(interruptionLevel ? { interruptionLevel } : {}),
        ...(isTimeSensitive ? { priority: "high" as const } : {}),
      };
      const response = await this.fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        log.warn(
          `Expo Push API returned ${response.status} for frontendId ${frontendId}`,
        );
        // Drain the body so the underlying TCP connection returns to the fetch
        // keep-alive pool instead of being held open until GC.
        await response.body?.cancel();
        return "error";
      }

      // CRITICAL: Expo returns HTTP 200 even when it rejects the push (bad
      // token, missing/mismatched APNs credentials, etc.). The real verdict is
      // in the response ticket: `{ data: [{ status: "ok" | "error", ... }] }`.
      // Treating HTTP 200 as success (the old behavior) silently swallowed
      // DeviceNotRegistered / InvalidCredentials and made "sent but never
      // arrived" undiagnosable. Parse the ticket and surface errors loudly.
      const ticket = await parseExpoTicket(response);
      if (ticket && ticket.status === "error") {
        const reason = ticket.details?.error ?? "unknown";
        log.warn(
          `Expo push ticket error for frontendId ${frontendId}: ` +
            `${ticket.message ?? reason} (${reason})`,
        );
        return "error";
      }

      // Step 5: Record dedup + increment rate counter only after successful push
      if (data) {
        const dedupKey = `${frontendId}:${data.sid}:${data.event}`;
        this.dedupSeen.set(dedupKey, now);
      }

      if (rl) {
        // Window is already current (reset if expired above, or still fresh).
        rl.count++;
      } else {
        rl = { count: 1, windowStart: now };
        this.rateLimits.set(rateLimitKey, rl);
      }

      log.info(`push sent to frontendId ${frontendId}`);
      return "push";
    } catch (err) {
      log.warn(`push fetch failed for frontendId ${frontendId}: ${err}`);
      return "error";
    }
  }

  /**
   * Clean up expired dedup entries and stale rate-limit entries.
   *
   * dedupSeen entries are evicted when the dedup window has passed.
   *
   * rateLimits entries are evicted whenever the rate-limit window has expired,
   * regardless of count. An expired window carries no live budget — the next
   * push from that frontend simply re-creates the entry with a fresh window in
   * sendOrDeliver. Evicting only when count==0 (the old behavior) leaked: a
   * frontend that hit the limit (count>=max) and then went silent kept its
   * entry forever, because count is reset to 0 only inside sendOrDeliver, which
   * never runs again for a silent frontend. Window-expiry is the correct
   * liveness signal and prevents the map growing for every distinct
   * daemonId:frontendId pair that ever exceeded the limit.
   */
  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, seenAt] of this.dedupSeen) {
      if (now - seenAt >= this.dedupWindowMs) {
        this.dedupSeen.delete(key);
      }
    }
    for (const [key, rl] of this.rateLimits) {
      if (now - rl.windowStart >= this.rateLimitWindowMs) {
        this.rateLimits.delete(key);
      }
    }
  }

  /** Number of live rate-limit entries (for testing leak-free eviction). */
  rateLimitEntryCount(): number {
    return this.rateLimits.size;
  }

  /** Run the dedup/rate-limit cleanup pass synchronously (for testing). */
  runCleanup(): void {
    this.cleanupDedup();
  }

  /** Stop the background cleanup interval */
  dispose(): void {
    clearInterval(this.cleanupInterval);
  }
}
