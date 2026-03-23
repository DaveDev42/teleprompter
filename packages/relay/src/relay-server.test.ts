import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RelayServer } from "./relay-server";
import type { RelayServerMessage } from "@teleprompter/protocol";

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
    expect((msg as any).e).toBe("NOT_AUTHENTICATED");
    ws.close();
  });

  test("authenticates daemon and frontend", async () => {
    const daemon = await connectWs(port);
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    const authOk = await waitForMessage(daemon);
    expect(authOk.t).toBe("relay.auth.ok");
    expect((authOk as any).daemonId).toBe(DAEMON_ID);
    daemon.close();
  });

  test("rejects invalid token", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
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
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
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

    const frame = await waitForMessage(
      frontend,
      (m) => m.t === "relay.frame",
    );
    expect(frame.t).toBe("relay.frame");
    expect((frame as any).sid).toBe("session-1");
    expect((frame as any).ct).toBe("encrypted-payload-1");
    expect((frame as any).seq).toBe(1);
    expect((frame as any).from).toBe("daemon");

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
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
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
    expect((frame as any).ct).toBe("encrypted-input");
    expect((frame as any).from).toBe("frontend");

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
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
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

    const frame = await waitForMessage(
      frontend,
      (m) => m.t === "relay.frame",
    );
    expect((frame as any).ct).toBe("visible");
    expect((frame as any).seq).toBe(2);

    daemon.close();
    frontend.close();
  });

  test("caches recent 10 frames and replays on subscribe", async () => {
    const daemon = await connectWs(port);

    daemon.send(
      JSON.stringify({
        t: "relay.auth",
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
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({ t: "relay.sub", sid: "s1", after: 0 }),
    );

    // Should get last 10 frames (3-12), but only 10 are cached
    const frames = await collectMessages(frontend, 10, (m) => m.t === "relay.frame");
    expect(frames.length).toBe(10);
    expect((frames[0] as any).ct).toBe("frame-3");
    expect((frames[9] as any).ct).toBe("frame-12");

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
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(daemon, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
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
    expect((presence as any).online).toBe(false);

    frontend.close();
  });

  test("ping/pong works", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(ws, (m) => m.t === "relay.auth.ok");

    ws.send(JSON.stringify({ t: "relay.ping" }));
    const pong = await waitForMessage(ws, (m) => m.t === "relay.pong");
    expect(pong.t).toBe("relay.pong");
    ws.close();
  });

  test("resume with after= skips already-seen frames", async () => {
    const daemon = await connectWs(port);

    daemon.send(
      JSON.stringify({
        t: "relay.auth",
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
        role: "frontend",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({ t: "relay.sub", sid: "s1", after: 3 }),
    );

    const frames = await collectMessages(frontend, 2, (m) => m.t === "relay.frame");
    expect(frames.length).toBe(2);
    expect((frames[0] as any).seq).toBe(4);
    expect((frames[1] as any).seq).toBe(5);

    daemon.close();
    frontend.close();
  });
});
