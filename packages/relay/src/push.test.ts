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
    token: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    title: "New message",
    body: "Claude responded",
    isFrontendConnected: false,
    data: { sid: "session-1", daemonId: "daemon-1", event: "stop" },
    ...overrides,
  };
}

function makeFetchFn(ok = true): { fn: typeof fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as string, init));
    if (!ok) throw new Error("Network error");
    return new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fn: fn as typeof fetch, calls };
}

describe("PushService", () => {
  let service: PushService;

  afterEach(() => {
    service?.dispose();
  });

  describe("ws delivery", () => {
    test("returns 'ws' when frontend is connected", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(
        makeRequest({ isFrontendConnected: true }),
      );
      expect(result).toBe("ws");
      expect(calls.length).toBe(0);
    });
  });

  describe("push delivery", () => {
    test("calls Expo Push API when frontend not connected", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("push");
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("https://exp.host/--/api/v2/push/send");
    });

    test("sends correct payload to Expo Push API", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      const req = makeRequest();
      await service.sendOrDeliver(req);
      const body = JSON.parse(await calls[0]!.text());
      expect(body.to).toBe(req.token);
      expect(body.title).toBe(req.title);
      expect(body.body).toBe(req.body);
      expect(body.data).toEqual(req.data);
      expect(body.sound).toBe("default");
    });

    test("omits interruptionLevel + priority when level is absent (default active)", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      await service.sendOrDeliver(makeRequest());
      const body = JSON.parse(await calls[0]!.text());
      expect(body.interruptionLevel).toBeUndefined();
      expect(body.priority).toBeUndefined();
    });

    test("forwards interruptionLevel + lifts priority to high for time-sensitive", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      await service.sendOrDeliver(
        makeRequest({ interruptionLevel: "time-sensitive" }),
      );
      const body = JSON.parse(await calls[0]!.text());
      expect(body.interruptionLevel).toBe("time-sensitive");
      // time-sensitive must ride APNs priority 10 or it can be deferred
      expect(body.priority).toBe("high");
    });

    test("forwards active interruptionLevel without lifting priority", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      await service.sendOrDeliver(makeRequest({ interruptionLevel: "active" }));
      const body = JSON.parse(await calls[0]!.text());
      expect(body.interruptionLevel).toBe("active");
      expect(body.priority).toBeUndefined();
    });

    test("returns 'error' when fetch throws", async () => {
      const { fn } = makeFetchFn(false);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("error");
    });

    test("returns 'error' when Expo API returns non-200", async () => {
      const service = new PushService({
        fetchFn: (async () =>
          new Response("Too Many Requests", {
            status: 429,
          })) as unknown as typeof fetch,
      });

      const result = await service.sendOrDeliver({
        frontendId: "f1",
        daemonId: "d1",
        token: "ExponentPushToken[abc]",
        title: "T",
        body: "B",
        isFrontendConnected: false,
      });

      expect(result).toBe("error");
      service.dispose();
    });
  });

  describe("rate limiting", () => {
    test("rate limits after N calls per frontendId", async () => {
      const { fn } = makeFetchFn();
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

    test("different frontendIds have independent rate limits", async () => {
      const { fn } = makeFetchFn();
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

  describe("deduplication", () => {
    test("deduplicates same frontendId+sid+event within window", async () => {
      const { fn } = makeFetchFn();
      service = new PushService({ dedupWindowMs: 60_000, fetchFn: fn });

      const req = makeRequest();
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("deduped");
    });

    test("allows same event after dedup window expires", async () => {
      const { fn } = makeFetchFn();
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
      const { fn } = makeFetchFn();
      service = new PushService({ rateLimitPerMinute: 10, fetchFn: fn });

      // No data field — no dedup key, both calls should reach Expo
      const req = makeRequest({ data: undefined });
      const r1 = await service.sendOrDeliver(req);
      expect(r1).toBe("push");

      const r2 = await service.sendOrDeliver(req);
      expect(r2).toBe("push");
    });

    test("different events for same frontendId+sid are not deduped", async () => {
      const { fn } = makeFetchFn();
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

  describe("order of checks", () => {
    test("dedup is checked before rate limit", async () => {
      const { fn } = makeFetchFn();
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

  describe("idx 56 — rateLimits map eviction (leak-free)", () => {
    test("a silent frontend that hit the limit is evicted once its window expires", async () => {
      const { fn } = makeFetchFn();
      service = new PushService({
        rateLimitPerMinute: 2,
        rateLimitWindowMs: 30,
        dedupWindowMs: 5,
        fetchFn: fn,
      });

      // Push until the frontend hits the rate limit (count >= max). The entry
      // is now in rateLimits with count=2 (>0) and is NOT reset, because the
      // frontend goes silent — sendOrDeliver (the only place count resets to 0)
      // is never called again for it.
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

      // Frontend goes silent. Old behavior (`&& rl.count === 0`) never evicted
      // this entry because count stayed at 2 forever. After the window expires,
      // cleanupDedup must evict it regardless of count.
      await Bun.sleep(40);
      service.runCleanup();
      expect(service.rateLimitEntryCount()).toBe(0);
    });

    test("an entry whose window has NOT expired is retained", async () => {
      const { fn } = makeFetchFn();
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

  describe("M14 — rate-limit window resets after expiry", () => {
    test("pushes are allowed again after the window expires", async () => {
      // Use a very short rate-limit window (50ms) and limit of 2 per window.
      const { fn } = makeFetchFn();
      service = new PushService({
        rateLimitPerMinute: 2,
        rateLimitWindowMs: 50,
        fetchFn: fn,
      });

      // Exhaust the limit within the first window (use different events to avoid dedup).
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

      // Third call within the same window must be rate-limited.
      const r3 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e3" },
      });
      expect(r3).toBe("rate_limited");

      // Wait for the window to expire.
      await Bun.sleep(70);

      // After expiry, pushes must be allowed again (new window, count = 0).
      const r4 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e4" },
      });
      expect(r4).toBe("push");

      // And the limit still holds within the new window.
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
      const { fn } = makeFetchFn();
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

      // Within the same window, a third push must still be rate-limited.
      const r3 = await service.sendOrDeliver({
        ...makeRequest(),
        data: { sid: "s1", daemonId: "d1", event: "e3" },
      });
      expect(r3).toBe("rate_limited");
    });
  });
});
