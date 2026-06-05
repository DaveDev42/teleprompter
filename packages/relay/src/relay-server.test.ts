import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  RelayAuthOk,
  RelayError,
  RelayFrame,
  RelayNotification,
  RelayPresence,
  RelayServerMessage,
} from "@teleprompter/protocol";
import { RelayServer } from "./relay-server";

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS connect failed"));
    setTimeout(() => reject(new Error("WS connect timeout")), 3000);
  });
}

type HealthResponse = {
  attached: number;
  metrics: { framesIn: number; oversizedDrops: number };
};

async function fetchHealth(port: number): Promise<HealthResponse> {
  const res = await fetch(`http://localhost:${port}/health`);
  return (await res.json()) as HealthResponse;
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
          token: "ExponentPushToken[fake-token]",
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
          token: "ExponentPushToken[fake-token]",
          title: "Unauthorized",
          body: "Should fail",
        }),
      );

      const err = await waitForMessage(frontend, (m) => m.t === "relay.err");
      expect(err.t).toBe("relay.err");
      expect((err as RelayError).e).toBe("UNAUTHORIZED");

      frontend.close();
    });

    test("calls Expo Push API when frontend is disconnected", async () => {
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
          token: "ExponentPushToken[test]",
          title: "Test",
          body: "Test body",
        }),
      );

      // No WS notification should be received (no frontend to receive it)
      // The push service will try Expo API (which will fail in test env, but that's OK)
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
      const resumeToken = frontendAuthOk.resumeToken!;

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
});
