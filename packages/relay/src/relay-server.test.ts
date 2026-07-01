import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  RelayAuthErr,
  RelayAuthOk,
  RelayError,
  RelayFrame,
  RelayNotification,
  RelayPresence,
  RelayPushTokenSealed,
  RelayRegisterErr,
  RelayRegisterOk,
  RelayServerMessage,
} from "@teleprompter/protocol";
import type { DeliveryResult, PushRequest } from "./push";
import { PushService } from "./push";
import { PushSealer } from "./push-seal";
import { RelayServer } from "./relay-server";
import { connectWs, waitForMessage } from "./test-helpers";

type HealthResponse = {
  attached: number;
  metrics: { framesIn: number; oversizedDrops: number };
};

async function fetchHealth(port: number): Promise<HealthResponse> {
  const res = await fetch(`http://localhost:${port}/health`);
  return (await res.json()) as HealthResponse;
}

function collectMessages(
  ws: WebSocket,
  count: number,
  filter?: (msg: RelayServerMessage) => boolean,
): Promise<RelayServerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: RelayServerMessage[] = [];
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (!filter || filter(msg)) {
        messages.push(msg);
        if (messages.length >= count) {
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      if (messages.length > 0) resolve(messages);
      else reject(new Error("collectMessages timeout"));
    }, 3000);
  });
}

describe("RelayServer", () => {
  let relay: RelayServer;
  let port: number;
  const TOKEN = "test-token-abc123";
  const DAEMON_ID = "test-daemon-1";

  beforeEach(() => {
    relay = new RelayServer();
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);
  });

  afterEach(() => {
    relay.stop();
  });

  test("rejects unauthenticated publish", async () => {
    const ws = await connectWs(port);
    ws.send(JSON.stringify({ t: "relay.pub", sid: "s1", ct: "aaa", seq: 1 }));
    const msg = await waitForMessage(ws);
    expect(msg.t).toBe("relay.err");
    expect((msg as RelayError).e).toBe("NOT_AUTHENTICATED");
    ws.close();
  });

  test("authenticates daemon and frontend", async () => {
    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    const authOk = await waitForMessage(daemon);
    expect(authOk.t).toBe("relay.auth.ok");
    expect((authOk as RelayAuthOk).daemonId).toBe(DAEMON_ID);
    daemon.close();
  });

  test("rejects invalid token", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: "wrong-token",
      }),
    );
    const msg = await waitForMessage(ws);
    expect(msg.t).toBe("relay.auth.err");
    ws.close();
  });

  test("frontend auth with valid token but missing frontendId is rejected AND closed (no neither-map socket leak)", async () => {
    const ws = await connectWs(port);
    // Track whether the RELAY closed the socket (vs. us / idle timeout).
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN, // VALID token — passes the token guard
        // frontendId deliberately omitted → rejected by the frontendId guard
      }),
    );
    const msg = await waitForMessage(ws);
    expect(msg.t).toBe("relay.auth.err");
    expect((msg as RelayAuthErr).e).toContain("frontendId");

    // The socket must be closed by the relay, not left dangling in neither
    // pendingAuth (cleared) nor clients (never registered) until the 90s idle
    // timeout. Give the close frame a moment to arrive.
    await Bun.sleep(100);
    expect(closed).toBe(true);
    expect(
      ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING,
    ).toBe(true);
  });

  test("forwards frames from daemon to subscribed frontend", async () => {
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Auth both
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

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    // Frontend gets auth.ok and presence
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Subscribe frontend to session
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "session-1" }));
    await Bun.sleep(50);

    // Daemon publishes a ciphertext frame
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "session-1",
        ct: "encrypted-payload-1",
        seq: 1,
      }),
    );

    const frame = await waitForMessage(frontend, (m) => m.t === "relay.frame");
    expect(frame.t).toBe("relay.frame");
    expect((frame as RelayFrame).sid).toBe("session-1");
    expect((frame as RelayFrame).ct).toBe("encrypted-payload-1");
    expect((frame as RelayFrame).seq).toBe(1);
    expect((frame as RelayFrame).from).toBe("daemon");

    daemon.close();
    frontend.close();
  });

  test("duplicate relay.sub for the same sid does not double-count attached", async () => {
    // Regression: `subscriptions` is a Set (idempotent) but the `attached`
    // metric was incremented unconditionally on every relay.sub. The app
    // legitimately re-subscribes to a sid (attach, then again in onState when it
    // processes the daemon's `state` reply), so a second sub for an already-known
    // sid must NOT bump `attached` — otherwise handleClose (which decrements once
    // per sid) leaves the counter permanently leaked.
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

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

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-dup-sub",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Subscribe to the SAME sid three times (mirrors attach + onState re-sub).
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "session-dup" }));
    await Bun.sleep(30);
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "session-dup" }));
    await Bun.sleep(30);
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "session-dup" }));
    await Bun.sleep(50);

    // attached counts distinct (frontend, sid) subscriptions — must be exactly 1.
    const health = await fetchHealth(port);
    expect(health.attached).toBe(1);

    // And on close it decrements back to 0 (no permanent leak).
    frontend.close();
    await Bun.sleep(100);
    const afterClose = await fetchHealth(port);
    expect(afterClose.attached).toBe(0);

    daemon.close();
  });

  test("forwards frames from frontend to subscribed daemon", async () => {
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Auth both
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

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Daemon subscribes to session
    daemon.send(JSON.stringify({ t: "relay.sub", sid: "session-1" }));
    await Bun.sleep(50);

    // Frontend publishes input
    frontend.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "session-1",
        ct: "encrypted-input",
        seq: 1,
      }),
    );

    const frame = await waitForMessage(daemon, (m) => m.t === "relay.frame");
    expect((frame as RelayFrame).ct).toBe("encrypted-input");
    expect((frame as RelayFrame).from).toBe("frontend");

    daemon.close();
    frontend.close();
  });

  test("does not forward to unsubscribed clients", async () => {
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Auth both
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

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Frontend NOT subscribed — should not receive frames
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "session-1",
        ct: "secret",
        seq: 1,
      }),
    );

    // Wait a bit and check no message arrived
    await Bun.sleep(200);

    // Now subscribe and publish again
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "session-1" }));
    await Bun.sleep(50);

    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "session-1",
        ct: "visible",
        seq: 2,
      }),
    );

    const frame = await waitForMessage(frontend, (m) => m.t === "relay.frame");
    expect((frame as RelayFrame).ct).toBe("visible");
    expect((frame as RelayFrame).seq).toBe(2);

    daemon.close();
    frontend.close();
  });

  test("caches recent 10 frames and replays on subscribe", async () => {
    const daemon = await connectWs(port);

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

    // Publish 12 frames
    for (let i = 1; i <= 12; i++) {
      daemon.send(
        JSON.stringify({
          t: "relay.pub",
          sid: "s1",
          ct: `frame-${i}`,
          seq: i,
        }),
      );
    }
    await Bun.sleep(100);

    // Connect frontend and subscribe with after=0 (get all cached)
    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1", after: 0 }));

    // Should get last 10 frames (3-12), but only 10 are cached
    const frames = await collectMessages(
      frontend,
      10,
      (m) => m.t === "relay.frame",
    );
    expect(frames.length).toBe(10);
    expect((frames[0] as RelayFrame).ct).toBe("frame-3");
    expect((frames[9] as RelayFrame).ct).toBe("frame-12");

    daemon.close();
    frontend.close();
  });

  test("sends presence when daemon disconnects", async () => {
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Auth both
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

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    // auth.ok + initial presence
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");
    await waitForMessage(frontend, (m) => m.t === "relay.presence");

    // Disconnect daemon
    daemon.close();

    // Frontend should get offline presence
    const presence = await waitForMessage(
      frontend,
      (m) => m.t === "relay.presence",
    );
    expect((presence as RelayPresence).online).toBe(false);

    frontend.close();
  });

  test("ping/pong works", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(ws, (m) => m.t === "relay.auth.ok");

    ws.send(JSON.stringify({ t: "relay.ping" }));
    const pong = await waitForMessage(ws, (m) => m.t === "relay.pong");
    expect(pong.t).toBe("relay.pong");
    ws.close();
  });

  test("ping updates daemon lastSeen", async () => {
    const daemon = await connectWs(port);
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

    const beforePing = relay.getDaemonState(DAEMON_ID)?.lastSeen ?? 0;

    // Wait a bit so lastSeen changes are observable
    await Bun.sleep(50);

    // Send a ping
    daemon.send(JSON.stringify({ t: "relay.ping", ts: Date.now() }));
    const pong = await waitForMessage(daemon, (m) => m.t === "relay.pong");
    expect(pong.t).toBe("relay.pong");

    const afterPing = relay.getDaemonState(DAEMON_ID)?.lastSeen ?? 0;
    expect(afterPing).toBeGreaterThan(beforePing);

    daemon.close();
  });

  test("stale daemon is marked offline after timeout", async () => {
    // Use very short stale timeout for testing
    relay.setStaleTimeoutMs(200);
    relay.setStaleCheckIntervalMs(100);

    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Collect all presence messages on the frontend
    const presenceMessages: RelayPresence[] = [];
    frontend.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (msg.t === "relay.presence") {
        presenceMessages.push(msg as RelayPresence);
      }
    });

    // Auth daemon
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

    // Auth frontend
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    // Wait for initial online presence + stale timeout + check interval
    await Bun.sleep(500);

    // Should have initial online presence, then offline from stale detection
    const online = presenceMessages.find((p) => p.online);
    const offline = presenceMessages.find((p) => !p.online);
    expect(online).toBeDefined();
    expect(offline).toBeDefined();
    expect(offline?.daemonId).toBe(DAEMON_ID);

    daemon.close();
    frontend.close();
  });

  test("ping keeps daemon from going stale", async () => {
    // Use short stale timeout
    relay.setStaleTimeoutMs(300);
    relay.setStaleCheckIntervalMs(100);

    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    // Collect all presence messages to verify no offline was sent during pings
    const presenceMessages: RelayPresence[] = [];
    frontend.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (msg.t === "relay.presence") {
        presenceMessages.push(msg as RelayPresence);
      }
    });

    // Auth daemon
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

    // Auth frontend
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");
    await waitForMessage(frontend, (m) => m.t === "relay.presence");

    // Send pings every 100ms (well within the 300ms stale timeout)
    const pingInterval = setInterval(() => {
      daemon.send(JSON.stringify({ t: "relay.ping", ts: Date.now() }));
    }, 100);

    // Wait longer than stale timeout
    await Bun.sleep(500);
    clearInterval(pingInterval);

    // Explicitly verify: daemon is still online, no offline presence was broadcast
    const state = relay.getDaemonState(DAEMON_ID);
    expect(state?.online).toBe(true);
    expect(presenceMessages.every((p) => p.online)).toBe(true);

    // Now close daemon — offline presence should arrive from ws close
    daemon.close();
    const offlinePresence = (await waitForMessage(
      frontend,
      (m) => m.t === "relay.presence" && !(m as RelayPresence).online,
    )) as RelayPresence;
    expect(offlinePresence.online).toBe(false);

    frontend.close();
  });

  test("respects custom cache size", async () => {
    // Create a relay with cache size of 3
    relay.stop();
    relay = new RelayServer({ cacheSize: 3 });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    const daemon = await connectWs(port);
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

    // Publish 5 frames
    for (let i = 1; i <= 5; i++) {
      daemon.send(
        JSON.stringify({
          t: "relay.pub",
          sid: "s1",
          ct: `frame-${i}`,
          seq: i,
        }),
      );
    }
    await Bun.sleep(100);

    // Frontend subscribes — should only get last 3
    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1", after: 0 }));

    const frames = await collectMessages(
      frontend,
      3,
      (m) => m.t === "relay.frame",
    );
    expect(frames.length).toBe(3);
    expect((frames[0] as RelayFrame).ct).toBe("frame-3");
    expect((frames[2] as RelayFrame).ct).toBe("frame-5");

    daemon.close();
    frontend.close();
  });

  test("rejects oversized frames and closes connection", async () => {
    // Create a relay with small frame size limit
    relay.stop();
    relay = new RelayServer({ maxFrameSize: 100 });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(ws, (m) => m.t === "relay.auth.ok");

    // Send a message that exceeds 100 bytes
    const largePayload = "x".repeat(200);
    ws.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "s1",
        ct: largePayload,
        seq: 1,
      }),
    );

    const err = await waitForMessage(ws, (m) => m.t === "relay.err");
    expect((err as RelayError).e).toBe("FRAME_TOO_LARGE");

    // Connection should be closed — wait for close event
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
      setTimeout(resolve, 1000);
    });
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  test("oversized frame counts in oversizedDrops, not framesIn", async () => {
    // Regression: framesIn++ used to run BEFORE the size check, so an oversized
    // frame bumped both framesIn AND oversizedDrops — double-counting it and
    // breaking the framesIn ≈ framesOut + drops accounting the /metrics
    // endpoint relies on. An oversized frame must increment ONLY oversizedDrops.
    relay.stop();
    relay = new RelayServer({ maxFrameSize: 100 });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(ws, (m) => m.t === "relay.auth.ok");

    // The auth frame counts as one received frame.
    const before = await fetchHealth(port);
    expect(before.metrics.framesIn).toBe(1);
    expect(before.metrics.oversizedDrops).toBe(0);

    // Send an oversized frame (exceeds the 100-byte cap).
    ws.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "s1",
        ct: "x".repeat(200),
        seq: 1,
      }),
    );
    await waitForMessage(ws, (m) => m.t === "relay.err");

    const after = await fetchHealth(port);
    // framesIn is unchanged (the oversized frame was rejected before counting),
    // and only oversizedDrops moved.
    expect(after.metrics.framesIn).toBe(1);
    expect(after.metrics.oversizedDrops).toBe(1);
  });

  test("allows frames within size limit", async () => {
    // Create a relay with generous frame size limit
    relay.stop();
    relay = new RelayServer({ maxFrameSize: 10000 });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    const daemon = await connectWs(port);
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

    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);

    // Send a message within the limit
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "s1",
        ct: "small-payload",
        seq: 1,
      }),
    );

    const frame = await waitForMessage(frontend, (m) => m.t === "relay.frame");
    expect((frame as RelayFrame).ct).toBe("small-payload");

    daemon.close();
    frontend.close();
  });

  describe("relay.push", () => {
    test("delivers WS notification when frontend is connected", async () => {
      const daemon = await connectWs(port);
      const frontend = await connectWs(port);

      // Auth daemon
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

      // Auth frontend with frontendId "fe-1"
      frontend.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "frontend",
          daemonId: DAEMON_ID,
          token: TOKEN,
          frontendId: "fe-1",
        }),
      );
      await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

      // Daemon sends relay.push targeting "fe-1"
      daemon.send(
        JSON.stringify({
          t: "relay.push",
          frontendId: "fe-1",
          sealed: "legacy-device-token",
          title: "New message",
          body: "Claude responded",
          data: { sid: "s1", daemonId: DAEMON_ID, event: "stop" },
        }),
      );

      // Frontend receives relay.notification
      const notification = await waitForMessage(
        frontend,
        (m) => m.t === "relay.notification",
      );
      expect(notification.t).toBe("relay.notification");
      expect((notification as RelayNotification).title).toBe("New message");
      expect((notification as RelayNotification).body).toBe("Claude responded");
      expect((notification as RelayNotification).data).toEqual({
        sid: "s1",
        daemonId: DAEMON_ID,
        event: "stop",
      });

      daemon.close();
      frontend.close();
    });

    test("rejects relay.push from non-daemon role", async () => {
      const frontend = await connectWs(port);

      // Auth as frontend
      frontend.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "frontend",
          daemonId: DAEMON_ID,
          token: TOKEN,
          frontendId: "fe-1",
        }),
      );
      await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

      // Frontend tries to send relay.push — should be rejected
      frontend.send(
        JSON.stringify({
          t: "relay.push",
          frontendId: "fe-2",
          sealed: "legacy-device-token",
          title: "Unauthorized",
          body: "Should fail",
        }),
      );

      const err = await waitForMessage(frontend, (m) => m.t === "relay.err");
      expect(err.t).toBe("relay.err");
      expect((err as RelayError).e).toBe("UNAUTHORIZED");

      frontend.close();
    });

    test("calls APNs when frontend is disconnected", async () => {
      // Connect daemon only, no frontend
      const daemon = await connectWs(port);
      daemon.send(
        JSON.stringify({
          t: "relay.auth",
          role: "daemon",
          daemonId: DAEMON_ID,
          token: TOKEN,
          v: 2,
        }),
      );
      await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

      // Send relay.push for a frontendId that is NOT connected
      daemon.send(
        JSON.stringify({
          t: "relay.push",
          frontendId: "fe-disconnected",
          sealed: "aabbccddeeff001122334455disc0000",
          title: "Test",
          body: "Test body",
        }),
      );

      // No WS notification should be received (no frontend to receive it)
      // The push service will attempt APNs (which may fail in test env, but that's OK)
      // Just verify no crash and daemon stays connected
      await Bun.sleep(200);
      daemon.send(JSON.stringify({ t: "relay.ping" }));
      const pong = await waitForMessage(daemon, (m) => m.t === "relay.pong");
      expect(pong.t).toBe("relay.pong");

      daemon.close();
    });
  });

  test("resume with after= skips already-seen frames", async () => {
    const daemon = await connectWs(port);

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

    // Publish 5 frames
    for (let i = 1; i <= 5; i++) {
      daemon.send(
        JSON.stringify({
          t: "relay.pub",
          sid: "s1",
          ct: `f-${i}`,
          seq: i,
        }),
      );
    }
    await Bun.sleep(100);

    // Frontend subscribes with after=3 (should only get seq 4, 5)
    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-test",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1", after: 3 }));

    const frames = await collectMessages(
      frontend,
      2,
      (m) => m.t === "relay.frame",
    );
    expect(frames.length).toBe(2);
    expect((frames[0] as RelayFrame).seq).toBe(4);
    expect((frames[1] as RelayFrame).seq).toBe(5);

    daemon.close();
    frontend.close();
  });

  describe("H5 — evictDaemon cleans up validTokens and registrations", () => {
    test("evicted daemon token is rejected by relay.auth", async () => {
      // Authenticate a daemon so daemonStates has a registrationToken entry.
      const daemon = await connectWs(port);
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
      daemon.close();
      await Bun.sleep(50);

      // Force the daemon state offline and past the eviction TTL by setting
      // very short timeouts.
      relay.setStaleTimeoutMs(1);
      relay.setOfflineEvictAfterMs(1);
      relay.setStaleCheckIntervalMs(50);

      // Wait for the stale check to mark offline then evict.
      await Bun.sleep(200);

      // Token must be gone from validTokens and registrations must be empty.
      expect(relay.hasValidToken(TOKEN)).toBe(false);
      expect(relay.hasRegistration(DAEMON_ID)).toBe(false);

      // Attempting relay.auth with the old token must be rejected.
      const ws = await connectWs(port);
      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: DAEMON_ID,
          token: TOKEN,
        }),
      );
      const msg = await waitForMessage(ws);
      expect(msg.t).toBe("relay.auth.err");
      ws.close();
    });
  });

  describe("M12 — re-registration invalidates old token", () => {
    test("old token is rejected after daemon re-registers with a new token", async () => {
      const NEW_TOKEN = "new-token-xyz789";
      const PROOF = "proof-abc";

      // Register daemon with initial TOKEN via relay.register.
      const ws1 = await connectWs(port);
      ws1.send(
        JSON.stringify({
          t: "relay.register",
          daemonId: DAEMON_ID,
          token: TOKEN,
          proof: PROOF,
          v: 2,
        }),
      );
      await waitForMessage(ws1, (m) => m.t === "relay.register.ok");
      ws1.close();
      await Bun.sleep(50);

      expect(relay.hasValidToken(TOKEN)).toBe(true);

      // Re-register the same daemon with a NEW token (same proof).
      const ws2 = await connectWs(port);
      ws2.send(
        JSON.stringify({
          t: "relay.register",
          daemonId: DAEMON_ID,
          token: NEW_TOKEN,
          proof: PROOF,
          v: 2,
        }),
      );
      await waitForMessage(ws2, (m) => m.t === "relay.register.ok");
      ws2.close();
      await Bun.sleep(50);

      // Old token must be gone; new token must be valid.
      expect(relay.hasValidToken(TOKEN)).toBe(false);
      expect(relay.hasValidToken(NEW_TOKEN)).toBe(true);

      // Attempting relay.auth with the OLD token must be rejected.
      const ws3 = await connectWs(port);
      ws3.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: DAEMON_ID,
          token: TOKEN,
        }),
      );
      const authErr = await waitForMessage(ws3);
      expect(authErr.t).toBe("relay.auth.err");
      ws3.close();

      // Attempting relay.auth with the NEW token must succeed.
      const ws4 = await connectWs(port);
      ws4.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: DAEMON_ID,
          token: NEW_TOKEN,
        }),
      );
      const authOk = await waitForMessage(ws4);
      expect(authOk.t).toBe("relay.auth.ok");
      ws4.close();
    });
  });

  /**
   * idx 57: buildAuthOk frontend resume-token round-trip.
   *
   * A frontend client that authenticates with a non-empty frontendId must
   * receive a resumeToken that encodes the real frontendId (not an empty
   * string). When that token is presented to relay.auth.resume the relay must
   * accept it — the old `?? ""` sentinel caused ResumeTokenSigner.verify to
   * return null for any frontend resume attempt.
   */
  describe("frontend resume-token round-trip (idx 57)", () => {
    test("relay.auth.resume succeeds for a frontend client with a real frontendId", async () => {
      const FRONTEND_ID = "fe-resume-test";

      // Full auth for daemon first (so the daemon group exists and a
      // registration entry is created for the O(1) resume check).
      const daemon = await connectWs(port);
      daemon.send(
        JSON.stringify({
          t: "relay.register",
          daemonId: DAEMON_ID,
          token: TOKEN,
          proof: "proof-for-resume-test",
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

      // Full auth for frontend — captures the resumeToken from auth.ok.
      const frontend = await connectWs(port);
      frontend.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "frontend",
          daemonId: DAEMON_ID,
          token: TOKEN,
          frontendId: FRONTEND_ID,
        }),
      );
      const frontendAuthOk = (await waitForMessage(
        frontend,
        (m) => m.t === "relay.auth.ok",
      )) as RelayAuthOk;
      expect(frontendAuthOk.resumeToken).toBeDefined();
      const resumeToken = frontendAuthOk.resumeToken ?? "";

      // Close and reconnect with resume token.
      frontend.close();
      await Bun.sleep(50);

      const resumed = await connectWs(port);
      resumed.send(
        JSON.stringify({ t: "relay.auth.resume", token: resumeToken, v: 1 }),
      );
      const resumeOk = (await waitForMessage(
        resumed,
        (m) => m.t === "relay.auth.ok" || m.t === "relay.auth.err",
      )) as RelayAuthOk;

      // Must succeed — not be rejected with auth.err (old `?? ""` bug).
      expect(resumeOk.t).toBe("relay.auth.ok");
      expect(resumeOk.resumed).toBe(true);

      resumed.close();
      daemon.close();
    });
  });

  describe("security & resource-leak hardening", () => {
    async function authDaemon(p: number): Promise<WebSocket> {
      const ws = await connectWs(p);
      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: DAEMON_ID,
          token: TOKEN,
        }),
      );
      await waitForMessage(ws, (m) => m.t === "relay.auth.ok");
      return ws;
    }

    async function authFrontend(
      p: number,
      frontendId: string,
    ): Promise<WebSocket> {
      const ws = await connectWs(p);
      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "frontend",
          daemonId: DAEMON_ID,
          token: TOKEN,
          frontendId,
        }),
      );
      await waitForMessage(ws, (m) => m.t === "relay.auth.ok");
      return ws;
    }

    test("/admin returns 404 when TP_RELAY_ADMIN_TOKEN is not set", async () => {
      const prevToken = process.env["TP_RELAY_ADMIN_TOKEN"];
      delete process.env["TP_RELAY_ADMIN_TOKEN"];
      try {
        const res = await fetch(`http://localhost:${port}/admin`);
        expect(res.status).toBe(404);
      } finally {
        if (prevToken !== undefined)
          process.env["TP_RELAY_ADMIN_TOKEN"] = prevToken;
      }
    });

    test("/admin returns 401 when bearer token is missing or wrong", async () => {
      const prevToken = process.env["TP_RELAY_ADMIN_TOKEN"];
      process.env["TP_RELAY_ADMIN_TOKEN"] = "correct-secret";
      try {
        // No auth header
        const r1 = await fetch(`http://localhost:${port}/admin`);
        expect(r1.status).toBe(401);
        // Wrong token
        const r2 = await fetch(`http://localhost:${port}/admin`, {
          headers: { authorization: "Bearer wrong-secret" },
        });
        expect(r2.status).toBe(401);
      } finally {
        if (prevToken !== undefined)
          process.env["TP_RELAY_ADMIN_TOKEN"] = prevToken;
        else delete process.env["TP_RELAY_ADMIN_TOKEN"];
      }
    });

    test("/admin escapes daemonId and session IDs (no stored XSS)", async () => {
      const XSS_DAEMON = "<img src=x onerror=alert(1)>";
      const XSS_SID = '"><script>alert(2)</script>';
      relay.registerToken("xss-token", XSS_DAEMON);

      const prevToken = process.env["TP_RELAY_ADMIN_TOKEN"];
      const adminSecret = "test-admin-secret-for-xss-check";
      process.env["TP_RELAY_ADMIN_TOKEN"] = adminSecret;

      const daemon = await connectWs(port);
      daemon.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: XSS_DAEMON,
          token: "xss-token",
        }),
      );
      await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");
      daemon.send(
        JSON.stringify({ t: "relay.pub", sid: XSS_SID, ct: "aa", seq: 1 }),
      );
      await Bun.sleep(50);

      const html = await (
        await fetch(`http://localhost:${port}/admin`, {
          headers: { authorization: `Bearer ${adminSecret}` },
        })
      ).text();
      // Raw payloads must NOT appear; escaped forms must.
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).not.toContain("<script>alert(2)</script>");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      daemon.close();

      if (prevToken !== undefined)
        process.env["TP_RELAY_ADMIN_TOKEN"] = prevToken;
      else delete process.env["TP_RELAY_ADMIN_TOKEN"];
    });

    test("unauthenticated relay.ping gets no pong (rate-limit bypass closed)", async () => {
      const ws = await connectWs(port);
      // Never send relay.auth. Ping should be silently ignored.
      ws.send(JSON.stringify({ t: "relay.ping", ts: Date.now() }));
      let gotPong = false;
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.pong") gotPong = true;
      });
      await Bun.sleep(150);
      expect(gotPong).toBe(false);
      ws.close();
    });

    test("proof:'' from token-auth does not let a different relay.register bypass the credentials guard", async () => {
      // Daemon authenticates via plain relay.auth (token-only) — seeds
      // registrations with proof=null (was "" before the fix).
      const daemon = await authDaemon(port);

      // A peer now tries to re-register the same daemonId with an empty-string
      // proof but a DIFFERENT token. With the old proof:"" sentinel this would
      // pass `existing.proof !== msg.proof` ("" !== "" is false) and steal the
      // registration. With proof:null it is allowed through as a fresh register
      // (null means "no proof recorded"), but it must NOT be silently treated as
      // matching an existing empty-string proof — assert the token is rebound,
      // which only re-register (not the bypass) performs cleanly.
      const ws = await connectWs(port);
      ws.send(
        JSON.stringify({
          t: "relay.register",
          daemonId: DAEMON_ID,
          token: "attacker-token",
          proof: "",
          v: 2,
        }),
      );
      const reply = await waitForMessage(
        ws,
        (m) => m.t === "relay.register.ok" || m.t === "relay.register.err",
      );
      // The seeded proof is null, so this register is accepted (no false
      // collision with a real "" proof). The key invariant: a SUBSEQUENT
      // register with a different *non-null* proof is now rejected.
      expect(reply.t).toBe("relay.register.ok");

      const ws2 = await connectWs(port);
      ws2.send(
        JSON.stringify({
          t: "relay.register",
          daemonId: DAEMON_ID,
          token: "third-token",
          proof: "different-proof",
          v: 2,
        }),
      );
      const reply2 = await waitForMessage(
        ws2,
        (m) => m.t === "relay.register.ok" || m.t === "relay.register.err",
      );
      // Now there IS a recorded proof (""), so a different proof is rejected.
      expect(reply2.t).toBe("relay.register.err");
      ws.close();
      ws2.close();
      daemon.close();
    });

    test("frontend publishing to a dead daemon does not reset its eviction clock", async () => {
      relay.setStaleTimeoutMs(100);
      relay.setStaleCheckIntervalMs(50);
      relay.setOfflineEvictAfterMs(300);

      const daemon = await authDaemon(port);
      const frontend = await authFrontend(port, "fe-leak");

      // Kill the daemon so it goes offline.
      daemon.close();
      await Bun.sleep(200); // > staleTimeout → marked offline

      const state = relay.getDaemonState(DAEMON_ID);
      expect(state?.online).toBe(false);
      const lastSeenAfterOffline = state?.lastSeen ?? 0;

      // Frontend keeps publishing — must NOT refresh the daemon's lastSeen.
      for (let i = 0; i < 3; i++) {
        frontend.send(
          JSON.stringify({ t: "relay.pub", sid: "s-leak", ct: "x", seq: i }),
        );
        await Bun.sleep(50);
      }
      const lastSeenAfterFrontendPub =
        relay.getDaemonState(DAEMON_ID)?.lastSeen ?? -1;
      // Either evicted entirely (state gone) or lastSeen unchanged — both prove
      // the frontend traffic didn't keep the dead daemon alive.
      if (lastSeenAfterFrontendPub !== -1) {
        expect(lastSeenAfterFrontendPub).toBe(lastSeenAfterOffline);
      }
      frontend.close();
    });

    test("daemon sessions Set is bounded (no unbounded growth)", async () => {
      const daemon = await authDaemon(port);
      // Publish to many more distinct sids than the cap.
      for (let i = 0; i < 400; i++) {
        daemon.send(
          JSON.stringify({ t: "relay.pub", sid: `sid-${i}`, ct: "x", seq: i }),
        );
      }
      await Bun.sleep(200);
      const size = relay.getDaemonSessionCount(DAEMON_ID) ?? 0;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThanOrEqual(256);
      daemon.close();
    });
  });
});

// ── Decision-gated hardening: registration cap, pre-auth throttle, recentFrames cap ──

describe("RelayServer — DoS / unbounded-growth caps", () => {
  function send(ws: WebSocket, obj: unknown): void {
    ws.send(JSON.stringify(obj));
  }

  function waitFor(
    ws: WebSocket,
    predicate: (m: RelayServerMessage) => boolean,
  ): Promise<RelayServerMessage> {
    return new Promise((resolve, reject) => {
      const h = (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (predicate(m)) {
          ws.removeEventListener("message", h);
          resolve(m);
        }
      };
      ws.addEventListener("message", h);
      setTimeout(() => {
        ws.removeEventListener("message", h);
        reject(new Error("waitFor timeout"));
      }, 3000);
    });
  }

  test("relay.register rejects a NEW daemonId past maxRegistrations, but lets an existing one update", async () => {
    const relay = new RelayServer({ maxRegistrations: 2 });
    const port = relay.start(0);
    try {
      const ws = await connectWs(port);

      // Two distinct daemonIds fill the cap.
      send(ws, {
        t: "relay.register",
        daemonId: "d1",
        proof: "p1",
        token: "t1",
        v: 2,
      });
      await waitFor(ws, (m) => m.t === "relay.register.ok");
      send(ws, {
        t: "relay.register",
        daemonId: "d2",
        proof: "p2",
        token: "t2",
        v: 2,
      });
      await waitFor(ws, (m) => m.t === "relay.register.ok");

      // A THIRD distinct daemonId is rejected (cap reached).
      send(ws, {
        t: "relay.register",
        daemonId: "d3",
        proof: "p3",
        token: "t3",
        v: 2,
      });
      const err = await waitFor(ws, (m) => m.t === "relay.register.err");
      expect((err as RelayRegisterErr).e).toContain("capacity");

      // An ALREADY-registered daemonId can still update (rotate token) — not blocked.
      send(ws, {
        t: "relay.register",
        daemonId: "d1",
        proof: "p1",
        token: "t1b",
        v: 2,
      });
      const ok = await waitFor(ws, (m) => m.t === "relay.register.ok");
      expect((ok as RelayRegisterOk).daemonId).toBe("d1");

      ws.close();
    } finally {
      relay.stop();
    }
  });

  test("an unauthenticated socket is closed after exceeding maxPreauthMsgs", async () => {
    const relay = new RelayServer({ maxPreauthMsgs: 5 });
    const port = relay.start(0);
    try {
      const ws = await connectWs(port);
      let closed = false;
      let closeCode = 0;
      ws.addEventListener("close", (e) => {
        closed = true;
        closeCode = e.code;
      });

      // Send well over the threshold of malformed/pre-auth frames. Each one is
      // a pre-auth message; past 5 the relay must close the socket. Using an
      // unknown type keeps each frame cheap but still counted.
      for (let i = 0; i < 20; i++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        send(ws, { t: "relay.kx", to: `x${i}`, ct: "deadbeef" });
        await Bun.sleep(5);
      }

      await Bun.sleep(100);
      expect(closed).toBe(true);
      expect(closeCode).toBe(1008);
    } finally {
      relay.stop();
    }
  });

  test("authenticated frontend is NOT subject to the pre-auth message cap", async () => {
    // The cap must only apply to pre-auth sockets — an authenticated client is
    // governed by the per-client rate limiter, not this counter.
    const relay = new RelayServer({ maxPreauthMsgs: 3 });
    const port = relay.start(0);
    const TOKEN = "auth-token";
    const DAEMON_ID = "cap-daemon";
    relay.registerToken(TOKEN, DAEMON_ID);
    try {
      const ws = await connectWs(port);
      let closed = false;
      ws.addEventListener("close", () => {
        closed = true;
      });

      send(ws, {
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-cap",
      });
      await waitFor(ws, (m) => m.t === "relay.auth.ok");

      // Now send many post-auth frames — far more than maxPreauthMsgs=3. These
      // must NOT close the socket (the pre-auth counter is gone after auth).
      for (let i = 0; i < 10; i++) {
        send(ws, { t: "relay.sub", sid: `s${i}` });
        await Bun.sleep(5);
      }
      await Bun.sleep(100);
      expect(closed).toBe(false);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      relay.stop();
    }
  });

  test("recentFrames is bounded per daemon — the oldest sid-key is evicted past the cap (no replay), recent ones survive", async () => {
    // With cap=3, publishing 5 distinct sids must keep only the 3 most-recent
    // sid-keys cached. The oldest (sid-0) is evicted → a replay (relay.sub
    // after=0) for it yields NO cached frame, while a recent sid (sid-4) still
    // replays. On pre-fix code (no cap), ALL 5 keys persist and sid-0 replays.
    const relay = new RelayServer({ maxRecentFrameKeysPerDaemon: 3 });
    const port = relay.start(0);
    const TOKEN = "rf-token";
    const DAEMON_ID = "rf-daemon";
    relay.registerToken(TOKEN, DAEMON_ID);
    try {
      const daemon = await connectWs(port);
      send(daemon, {
        t: "relay.auth",
        v: 2,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      });
      await waitFor(daemon, (m) => m.t === "relay.auth.ok");

      // Publish to 5 distinct sids in order (sid-0 oldest, sid-4 newest).
      for (let i = 0; i < 5; i++) {
        send(daemon, { t: "relay.pub", sid: `sid-${i}`, ct: `c${i}`, seq: 1 });
        await Bun.sleep(15);
      }

      const fe = await connectWs(port);
      send(fe, {
        t: "relay.auth",
        v: 2,
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
        frontendId: "fe-rf",
      });
      await waitFor(fe, (m) => m.t === "relay.auth.ok");

      // A recent sid (within the cap) must still replay.
      send(fe, { t: "relay.sub", sid: "sid-4", after: 0 });
      const recent = await waitFor(
        fe,
        (m) => m.t === "relay.frame" && (m as RelayFrame).sid === "sid-4",
      );
      expect((recent as RelayFrame).sid).toBe("sid-4");

      // The OLDEST sid (sid-0) was evicted → its replay yields nothing. We can't
      // wait forever for a non-event, so race the replay against a short timer:
      // if a frame for sid-0 arrives, the eviction failed.
      send(fe, { t: "relay.sub", sid: "sid-0", after: 0 });
      const sid0Replayed = await Promise.race([
        waitFor(
          fe,
          (m) => m.t === "relay.frame" && (m as RelayFrame).sid === "sid-0",
        ).then(() => true),
        Bun.sleep(250).then(() => false),
      ]);
      expect(sid0Replayed).toBe(false);

      daemon.close();
      fe.close();
    } finally {
      relay.stop();
    }
  });
});

// ── Path X: Sealed Push Token integration tests ────────────────────────────

const PUSH_X_TOKEN = "path-x-token";
const PUSH_X_DAEMON_ID = "push-x-daemon";
const PUSH_X_FRONTEND_ID = "push-x-frontend-1";
const PUSH_SEAL_SECRET = "x".repeat(32);
// A well-formed APNs (iOS) device token: exactly 64 lowercase hex chars, as the
// zero-trust guard (relay-client-guard.ts `/^[0-9a-f]{64}$/`) now requires.
const IOS_APNS_TOKEN = "0123456789abcdef".repeat(4);

describe("Path X: relay.push.register → relay.push.token sealing", () => {
  let relay: RelayServer;
  let port: number;

  beforeEach(() => {
    relay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
    });
    port = relay.start(0);
    relay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);
  });

  afterEach(() => {
    relay.stop();
  });

  async function authDaemon(p: number): Promise<WebSocket> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://localhost:${p}`);
      w.onopen = () => resolve(w);
      w.onerror = () => reject(new Error("daemon connect failed"));
      setTimeout(() => reject(new Error("daemon connect timeout")), 3000);
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await waitForMsg(ws, (m) => m.t === "relay.auth.ok");
    return ws;
  }

  async function authFrontend(
    p: number,
    frontendId: string,
  ): Promise<WebSocket> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://localhost:${p}`);
      w.onopen = () => resolve(w);
      w.onerror = () => reject(new Error("frontend connect failed"));
      setTimeout(() => reject(new Error("frontend connect timeout")), 3000);
    });
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
        frontendId,
      }),
    );
    await waitForMsg(ws, (m) => m.t === "relay.auth.ok");
    return ws;
  }

  function waitForMsg(
    ws: WebSocket,
    predicate?: (m: RelayServerMessage) => boolean,
  ): Promise<RelayServerMessage> {
    return new Promise((resolve, reject) => {
      const h = (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (!predicate || predicate(m)) {
          ws.removeEventListener("message", h);
          resolve(m);
        }
      };
      ws.addEventListener("message", h);
      setTimeout(() => {
        ws.removeEventListener("message", h);
        reject(new Error("waitForMsg timeout"));
      }, 3000);
    });
  }

  test("frontend relay.push.register → daemon receives relay.push.token with sealed blob", async () => {
    const daemon = await authDaemon(port);
    const frontend = await authFrontend(port, PUSH_X_FRONTEND_ID);

    // Collect the next message the daemon receives (relay.push.token)
    const daemonMsgP = waitForMsg(daemon, (m) => m.t === "relay.push.token");

    frontend.send(
      JSON.stringify({
        t: "relay.push.register",
        frontendId: PUSH_X_FRONTEND_ID,
        token: IOS_APNS_TOKEN,
        platform: "ios",
      }),
    );

    const msg = await daemonMsgP;
    expect(msg.t).toBe("relay.push.token");
    const ptMsg = msg as RelayPushTokenSealed;
    expect(ptMsg.frontendId).toBe(PUSH_X_FRONTEND_ID);
    expect(ptMsg.platform).toBe("ios");
    expect(ptMsg.sealed.startsWith("tpps1.")).toBe(true);

    // Verify the sealed blob decrypts to the original token
    const sealer = new PushSealer({ secret: PUSH_SEAL_SECRET });
    const result = await sealer.unseal(ptMsg.sealed);
    expect(result).toEqual({
      ok: true,
      token: IOS_APNS_TOKEN,
    });

    frontend.close();
    daemon.close();
  });

  test("daemon sender of relay.push.register → relay.err UNAUTHORIZED", async () => {
    const daemon = await authDaemon(port);
    const errMsgP = waitForMsg(daemon, (m) => m.t === "relay.err");

    daemon.send(
      JSON.stringify({
        t: "relay.push.register",
        frontendId: PUSH_X_FRONTEND_ID,
        token: "ExponentPushToken[xyz]",
        platform: "android",
      }),
    );

    const errMsg = await errMsgP;
    expect((errMsg as RelayError).e).toBe("UNAUTHORIZED");
    daemon.close();
  });

  test("relay.push with valid sealed blob → APNs push sent with plaintext token in URL", async () => {
    const capturedUrls: string[] = [];
    const captureFetch = (async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : String(input));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const sealRelay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new PushService({ fetchFn: captureFetch }),
    });
    const sealPort = sealRelay.start(0);
    sealRelay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemon2 = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${sealPort}`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("connect failed"));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    daemon2.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      daemon2.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.auth.ok") resolve();
      });
      setTimeout(() => reject(new Error("auth timeout")), 3000);
    });

    // Seal a real APNs-style hex token
    const sealer = new PushSealer({ secret: PUSH_SEAL_SECRET });
    const plainToken = "aabbccddeeff001122334455aabbccddeeff001122334455";
    const sealed = await sealer.seal(plainToken);

    daemon2.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-absent",
        sealed,
        title: "Test",
        body: "Hello",
      }),
    );

    await Bun.sleep(300);
    // The fake ApnsClient posts to https://apns-fake/3/device/<token>
    expect(capturedUrls.some((u) => u.includes(plainToken))).toBe(true);

    daemon2.close();
    sealRelay.stop();
  });

  test("relay.push with corrupt sealed blob → relay.err PUSH_UNSEAL_FAILED, no Expo call", async () => {
    const callCount = { n: 0 };
    const countFetch = (async () => {
      callCount.n++;
      return new Response(
        JSON.stringify({ data: [{ status: "ok", id: "t1" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sealRelay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new PushService({ fetchFn: countFetch }),
    });
    const sealPort = sealRelay.start(0);
    sealRelay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemon2 = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${sealPort}`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("connect failed"));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    daemon2.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      daemon2.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.auth.ok") resolve();
      });
      setTimeout(() => reject(new Error("auth timeout")), 3000);
    });

    const errMsgP = new Promise<RelayServerMessage>((resolve, reject) => {
      daemon2.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.err") resolve(m);
      });
      setTimeout(() => reject(new Error("no relay.err received")), 3000);
    });

    // Send a corrupted sealed blob
    daemon2.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-absent",
        sealed: "tpps1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        title: "Test",
        body: "Hello",
      }),
    );

    const errMsg = await errMsgP;
    expect((errMsg as RelayError).e).toBe("PUSH_UNSEAL_FAILED");
    expect(callCount.n).toBe(0);

    daemon2.close();
    sealRelay.stop();
  });

  test("legacy plaintext token in the sealed slot still delivers (back-compat)", async () => {
    // The legacy plaintext `token` wire field has been removed. Daemons in the
    // upgrade window may carry a plaintext APNs token stored as the `sealed` value
    // (non-"tpps1." prefix). The relay classifies it via PushSealer.unseal() as
    // reason="legacy" and uses it verbatim as the APNs device token.
    const capturedUrls: string[] = [];
    const captureFetch = (async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : String(input));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const legacyRelay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new PushService({ fetchFn: captureFetch }),
    });
    const legacyPort = legacyRelay.start(0);
    legacyRelay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemonL = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${legacyPort}`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("connect failed"));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    daemonL.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      daemonL.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.auth.ok") resolve();
      });
      setTimeout(() => reject(new Error("auth timeout")), 3000);
    });

    // Legacy: plaintext token in the sealed slot (non-"tpps1." prefix).
    const legacyToken = "aabbccddeeff001122334455legacy00";
    daemonL.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-legacy",
        sealed: legacyToken,
        title: "Legacy push",
        body: "Hello legacy",
      }),
    );

    await Bun.sleep(300);
    expect(capturedUrls.some((u) => u.includes(legacyToken))).toBe(true);

    daemonL.close();
    legacyRelay.stop();
  });

  test("legacy plaintext token in the `sealed` slot still delivers (upgrade-window back-compat)", async () => {
    // Non-"tpps1." sealed values are treated as verbatim APNs device tokens
    // (legacy upgrade-window path). The relay must POST to the APNs URL that
    // includes the plaintext token (not return PUSH_UNSEAL_FAILED).
    const capturedUrls: string[] = [];
    const captureFetch = (async (input: RequestInfo | URL) => {
      capturedUrls.push(typeof input === "string" ? input : String(input));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const relayF = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new PushService({ fetchFn: captureFetch }),
    });
    const portF = relayF.start(0);
    relayF.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemonF = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${portF}`);
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("connect failed"));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    daemonF.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      daemonF.addEventListener("message", (e: MessageEvent) => {
        const m = JSON.parse(e.data as string) as RelayServerMessage;
        if (m.t === "relay.auth.ok") resolve();
      });
      setTimeout(() => reject(new Error("auth timeout")), 3000);
    });

    // Plaintext token in the `sealed` slot (non-"tpps1." → reason="legacy").
    const upgradeToken = "aabbccddeeff001122334455upgrade0";
    daemonF.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: "fe-upgrade",
        sealed: upgradeToken,
        title: "Upgrade push",
        body: "Hello upgrade",
      }),
    );

    await Bun.sleep(300);
    expect(capturedUrls.some((u) => u.includes(upgradeToken))).toBe(true);

    daemonF.close();
    relayF.stop();
  });

  test("relay.push.register routes under AUTHENTICATED frontendId, ignoring a spoofed wire frontendId (no cross-frontend hijack)", async () => {
    // An authenticated frontend (identity = PUSH_X_FRONTEND_ID) sends a
    // relay.push.register whose wire frontendId claims to be a DIFFERENT,
    // victim frontend. The relay must route relay.push.token under the
    // authenticated client.frontendId, NOT the spoofed wire value — otherwise
    // the attacker hijacks the victim's push delivery.
    const daemon = await authDaemon(port);
    const attacker = await authFrontend(port, PUSH_X_FRONTEND_ID);

    const daemonMsgP = waitForMsg(daemon, (m) => m.t === "relay.push.token");

    attacker.send(
      JSON.stringify({
        t: "relay.push.register",
        // Spoofed: the attacker claims to be the victim.
        frontendId: "victim-frontend-2",
        token: IOS_APNS_TOKEN,
        platform: "ios",
      }),
    );

    const msg = (await daemonMsgP) as RelayPushTokenSealed;
    expect(msg.t).toBe("relay.push.token");
    // Routed under the AUTHENTICATED identity, not the spoofed wire value.
    expect(msg.frontendId).toBe(PUSH_X_FRONTEND_ID);
    expect(msg.frontendId).not.toBe("victim-frontend-2");

    attacker.close();
    daemon.close();
  });
});

// ── TOCTOU: frontend disconnect during push handling ───────────────────────

describe("relay.push TOCTOU: frontend disconnects mid-flight", () => {
  /**
   * A PushService whose first sendOrDeliver call (the live-frontend "ws"
   * verdict) blocks on a gate the test controls, so the test can close the
   * frontend WebSocket and let the server's handleClose deregister it BEFORE
   * the verdict is returned — reproducing the exact TOCTOU window
   * (isFrontendConnected sampled true, socket closed during the await).
   */
  class GatedPushService extends PushService {
    readonly calls: PushRequest[] = [];
    private release!: () => void;
    readonly gate = new Promise<void>((r) => {
      this.release = r;
    });
    openGate(): void {
      this.release();
    }
    override async sendOrDeliver(req: PushRequest): Promise<DeliveryResult> {
      this.calls.push(req);
      if (this.calls.length === 1) {
        // First call: frontend looked connected. Block until the test has
        // closed the socket and confirmed deregistration, then honour the
        // "ws" verdict the production code sampled.
        await this.gate;
        return "ws";
      }
      // Second call is the fix's APNs fallback (isFrontendConnected:false).
      return "push";
    }
  }

  // Poll /health until the relay reports exactly `want` connected clients, so
  // the test deterministically waits for handleClose to run rather than racing
  // on a fixed sleep.
  async function waitForClientCount(
    p: number,
    want: number,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await fetch(`http://localhost:${p}/health`);
      const body = (await res.json()) as { clients: number };
      if (body.clients === want) return;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for clients=${want} (last=${body.clients})`,
        );
      }
      await Bun.sleep(10);
    }
  }

  test("falls back to APNs when the frontend WS closes during the unseal/sendOrDeliver await", async () => {
    // REGRESSION: handlePush sampled isFrontendConnected BEFORE its awaits and
    // trusted that stale "ws" verdict afterwards. If the frontend disconnected
    // mid-flight, this.send() no-op'd on the closed socket and the push was
    // lost — no in-band delivery AND no APNs fallback, with no error back to
    // the daemon to trigger a retry. The fix re-checks liveness and re-delivers
    // via APNs (isFrontendConnected:false) when the socket died.
    const push = new GatedPushService();
    const relay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: push,
    });
    const port = relay.start(0);
    relay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    const frontend = await connectWs(port);
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
        frontendId: PUSH_X_FRONTEND_ID,
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");
    await waitForClientCount(port, 2); // daemon + frontend both registered

    const sealer = new PushSealer({ secret: PUSH_SEAL_SECRET });
    const sealed = await sealer.seal(
      "aabbccddeeff001122334455aabbccddeeff001122334455",
    );

    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: PUSH_X_FRONTEND_ID,
        sealed,
        title: "Test",
        body: "Hello",
        data: { sid: "s1", daemonId: PUSH_X_DAEMON_ID, event: "Notification" },
      }),
    );

    // Wait until handlePush is parked inside the gated first sendOrDeliver
    // (frontend still looks connected at this point).
    while (push.calls.length < 1) await Bun.sleep(5);

    // Close the frontend and wait for the server to deregister it. This is the
    // mid-flight disconnect the production code must survive.
    frontend.close();
    await waitForClientCount(port, 1); // only the daemon remains

    // Release the parked verdict; the fix now re-checks liveness, finds the
    // socket gone, and re-delivers via APNs.
    push.openGate();

    // The fallback APNs call must happen: a SECOND sendOrDeliver with
    // isFrontendConnected:false. Without the fix only the first ("ws") call
    // exists and the push is silently dropped.
    const deadline = Date.now() + 3000;
    while (push.calls.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(push.calls.length).toBe(2);
    expect(push.calls[0]?.isFrontendConnected).toBe(true);
    expect(push.calls[1]?.isFrontendConnected).toBe(false);

    daemon.close();
    relay.stop();
  });
});

describe("relay.err push errors carry frontendId (finding #1)", () => {
  // A PushService that immediately reports the APNs token as permanently dead
  // (400 BadDeviceToken / 410 Unregistered), with no live-frontend "ws" arm.
  class DeadTokenPushService extends PushService {
    override async sendOrDeliver(_req: PushRequest): Promise<DeliveryResult> {
      return "dead_token";
    }
  }

  // A PushService whose unseal never runs because we feed a real "tpps1." blob
  // sealed under a DIFFERENT secret — the relay's PushSealer.unseal() fails and
  // the dead-token/unseal path fires before sendOrDeliver is reached. We reuse
  // the dead-token service so the type matches; unseal failure short-circuits
  // before sendOrDeliver anyway.

  test("PUSH_TOKEN_DEAD relay.err carries the originating frontendId", async () => {
    // REGRESSION (finding #1): before the fix the dead-token relay.err carried
    // no frontendId, so the daemon's relay-client handler had nothing to route
    // to handleTokenDead and the dead APNs token was never evicted — every
    // future hook event re-sent to it. This asserts the relay now stamps the
    // owning frontendId on the wire so the daemon can evict surgically.
    const relay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new DeadTokenPushService(),
    });
    const port = relay.start(0);
    relay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    const sealer = new PushSealer({ secret: PUSH_SEAL_SECRET });
    const sealed = await sealer.seal(
      "aabbccddeeff001122334455aabbccddeeff001122334455",
    );

    // No frontend connected → APNs path (isFrontendConnected:false) → the
    // DeadTokenPushService returns "dead_token".
    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: PUSH_X_FRONTEND_ID,
        sealed,
        title: "Test",
        body: "Hello",
        data: { sid: "s1", daemonId: PUSH_X_DAEMON_ID, event: "Notification" },
      }),
    );

    const err = await waitForMessage(
      daemon,
      (m) => m.t === "relay.err" && m.e === "PUSH_TOKEN_DEAD",
    );
    expect((err as { frontendId?: string }).frontendId).toBe(
      PUSH_X_FRONTEND_ID,
    );

    daemon.close();
    relay.stop();
  });

  test("PUSH_UNSEAL_FAILED relay.err carries the originating frontendId", async () => {
    // Sibling path: a "tpps1." blob sealed under a foreign secret can't be
    // unsealed by this relay, so it emits PUSH_UNSEAL_FAILED — which must also
    // carry the frontendId so the daemon drops that frontend's stale token.
    const relay = new RelayServer({
      pushSealSecret: PUSH_SEAL_SECRET,
      pushService: new DeadTokenPushService(),
    });
    const port = relay.start(0);
    relay.registerToken(PUSH_X_TOKEN, PUSH_X_DAEMON_ID);

    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: PUSH_X_DAEMON_ID,
        token: PUSH_X_TOKEN,
        v: 2,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    // Seal under a DIFFERENT secret so this relay's PushSealer cannot unseal it.
    const foreignSealer = new PushSealer({ secret: "y".repeat(32) });
    const foreignSealed = await foreignSealer.seal(
      "aabbccddeeff001122334455aabbccddeeff001122334455",
    );

    daemon.send(
      JSON.stringify({
        t: "relay.push",
        frontendId: PUSH_X_FRONTEND_ID,
        sealed: foreignSealed,
        title: "Test",
        body: "Hello",
        data: { sid: "s1", daemonId: PUSH_X_DAEMON_ID, event: "Notification" },
      }),
    );

    const err = await waitForMessage(
      daemon,
      (m) => m.t === "relay.err" && m.e === "PUSH_UNSEAL_FAILED",
    );
    expect((err as { frontendId?: string }).frontendId).toBe(
      PUSH_X_FRONTEND_ID,
    );

    daemon.close();
    relay.stop();
  });
});
