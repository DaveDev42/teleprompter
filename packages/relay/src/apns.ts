/**
 * APNs HTTP/2 delivery client.
 *
 * Sends a single push notification to the Apple Push Notification service via
 * the provider API (HTTP/2, token-based ES256 auth).
 *
 * References:
 *  - https://developer.apple.com/documentation/usernotifications/sending_notification_requests_to_apns
 *
 * Design notes:
 *  - The HTTP client is injected via `fetchFn` so all behaviour is fully
 *    unit-testable with a stub — no real network or APNs credentials needed in
 *    tests. The real implementation uses the global `fetch` (Bun supports
 *    HTTP/2 via `fetch` on the platform side, though note the HTTP/2 caveat in
 *    the commit body).
 *  - APNs error responses carry a JSON body `{ reason: string }`. We parse
 *    that to let callers distinguish dead-token codes (BadDeviceToken,
 *    Unregistered) from transient errors.
 *  - Env: APNS_HOST is derived from APNS_ENV ("sandbox" → api.sandbox.push.apple.com,
 *    anything else / "prod" → api.push.apple.com). The signer is injected so it
 *    is constructed once and shared across calls.
 */

import type { PushInterruptionLevel } from "@teleprompter/protocol";
import type { ApnsJwtSigner } from "./apns-jwt";

/**
 * APNs error reasons that indicate a permanently-dead device token. The relay
 * should signal the daemon to evict the token when it sees one of these.
 *
 * - `Unregistered` (410): the app was uninstalled or the user disabled push.
 * - `BadDeviceToken` (400): the token string is malformed or belongs to the
 *   wrong environment (sandbox vs. prod mismatch is the most common cause).
 *
 * All other codes are transient (rate limits, server errors, payload issues).
 */
export const APNS_DEAD_TOKEN_REASONS = new Set([
  "Unregistered",
  "BadDeviceToken",
]);

/**
 * Per-request deadline for an APNs HTTP/2 call. Bounds a hung request under an
 * APNs partition so it cannot hold an open stream + Promise chain indefinitely
 * (fd / async-task leak at 10k scale). 10s is generous for APNs, which
 * normally responds in tens of milliseconds.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export type ApnsDeliveryResult =
  | { ok: true }
  | { ok: false; deadToken: true; reason: string }
  | { ok: false; deadToken: false; reason: string };

export interface ApnsPayload {
  /** Hex-encoded APNs device token (from the iOS `deviceToken` registration callback). */
  deviceToken: string;
  /** Push title. */
  title: string;
  /** Push body. */
  body: string;
  /** Optional iOS interruption level. Absent → APNs default ("active"). */
  interruptionLevel?: PushInterruptionLevel | undefined;
  /** Optional navigation payload forwarded to the app. */
  data?: { sid: string; daemonId: string; event: string } | undefined;
}

export interface ApnsClientOptions {
  /** APNs hostname (e.g. api.sandbox.push.apple.com or api.push.apple.com). */
  host: string;
  /** APNs bundle ID — used as the `apns-topic` header. */
  bundleId: string;
  /** JWT signer that provides `authorization: bearer <jwt>`. */
  signer: ApnsJwtSigner;
  /** HTTP fetch implementation (injectable for testing). */
  fetchFn?: typeof fetch;
  /**
   * Per-request deadline in ms. Defaults to {@link REQUEST_TIMEOUT_MS}.
   * Overridable so tests can drive the real abort path with a tiny deadline
   * instead of waiting the full production timeout.
   */
  requestTimeoutMs?: number;
}

/**
 * Resolve the APNs host from the APNS_ENV environment variable.
 *   "sandbox" → api.sandbox.push.apple.com
 *   anything else / "prod" → api.push.apple.com
 */
export function resolveApnsHost(env?: string): string {
  return (env ?? "").toLowerCase() === "sandbox"
    ? "api.sandbox.push.apple.com"
    : "api.push.apple.com";
}

export class ApnsClient {
  private readonly opts: ApnsClientOptions;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(opts: ApnsClientOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async send(payload: ApnsPayload): Promise<ApnsDeliveryResult> {
    if (!/^[0-9a-f]{64}$/.test(payload.deviceToken)) {
      return { ok: false, deadToken: false, reason: "invalid-device-token" };
    }
    const jwt = await this.opts.signer.getToken();
    const isTimeSensitive = payload.interruptionLevel === "time-sensitive";

    // Build the APNs JSON payload (aps dictionary).
    const aps: Record<string, unknown> = {
      alert: { title: payload.title, body: payload.body },
      sound: "default",
      ...(payload.interruptionLevel
        ? { "interruption-level": payload.interruptionLevel }
        : {}),
    };

    const body: Record<string, unknown> = {
      aps,
      ...(payload.data ?? {}),
    };

    const url = `https://${this.opts.host}/3/device/${payload.deviceToken}`;

    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": this.opts.bundleId,
      "apns-push-type": "alert",
      "content-type": "application/json",
    };

    // APNs priority 10 (high / immediate delivery) is only set for
    // time-sensitive pushes — it overrides system heuristics to break through
    // Focus/DND. For normal "active" pushes we omit the header and let APNs
    // choose (default is 10 for alert pushes, but we honour the spec: only
    // override when we explicitly need time-sensitive behaviour).
    if (isTimeSensitive) {
      headers["apns-priority"] = "10";
    }

    // Bound the request with a deadline. APNs delivery is fire-and-forget at
    // the relay (handlePush .catch()), so without a timeout a network
    // partition would hold each HTTP/2 stream + Promise chain open until OS
    // TCP keepalive fires (minutes-to-hours) — at 10k scale a single external
    // failure mode becomes an fd / async-task leak. The existing catch below
    // already converts the thrown AbortError into a clean {ok:false} result.
    let response: Response;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      return { ok: false, deadToken: false, reason: String(err) };
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      // 200 = accepted by APNs.
      await response.body?.cancel();
      return { ok: true };
    }

    // Non-200: parse APNs error body for the reason code.
    let reason = `HTTP ${response.status}`;
    try {
      const json = (await response.json()) as { reason?: string };
      if (json?.reason) reason = json.reason;
    } catch {
      await response.body?.cancel();
    }

    const isDead = APNS_DEAD_TOKEN_REASONS.has(reason);
    return { ok: false, deadToken: isDead, reason };
  }
}
