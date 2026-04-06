import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PushService } from "./push";
import type { PushRequest, PushServiceOptions } from "./push";

function makeRequest(overrides: Partial<PushRequest> = {}): PushRequest {
  return {
    frontendId: "frontend-1",
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
      expect(calls[0].url).toBe("https://exp.host/--/api/v2/push/send");
    });

    test("sends correct payload to Expo Push API", async () => {
      const { fn, calls } = makeFetchFn();
      service = new PushService({ fetchFn: fn });
      const req = makeRequest();
      await service.sendOrDeliver(req);
      const body = JSON.parse(await calls[0].text());
      expect(body.to).toBe(req.token);
      expect(body.title).toBe(req.title);
      expect(body.body).toBe(req.body);
      expect(body.data).toEqual(req.data);
      expect(body.sound).toBe("default");
    });

    test("returns 'error' when fetch throws", async () => {
      const { fn } = makeFetchFn(false);
      service = new PushService({ fetchFn: fn });
      const result = await service.sendOrDeliver(makeRequest());
      expect(result).toBe("error");
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
        data: { ...req.data!, event: "e1" },
      });
      const r2 = await service.sendOrDeliver({
        ...req,
        data: { ...req.data!, event: "e2" },
      });
      const r3 = await service.sendOrDeliver({
        ...req,
        data: { ...req.data!, event: "e3" },
      });
      expect(r1).toBe("push");
      expect(r2).toBe("push");
      expect(r3).toBe("push");

      // 4th should be rate limited
      const r4 = await service.sendOrDeliver({
        ...req,
        data: { ...req.data!, event: "e4" },
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
        data: { ...req1.data!, event: "e2" },
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
        data: { ...req.data!, event: "different-event" },
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
});
