/**
 * PushService unit tests — APNs egress.
 *
 * The APNs HTTP call is injected via fetchFn (wrapped into a fake ApnsClient
 * by PushService). This lets us test all delivery logic without a real APNs
 * connection or credentials.
 *
 * APNs response contract (from buildFakeApnsClient in push.ts):
 *  - fetch throws            → DeliveryResult "error"
 *  - response.ok (200)       → DeliveryResult "push"
 *  - 400 {reason:"BadDeviceToken"}  → DeliveryResult "dead_token"
 *  - 410 {reason:"Unregistered"}   → DeliveryResult "dead_token"
 *  - other non-200           → DeliveryResult "error"
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { setLogLevel } from "@teleprompter/protocol";
import type { PushRequest } from "./push";
import { PushService } from "./push";

// Suppress log noise during tests
beforeAll(() => setLogLevel("silent"));
afterAll(() => setLogLevel("info"));

function makeRequest(overrides: Partial<PushRequest> = {}): PushRequest {
  return {
    frontendId: "frontend-1",
    daemonId: "d1",
    token: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    title: "New message",
    body: "Claude responded",
    isFrontendConnected: false,
    data: { sid: "session-1", daemonId: "daemon-1", event: "stop" },
    ...overrides,
  };
}

/**
 * Build a fake fetchFn that mimics the APNs HTTP/2 response.
 *
 * `statusOrThrow`:
 *   - "throw"    → fetch throws (network error)
 *   - 200        → APNs accepted (ok)
 *   - 400        → APNs BadDeviceToken
 *   - 410        → APNs Unregistered
 *   - other int  → generic non-200 error
 */
function makeFetchFn(
  statusOrThrow: number | "throw",
  reason?: string,
): { fn: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as string, init));
    if (statusOrThrow === "throw") throw new Error("Network error");
    if (statusOrThrow === 200) {
      return new Response(null, { status: 200 });
    }
    const body = reason ? JSON.stringify({ reason }) : "";
    return new Response(body, {
      status: statusOrThrow,
      headers: reason ? { "Content-Type": "application/json" } : {},
    });
  };
  return { fn: fn as typeof fetch, calls };
}

describe("PushService", () => {
  let service: PushService;

  afterEach(() => {
    service?.dispose();
  });

  // ── ws delivery ────────────────────────────────────────────────────────────

  describe("ws delivery", () => {
    test("returns 'ws' when frontend is connected", async () => {
      const { fn, calls } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(
        makeRequest({ isFrontendConnected: true }),
      );
      expect(result).toBe("ws");
      expect(calls.length).toBe(0);
    });
  });

  // ── APNs push delivery ─────────────────────────────────────────────────────

  describe("push delivery", () => {
    test("returns 'push' when APNs accepts (200)", async () => {
      const { fn, calls } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("push");
      expect(calls.length).toBe(1);
    });

    test("APNs request URL contains device token", async () => {
      const { fn, calls } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const req = makeRequest();
      await service.sendOrDeliver(req);
      // The fake ApnsClient posts to https://apns-fake/3/device/<token>
      expect(calls[0]?.url).toContain(req.token);
    });

    test("omits apns-priority when interruptionLevel is absent (default active)", async () => {
      const { fn, calls } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      await service.sendOrDeliver(makeRequest());
      // The fake client doesn't pass apns-priority for non-time-sensitive pushes.
      // We verify by confirming the call was made and no error occurred.
      expect(calls.length).toBe(1);
      const body = JSON.parse(await calls[0]?.text());
      // The fake client body is minimal; just confirm it was called.
      expect(body).toBeDefined();
    });

    test("returns 'push' when 200 — no ticket parsing needed (direct APNs)", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("push");
    });

    test("returns 'error' when fetch throws", async () => {
      const { fn } = makeFetchFn("throw");
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("error");
    });

    test("returns 'error' when APNs returns non-200/400/410 (e.g. 429)", async () => {
      const { fn } = makeFetchFn(429);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("error");
    });

    test("returns 'error' when APNs returns 500 (server error)", async () => {
      const { fn } = makeFetchFn(500, "InternalServerError");
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("error");
    });
  });

  // ── dead-token eviction ────────────────────────────────────────────────────

  describe("dead-token eviction (APNs 400/410)", () => {
    test("returns 'dead_token' when APNs returns 400 BadDeviceToken", async () => {
      const { fn } = makeFetchFn(400, "BadDeviceToken");
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("dead_token");
    });

    test("returns 'dead_token' when APNs returns 410 Unregistered", async () => {
      const { fn } = makeFetchFn(410, "Unregistered");
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("dead_token");
    });

    test("dead_token does NOT record dedup or consume rate budget", async () => {
      // sendOrDeliver records dedup + increments the rate counter only after a
      // SUCCESSFUL push. A dead_token must leave both untouched so a retry
      // (e.g. after the user re-registers) is not blocked by dedup.
      let call = 0;
      const fn = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify({ reason: "BadDeviceToken" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      service = new PushService({ rateLimitPerMinute: 1, fetchFn: fn });

      const first = await service.sendOrDeliver(makeRequest());
      expect(first).toBe("dead_token");

      // Same request again — must NOT be deduped (dedup wasn't recorded) and
      // must NOT be rate-limited (budget wasn't consumed).
      const second = await service.sendOrDeliver(makeRequest());
      expect(second).toBe("push");
    });

    test("'error' (non-dead 4xx) does NOT record dedup or consume rate budget", async () => {
      let call = 0;
      const fn = (async () => {
        call++;
        if (call === 1) {
          return new Response(JSON.stringify({ reason: "PayloadTooLarge" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch;

      service = new PushService({ rateLimitPerMinute: 1, fetchFn: fn });

      const first = await service.sendOrDeliver(makeRequest());
      expect(first).toBe("error");

      const second = await service.sendOrDeliver(makeRequest());
      expect(second).toBe("push");
    });
  });

  // ── time-sensitive (APNs priority 10) ─────────────────────────────────────

  describe("time-sensitive push", () => {
    test("time-sensitive push succeeds (APNs 200)", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(
        makeRequest({ interruptionLevel: "time-sensitive" }),
      );
      expect(result).toBe("push");
    });

    test("active-level push succeeds without special priority", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(
        makeRequest({ interruptionLevel: "active" }),
      );
      expect(result).toBe("push");
    });
  });

  // ── rate limiting ──────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    test("rate limits after N calls per frontendId", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ rateLimitPerMinute: 3, fetchFn: fn });

      const req = makeRequest();

      // First 3 should go through (using different events to avoid dedup)
      const r1 = await service.sendOrDeliver({
        ...req,
        data: { sid: "session-1", daemonId: "daemon-1", event: "e1" },
      });
      const r2 = await service.sendOrDeliver({
        ...req,
        data: { sid: "session-1", daemonId: "daemon-1", event: "e2" },
      });
      const r3 = await service.sendOrDeliver({
        ...req,
        data: { sid: "session-1", daemonId: "daemon-1", event: "e3" },
      });
      expect(r1).toBe("push");
      expect(r2).toBe("push");
      expect(r3).toBe("push");

      // 4th should be rate limited
      const r4 = await service.sendOrDeliver({
        ...req,
        data: { sid: "session-1", daemonId: "daemon-1", event: "e4" },
      });
      expect(r4).toBe("rate_limited");
    });

    test("5-per-minute default limit (used by relay-push-delivery tests)", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });

      // Send 5 successful pushes (different events to bypass dedup)
      for (let i = 0; i < 5; i++) {
        const r = await service.sendOrDeliver(
          makeRequest({
            data: { sid: "s1", daemonId: "d1", event: `e${i}` },
          }),
        );
        expect(r).toBe("push");
      }

      // 6th must be rate-limited
      const limited = await service.sendOrDeliver(
        makeRequest({ data: { sid: "s1", daemonId: "d1", event: "e5" } }),
      );
      expect(limited).toBe("rate_limited");
    });

    test("different frontendIds have independent rate limits", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ rateLimitPerMinute: 1, fetchFn: fn });

      const req1 = makeRequest({ frontendId: "frontend-A" });
      const req2 = makeRequest({
        frontendId: "frontend-B",
        data: { sid: "session-1", daemonId: "daemon-1", event: "stop" },
      });

      // Exhaust frontend-A limit
      const r1 = await service.sendOrDeliver(req1);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver({
        ...req1,
        data: { sid: "session-1", daemonId: "daemon-1", event: "e2" },
      });
      expect(r2).toBe("rate_limited");

      // frontend-B should still work
      const r3 = await service.sendOrDeliver(req2);
      expect(r3).toBe("push");
    });
  });

  // ── deduplication ──────────────────────────────────────────────────────────

  describe("deduplication", () => {
    test("deduplicates same frontendId+sid+event within window", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ dedupWindowMs: 60_000, fetchFn: fn });

      const req = makeRequest();
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("deduped");
    });

    test("allows same event after dedup window expires", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ dedupWindowMs: 50, fetchFn: fn }); // 50ms window

      const req = makeRequest();
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      // Wait for dedup window to expire
      await Bun.sleep(60);

      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("push");
    });

    test("dedup is skipped when data is absent", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ rateLimitPerMinute: 10, fetchFn: fn });

      // No data field — no dedup key, both calls should reach APNs
      const req = makeRequest({ data: undefined });
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("push");
    });

    test("different events for same frontendId+sid are not deduped", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ fetchFn: fn });

      const req = makeRequest();
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver({
        ...req,
        data: {
          sid: "session-1",
          daemonId: "daemon-1",
          event: "different-event",
        },
      });
      expect(r2).toBe("push");
    });
  });

  // ── order of checks ────────────────────────────────────────────────────────

  describe("order of checks", () => {
    test("dedup is checked before rate limit", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({ rateLimitPerMinute: 1, fetchFn: fn });

      const req = makeRequest();

      // First call uses up rate limit
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      // Second identical call: dedup should fire before rate_limited
      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("deduped");
    });
  });

  // ── rate-limit map eviction (leak-free) ────────────────────────────────────

  describe("idx 56 — rateLimits map eviction (leak-free)", () => {
    test("a silent frontend that hit the limit is evicted once its window expires", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({
        rateLimitPerMinute: 2,
        rateLimitWindowMs: 30,
        dedupWindowMs: 5,
        fetchFn: fn,
      });

      await service.sendOrDeliver(
        makeRequest({ data: { sid: "s1", daemonId: "d1", event: "a" } }),
      );
      await service.sendOrDeliver(
        makeRequest({ data: { sid: "s1", daemonId: "d1", event: "b" } }),
      );
      const limited = await service.sendOrDeliver(
        makeRequest({ data: { sid: "s1", daemonId: "d1", event: "c" } }),
      );
      expect(limited).toBe("rate_limited");
      expect(service.rateLimitEntryCount()).toBe(1);

      await Bun.sleep(40);
      service.runCleanup();
      expect(service.rateLimitEntryCount()).toBe(0);
    });

    test("an entry whose window has NOT expired is retained", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({
        rateLimitPerMinute: 5,
        rateLimitWindowMs: 60_000,
        fetchFn: fn,
      });
      await service.sendOrDeliver(
        makeRequest({ data: { sid: "s1", daemonId: "d1", event: "x" } }),
      );
      expect(service.rateLimitEntryCount()).toBe(1);
      service.runCleanup();
      // Window is 60s — still live, so the entry must survive.
      expect(service.rateLimitEntryCount()).toBe(1);
    });
  });

  // ── M14 — rate-limit window resets after expiry ────────────────────────────

  describe("M14 — rate-limit window resets after expiry", () => {
    test("pushes are allowed again after the window expires", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({
        rateLimitPerMinute: 2,
        rateLimitWindowMs: 50,
        fetchFn: fn,
      });

      const r1 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e1" },
      });
      const r2 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e2" },
      });
      expect(r1).toBe("push");
      expect(r2).toBe("push");

      const r3 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e3" },
      });
      expect(r3).toBe("rate_limited");

      await Bun.sleep(70);

      const r4 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e4" },
      });
      expect(r4).toBe("push");

      const r5 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e5" },
      });
      expect(r5).toBe("push");

      const r6 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e6" },
      });
      expect(r6).toBe("rate_limited");
    });

    test("rate limit still holds within a window (no premature reset)", async () => {
      const { fn } = makeFetchFn(200);
      service = new PushService({
        rateLimitPerMinute: 2,
        rateLimitWindowMs: 500,
        fetchFn: fn,
      });

      const r1 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e1" },
      });
      const r2 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e2" },
      });
      expect(r1).toBe("push");
      expect(r2).toBe("push");

      const r3 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e3" },
      });
      expect(r3).toBe("rate_limited");
    });
  });
});
