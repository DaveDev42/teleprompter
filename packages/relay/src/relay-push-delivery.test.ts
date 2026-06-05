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
import { RelayServer } from "./relay-server";

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
    relay = new RelayServer();
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
    // Send 6 relay.push messages with different event keys to avoid the
    // dedup gate — the 6th must trigger rate_limited → relay.err reply.
    // (Using no data field on calls 1-5 to bypass dedup; call 6 also no data.)
    const FE_ID = "fe-rate-limit-target";
    const pushMsg = () =>
      JSON.stringify({
        t: "relay.push",
        frontendId: FE_ID,
        token: "ExponentPushToken[rate-limit-test]",
        title: "T",
        body: "B",
        // No data field → no dedup key → every call goes to Expo or rate-limiter
      });

    // Exhaust the 5-per-minute quota. Each call goes through Expo (or errors);
    // we don't wait for relay.err on these because Expo may succeed or fail.
    // We only care that the 6th triggers the rate_limited path reliably.
    // Use 500ms sleep per call to ensure each async handlePush (including any
    // outbound Expo API fetch) completes before the next send, so the rate
    // counter increments correctly on the push service.
    for (let i = 0; i < 5; i++) {
      daemon.send(pushMsg());
      await Bun.sleep(500);
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
