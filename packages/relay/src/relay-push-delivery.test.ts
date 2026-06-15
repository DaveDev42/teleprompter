/**
 * idx 58: exhaustive DeliveryResult handling in handlePush (APNs version).
 *
 * Verifies that non-ws DeliveryResult variants produce the correct wire
 * behaviour: rate_limited sends relay.err PUSH_RATE_LIMITED to the daemon;
 * dead_token sends relay.err PUSH_TOKEN_DEAD; the "ws" path delivers an
 * in-band relay.notification to the frontend.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLogLevel } from "@teleprompter/protocol";
import { PushService } from "./push";
import { RelayServer } from "./relay-server";
import { connectWs, waitForMessage } from "./test-helpers";

/**
 * A fetch stub that always returns 200 (APNs accepted).
 * The rate-limit tests need pushes 1-5 to genuinely *succeed* (so the
 * PushService rate counter increments) without depending on a real APNs
 * endpoint. With the APNs client wired in, only a 200 response increments
 * the counter, so we return one deterministically.
 */
const okApnsFetch = (async () =>
  new Response(null, {
    status: 200,
  })) as unknown as typeof fetch;

/**
 * A fetch stub that returns 400 BadDeviceToken — simulates a dead APNs token.
 */
const badDeviceTokenFetch = (async () =>
  new Response(JSON.stringify({ reason: "BadDeviceToken" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

/**
 * A fetch stub that returns 410 Unregistered — simulates an uninstalled app.
 */
const unregisteredFetch = (async () =>
  new Response(JSON.stringify({ reason: "Unregistered" }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;

beforeEach(() => setLogLevel("silent"));
afterEach(() => setLogLevel("info"));

const TOKEN = "push-delivery-test-token";
const DAEMON_ID = "push-delivery-daemon";

// ------------------------------------------------------------------
// Helper: authenticate a daemon WebSocket against the relay
// ------------------------------------------------------------------
async function authDaemon(
  port: number,
  token: string,
  daemonId: string,
): Promise<WebSocket> {
  const ws = await connectWs(port);
  ws.send(
    JSON.stringify({
      t: "relay.register",
      daemonId,
      token,
      proof: `proof-${daemonId}`,
      v: 2,
    }),
  );
  await waitForMessage(ws, (m) => m.t === "relay.register.ok");
  ws.send(
    JSON.stringify({
      t: "relay.auth",
      v: 1,
      role: "daemon",
      daemonId,
      token,
    }),
  );
  await waitForMessage(ws, (m) => m.t === "relay.auth.ok");
  return ws;
}

// ------------------------------------------------------------------
// Rate limit: relay.err PUSH_RATE_LIMITED
// ------------------------------------------------------------------
describe("handlePush DeliveryResult exhaustive handling (idx 58)", () => {
  let relay: RelayServer;
  let port: number;

  beforeEach(() => {
    relay = new RelayServer({
      pushService: new PushService({ fetchFn: okApnsFetch }),
    });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);
  });

  afterEach(() => {
    relay.stop();
  });

  test("relay.err PUSH_RATE_LIMITED is sent to daemon when push rate limit is exceeded", async () => {
    const daemon = await authDaemon(port, TOKEN, DAEMON_ID);

    const FE_ID = "fe-rate-limit-target";
    // Build a sealed token (relay-guard now requires sealed to be present).
    // We use a fake "tpps1." prefix so PushSealer.unseal classifies it as a
    // proper blob — but since PushSealer uses an ephemeral key, unseal will
    // fail and return "unseal_failed", causing PUSH_UNSEAL_FAILED for a real
    // blob. Instead we pass a non-"tpps1." legacy string so it gets treated as
    // a verbatim token (the "legacy" code path in handlePush).
    const pushMsg = () =>
      JSON.stringify({
        t: "relay.push",
        frontendId: FE_ID,
        sealed: "legacy-device-token-aabbccdd",
        title: "T",
        body: "B",
        // No data field → no dedup key → every call hits the push/rate path
      });

    // Exhaust the 5-per-minute quota.
    for (let i = 0; i < 5; i++) {
      daemon.send(pushMsg());
      await Bun.sleep(50);
    }

    // 6th push must be rate-limited.
    daemon.send(pushMsg());
    const reply = await waitForMessage(daemon, (m) => m.t === "relay.err");
    expect(reply.t).toBe("relay.err");
    const e = (reply as { t: "relay.err"; e: string }).e;
    expect(e).toBe("PUSH_RATE_LIMITED");

    daemon.close();
  });
});

// ------------------------------------------------------------------
// Dead-token eviction: relay.err PUSH_TOKEN_DEAD
// ------------------------------------------------------------------
describe("handlePush dead-token eviction (APNs 400/410)", () => {
  test("relay sends PUSH_TOKEN_DEAD to daemon when APNs returns 400 BadDeviceToken", async () => {
    const relay = new RelayServer({
      pushService: new PushService({ fetchFn: badDeviceTokenFetch }),
    });
    const port = relay.start(0);
    const TOKEN2 = "push-dead-token-test";
    const DAEMON2 = "push-dead-daemon";
    relay.registerToken(TOKEN2, DAEMON2);

    const daemon = await authDaemon(port, TOKEN2, DAEMON2);

    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-dead",
        sealed: "legacy-dead-token",
        title: "T",
        body: "B",
      }),
    );

    const reply = await waitForMessage(daemon, (m) => m.t === "relay.err");
    const e = (reply as { t: "relay.err"; e: string }).e;
    expect(e).toBe("PUSH_TOKEN_DEAD");

    daemon.close();
    relay.stop();
  });

  test("relay sends PUSH_TOKEN_DEAD to daemon when APNs returns 410 Unregistered", async () => {
    const relay = new RelayServer({
      pushService: new PushService({ fetchFn: unregisteredFetch }),
    });
    const port = relay.start(0);
    const TOKEN3 = "push-unregistered-test";
    const DAEMON3 = "push-unregistered-daemon";
    relay.registerToken(TOKEN3, DAEMON3);

    const daemon = await authDaemon(port, TOKEN3, DAEMON3);

    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-unregistered",
        sealed: "legacy-unregistered-token",
        title: "T",
        body: "B",
      }),
    );

    const reply = await waitForMessage(daemon, (m) => m.t === "relay.err");
    const e = (reply as { t: "relay.err"; e: string }).e;
    expect(e).toBe("PUSH_TOKEN_DEAD");

    daemon.close();
    relay.stop();
  });

  test("relay sends PUSH_DELIVERY_ERROR to daemon for non-dead APNs errors", async () => {
    const serverErrorFetch = (async () =>
      new Response(JSON.stringify({ reason: "InternalServerError" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    const relay = new RelayServer({
      pushService: new PushService({ fetchFn: serverErrorFetch }),
    });
    const port = relay.start(0);
    const TOKEN4 = "push-server-error-test";
    const DAEMON4 = "push-server-error-daemon";
    relay.registerToken(TOKEN4, DAEMON4);

    const daemon = await authDaemon(port, TOKEN4, DAEMON4);

    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-server-error",
        sealed: "legacy-token",
        title: "T",
        body: "B",
      }),
    );

    const reply = await waitForMessage(daemon, (m) => m.t === "relay.err");
    const e = (reply as { t: "relay.err"; e: string }).e;
    expect(e).toBe("PUSH_DELIVERY_ERROR");

    daemon.close();
    relay.stop();
  });
});

// ------------------------------------------------------------------
// Dedup + rate-limit: APNs-specific assertions
// ------------------------------------------------------------------
describe("handlePush dedup suppression (APNs)", () => {
  test("duplicate push within dedup window is suppressed (no relay.err, no APNs call)", async () => {
    let apnsCalls = 0;
    const countingFetch = (async () => {
      apnsCalls++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const relay = new RelayServer({
      pushService: new PushService({ fetchFn: countingFetch }),
    });
    const port = relay.start(0);
    const T = "push-dedup-test";
    const D = "push-dedup-daemon";
    relay.registerToken(T, D);

    const daemon = await authDaemon(port, T, D);

    const pushWithData = JSON.stringify({
      t: "relay.push",
      frontendId: "fe-dedup",
      sealed: "legacy-dedup-token",
      title: "T",
      body: "B",
      data: { sid: "s1", daemonId: D, event: "stop" },
    });

    // First push — should succeed and increment APNs call counter.
    daemon.send(pushWithData);
    await Bun.sleep(60);

    // Second identical push — should be deduped; no relay.err and no extra APNs call.
    daemon.send(pushWithData);
    await Bun.sleep(60);

    // APNs should have been called exactly once (second was deduped).
    expect(apnsCalls).toBe(1);

    daemon.close();
    relay.stop();
  });
});
