import type { PushInterruptionLevel } from "@teleprompter/protocol";
import { createLogger } from "@teleprompter/protocol";
import type { ApnsClient } from "./apns";

const log = createLogger("Push");

const DEFAULT_RATE_LIMIT_PER_MINUTE = 5;
const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const DEDUP_CLEANUP_INTERVAL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;

export type DeliveryResult =
  | "ws"
  | "push"
  | "rate_limited"
  | "deduped"
  | "error"
  | "dead_token";

export interface PushRequest {
  frontendId: string;
  daemonId: string;
  /** Hex-encoded APNs device token. */
  token: string;
  title: string;
  body: string;
  isFrontendConnected: boolean;
  /**
   * iOS interruption level forwarded to APNs. Absent → "active"
   * (normal delivery, respects Focus). "time-sensitive" breaks through Focus /
   * DND when the user has allowed it, and additionally forces APNs priority 10
   * since a low-priority push can be deferred and would defeat the point of
   * time-sensitive.
   */
  interruptionLevel?: PushInterruptionLevel | undefined;
  data?: { sid: string; daemonId: string; event: string } | undefined;
}

export interface PushServiceOptions {
  rateLimitPerMinute?: number;
  dedupWindowMs?: number;
  /** Override the rate-limit window duration in ms (default: 60 000). For testing. */
  rateLimitWindowMs?: number;
  /**
   * APNs delivery client. Required in production; when absent, push delivery
   * returns "error" (used by unit tests that only exercise dedup/rate-limit).
   */
  apnsClient?: ApnsClient;
  /**
   * Override the raw HTTP fetch used internally by ApnsClient for testing.
   * When provided AND apnsClient is absent, a fake ApnsClient that delegates
   * to this fn is constructed so callers don't need to assemble the full
   * ApnsClient in tests.
   *
   * Deprecated for new code — prefer passing a real/fake ApnsClient directly.
   * Retained for test compatibility with the existing test harness.
   */
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
  private readonly apnsClient: ApnsClient | null;

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

    if (options.apnsClient) {
      this.apnsClient = options.apnsClient;
    } else if (options.fetchFn) {
      // Test shim: wrap a fetchFn in a minimal fake ApnsClient so existing
      // tests that inject fetchFn still work.
      this.apnsClient = buildFakeApnsClient(options.fetchFn);
    } else {
      this.apnsClient = null;
    }

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

    // Step 2: Dedup check + RESERVE. Check and write atomically within this
    // synchronous turn (before the await below), then roll back on failure.
    // If we only recorded on success — after the `await apnsClient.send` —
    // then N concurrent sendOrDeliver calls for the same key would all read
    // the same pre-commit snapshot, all pass the check, and all send,
    // breaking the one-notification-per-(sid,event) guarantee. Reserving here
    // makes the check-and-set atomic relative to other event-loop turns.
    const dedupKey = data
      ? `${frontendId}:${data.sid}:${data.event}`
      : undefined;
    if (dedupKey !== undefined) {
      const seenAt = this.dedupSeen.get(dedupKey);
      if (seenAt !== undefined && now - seenAt < this.dedupWindowMs) {
        log.debug(`deduped push for key ${dedupKey}`);
        return "deduped";
      }
      this.dedupSeen.set(dedupKey, now);
    }

    // Step 3: Rate limit check + RESERVE (increment now, roll back on failure).
    // M14 fix: if an existing window has expired, reset it now so that expired
    // state does not permanently bypass the limit on subsequent calls (whether
    // the push succeeds or fails). This ensures the count+windowStart are always
    // in a consistent "current window" state before the check runs.
    //
    // Same atomicity concern as dedup: incrementing only after the await would
    // let concurrent calls all observe a stale count and all pass the cap.
    // Reserve the slot synchronously here; roll back in the failure paths.
    let rl = this.rateLimits.get(rateLimitKey);
    if (rl && now - rl.windowStart >= this.rateLimitWindowMs) {
      // Window has expired — reset to a fresh window so the limit applies
      // correctly within the new window.
      rl.count = 0;
      rl.windowStart = now;
    }
    if (rl && rl.count >= this.rateLimitPerMinute) {
      log.warn(`rate limited push for frontendId ${frontendId}`);
      // Roll back the dedup reservation: this call did not consume a push.
      if (dedupKey !== undefined) this.dedupSeen.delete(dedupKey);
      return "rate_limited";
    }
    if (rl) {
      rl.count++;
    } else {
      rl = { count: 1, windowStart: now };
      this.rateLimits.set(rateLimitKey, rl);
    }

    // Helper: undo the dedup + rate-limit reservations on any failure path so a
    // failed attempt does not permanently suppress a later legitimate push.
    const rollbackReservation = (): void => {
      if (dedupKey !== undefined) this.dedupSeen.delete(dedupKey);
      // rl is guaranteed defined here (created/incremented just above).
      if (rl) rl.count = Math.max(0, rl.count - 1);
    };

    // Step 4: Call APNs
    if (!this.apnsClient) {
      log.warn(
        `APNs client not configured — cannot deliver push for frontendId ${frontendId}`,
      );
      rollbackReservation();
      return "error";
    }

    try {
      const result = await this.apnsClient.send({
        deviceToken: token,
        title,
        body,
        interruptionLevel,
        data,
      });

      if (!result.ok) {
        rollbackReservation();
        if (result.deadToken) {
          // APNs returned 400 (BadDeviceToken) or 410 (Unregistered): the token
          // is permanently dead. Signal the caller to evict it from the store.
          log.warn(
            `APNs dead token for frontendId ${frontendId}: ${result.reason}`,
          );
          return "dead_token";
        }
        log.warn(
          `APNs delivery error for frontendId ${frontendId}: ${result.reason}`,
        );
        return "error";
      }

      // Success: reservations made above stand (dedup recorded, rate counted).
      log.info(`push sent to frontendId ${frontendId}`);
      return "push";
    } catch (err) {
      log.warn(`push failed for frontendId ${frontendId}: ${err}`);
      rollbackReservation();
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

/**
 * Build a minimal fake ApnsClient that delegates HTTP calls to `fetchFn`.
 *
 * Used exclusively by PushServiceOptions.fetchFn for backward-compatible tests.
 * The fake interprets the HTTP response as follows:
 *  - fetch throws → return error
 *  - !response.ok → check body for {reason} and map to dead_token if
 *    reason is "BadDeviceToken" or "Unregistered", else return error
 *  - response.ok → return ok
 *
 * This mirrors the real ApnsClient.send() contract so existing test assertions
 * (`"push"`, `"error"`, `"dead_token"`) translate 1:1.
 */
function buildFakeApnsClient(fetchFn: typeof fetch): ApnsClient {
  return {
    send: async (payload: import("./apns").ApnsPayload) => {
      let response: Response;
      try {
        response = await fetchFn(
          `https://apns-fake/3/device/${payload.deviceToken}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceToken: payload.deviceToken }),
          },
        );
      } catch (err) {
        return { ok: false, deadToken: false, reason: String(err) };
      }

      if (response.ok) {
        await response.body?.cancel();
        return { ok: true };
      }

      let reason = `HTTP ${response.status}`;
      try {
        const json = (await response.json()) as { reason?: string };
        if (json?.reason) reason = json.reason;
      } catch {
        await response.body?.cancel();
      }

      const DEAD = new Set(["BadDeviceToken", "Unregistered"]);
      return { ok: false, deadToken: DEAD.has(reason), reason };
    },
  } as unknown as ApnsClient;
}
