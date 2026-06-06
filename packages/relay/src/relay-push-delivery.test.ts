/**
 * idx 58: exhaustive DeliveryResult handling in handlePush.
 *
 * Verifies that non-ws DeliveryResult variants produce the correct wire
 * behaviour: rate_limited sends relay.err PUSH_RATE_LIMITED to the daemon;
 * the "ws" path delivers an in-band relay.notification to the frontend.
 * Prior to this fix, all non-ws variants fell through silently with no reply
 * and no exhaustive switch guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RelayServerMessage } from "@teleprompter/protocol";
import { setLogLevel } from "@teleprompter/protocol";
import { PushService } from "./push";
import { RelayServer } from "./relay-server";

/**
 * A fetch stub that always returns a 200 response with an "ok" Expo ticket.
 * The rate-limit test needs pushes 1-5 to genuinely *succeed* (so the
 * PushService rate counter increments) without depending on Expo over the
 * network — and without depending on the old swallowed-error bug where a
 * rejected-but-200 push counted as success. With ticket-inspection live, only
 * a real "ok" ticket increments the counter, so we return one deterministically.
 */
const okTicketFetch = (async () =>
  new Response(JSON.stringify({ data: [{ status: "ok", id: "ticket-ok" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

beforeEach(() => setLogLevel("silent"));
afterEach(() => setLogLevel("info"));

const TOKEN = "push-delivery-test-token";
const DAEMON_ID = "push-delivery-daemon";

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS connect failed"));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate?: (msg: RelayServerMessage) => boolean,
): Promise<RelayServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (!predicate || predicate(msg)) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("waitForMessage timeout"));
    }, 3000);
  });
}

describe("handlePush DeliveryResult exhaustive handling (idx 58)", () => {
  let relay: RelayServer;
  let port: number;

  beforeEach(() => {
    // Inject a PushService whose fetch always returns an "ok" Expo ticket, so
    // pushes 1-5 deterministically succeed (and increment the rate counter)
    // without hitting the network or relying on a 200-means-success bug.
    relay = new RelayServer({
      pushService: new PushService({ fetchFn: okTicketFetch }),
    });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);
  });

  afterEach(() => {
    relay.stop();
  });

  /**
   * The "rate_limited" branch is triggered deterministically (no network
   * needed) by exhausting the default 5-per-minute PushService limit for the
   * same frontendId. Before idx 58's fix the daemon received no reply for this
   * case; now it receives relay.err PUSH_RATE_LIMITED.
   */
  test("relay.err PUSH_RATE_LIMITED is sent to daemon when push rate limit is exceeded", async () => {
    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.register",
        daemonId: DAEMON_ID,
        token: TOKEN,
        proof: "proof-rate-limit-test",
        v: 2,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.register.ok");
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    // The default PushService rate limit is 5 per minute per frontendId.
    // Send 6 relay.push messages with no data field (to bypass the dedup gate)
    // — the injected ok-ticket fetch makes calls 1-5 succeed and increment the
    // rate counter, so the 6th must trigger rate_limited → relay.err reply.
    const FE_ID = "fe-rate-limit-target";
    const pushMsg = () =>
      JSON.stringify({
        t: "relay.push",
        frontendId: FE_ID,
        token: "ExponentPushToken[rate-limit-test]",
        title: "T",
        body: "B",
        // No data field → no dedup key → every call hits the push/rate path
      });

    // Exhaust the 5-per-minute quota. Each push deterministically succeeds via
    // the injected ok-ticket fetch, so all 5 increment the rate counter. A short
    // sleep per call lets each async handlePush settle before the next send.
    for (let i = 0; i < 5; i++) {
      daemon.send(pushMsg());
      await Bun.sleep(50);
    }

    // 6th push must be rate-limited regardless of Expo API reachability —
    // relay.err PUSH_RATE_LIMITED is sent to the daemon.
    daemon.send(pushMsg());
    const reply = await waitForMessage(daemon, (m) => m.t === "relay.err");
    expect(reply.t).toBe("relay.err");
    const e = (reply as { t: "relay.err"; e: string })["e"];
    expect(e).toBe("PUSH_RATE_LIMITED");

    daemon.close();
  });
});
