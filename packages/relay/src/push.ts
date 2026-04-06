import { createLogger } from "@teleprompter/protocol";

const log = createLogger("Push");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const DEFAULT_RATE_LIMIT_PER_MINUTE = 5;
const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const DEDUP_CLEANUP_INTERVAL_MS = 30_000;

export type DeliveryResult = "ws" | "push" | "rate_limited" | "deduped" | "error";

export interface PushRequest {
  frontendId: string;
  daemonId: string;
  token: string;
  title: string;
  body: string;
  isFrontendConnected: boolean;
  data?: { sid: string; daemonId: string; event: string };
}

export interface PushServiceOptions {
  rateLimitPerMinute?: number;
  dedupWindowMs?: number;
  fetchFn?: typeof fetch;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

export class PushService {
  private readonly rateLimitPerMinute: number;
  private readonly dedupWindowMs: number;
  private readonly fetchFn: typeof fetch;

  /** frontendId → rate limit state */
  private readonly rateLimits = new Map<string, RateLimitEntry>();

  /** dedupKey → timestamp of first seen */
  private readonly dedupSeen = new Map<string, number>();

  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(options: PushServiceOptions = {}) {
    this.rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    this.dedupWindowMs = options.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
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
    const { frontendId, daemonId, token, title, body, isFrontendConnected, data } = req;
    const rateLimitKey = `${daemonId}:${frontendId}`;

    // Step 1: WebSocket delivery takes priority
    if (isFrontendConnected) {
      log.debug(`frontend ${frontendId} connected — skipping push`);
      return "ws";
    }

    // Step 2: Dedup check
    if (data) {
      const dedupKey = `${frontendId}:${data.sid}:${data.event}`;
      const now = Date.now();
      const seenAt = this.dedupSeen.get(dedupKey);
      if (seenAt !== undefined && now - seenAt < this.dedupWindowMs) {
        log.debug(`deduped push for key ${dedupKey}`);
        return "deduped";
      }
    }

    // Step 3: Rate limit check
    const now = Date.now();
    const rl = this.rateLimits.get(rateLimitKey);
    if (rl && now - rl.windowStart < 60_000) {
      if (rl.count >= this.rateLimitPerMinute) {
        log.warn(`rate limited push for frontendId ${frontendId}`);
        return "rate_limited";
      }
    }

    // Step 4: Record dedup + increment rate counter
    if (data) {
      const dedupKey = `${frontendId}:${data.sid}:${data.event}`;
      this.dedupSeen.set(dedupKey, now);
    }

    if (rl && now - rl.windowStart < 60_000) {
      rl.count++;
    } else {
      this.rateLimits.set(rateLimitKey, { count: 1, windowStart: now });
    }

    // Step 5: Call Expo Push API
    try {
      const payload = { to: token, title, body, data, sound: "default" };
      const response = await this.fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        log.warn(`Expo Push API returned ${response.status} for frontendId ${frontendId}`);
        return "error";
      }

      log.info(`push sent to frontendId ${frontendId}`);
      return "push";
    } catch (err) {
      log.warn(`push fetch failed for frontendId ${frontendId}: ${err}`);
      return "error";
    }
  }

  /** Clean up expired dedup entries */
  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, seenAt] of this.dedupSeen) {
      if (now - seenAt >= this.dedupWindowMs) {
        this.dedupSeen.delete(key);
      }
    }
  }

  /** Stop the background cleanup interval */
  dispose(): void {
    clearInterval(this.cleanupInterval);
  }
}
