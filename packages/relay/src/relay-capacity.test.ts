import { afterEach, describe, expect, test } from "bun:test";
import type {
  RelayAuthErr,
  RelayAuthOk,
  RelayError,
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

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.addEventListener("close", () => resolve());
    setTimeout(resolve, 3000);
  });
}

const TOKEN = "cap-token";
const DAEMON_ID = "cap-daemon";

describe("RelayServer capacity hardening", () => {
  let relay: RelayServer;
  let port: number;

  afterEach(() => {
    relay?.stop();
  });

  test("closes unauthenticated socket after auth timeout", async () => {
    relay = new RelayServer({ authTimeoutMs: 200 });
    port = relay.start(0);

    const ws = await connectWs(port);
    await waitForClose(ws);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  test("authenticated socket survives past auth timeout", async () => {
    relay = new RelayServer({ authTimeoutMs: 150 });
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

    // Wait past the auth timeout — connection must remain open.
    await Bun.sleep(300);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("per-client rate limit kicks in", async () => {
    relay = new RelayServer({ ratePerClient: 5, ratePerDaemon: 10_000 });
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

    // Burst past the per-client cap of 5.
    const rateErrors: RelayError[] = [];
    daemon.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (msg.t === "relay.err" && (msg as RelayError).e === "RATE_LIMITED") {
        rateErrors.push(msg as RelayError);
      }
    });

    for (let i = 0; i < 20; i++) {
      daemon.send(
        JSON.stringify({ t: "relay.pub", sid: "s1", ct: `f-${i}`, seq: i }),
      );
    }
    await Bun.sleep(150);

    expect(rateErrors.length).toBeGreaterThan(0);
    expect(rateErrors[0]?.e).toBe("RATE_LIMITED");
    daemon.close();
  });

  test("per-daemon-group rate limit caps shared budget", async () => {
    // Per-client well above the burst, per-daemon barely above first client's
    // share — second client's traffic should hit the group cap.
    relay = new RelayServer({ ratePerClient: 1000, ratePerDaemon: 10 });
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
        frontendId: "fe-1",
      }),
    );
    await waitForMessage(frontend, (m) => m.t === "relay.auth.ok");

    const groupErrors: RelayError[] = [];
    frontend.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (msg.t === "relay.err" && (msg as RelayError).e === "RATE_LIMITED") {
        groupErrors.push(msg as RelayError);
      }
    });

    // Burn most of the group budget on the daemon side first.
    for (let i = 0; i < 8; i++) {
      daemon.send(
        JSON.stringify({ t: "relay.pub", sid: "s1", ct: `d-${i}`, seq: i }),
      );
    }
    // Frontend then tries to publish — group cap should bite.
    for (let i = 0; i < 10; i++) {
      frontend.send(
        JSON.stringify({ t: "relay.pub", sid: "s1", ct: `f-${i}`, seq: i }),
      );
    }
    await Bun.sleep(150);

    expect(groupErrors.length).toBeGreaterThan(0);
    expect(groupErrors[0]?.m).toContain("Daemon group");
    daemon.close();
    frontend.close();
  });

  test("/health exposes metrics object", async () => {
    relay = new RelayServer();
    port = relay.start(0);

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as { metrics: Record<string, number> };
    expect(body.metrics).toBeDefined();
    expect(typeof body.metrics.framesIn).toBe("number");
    expect(typeof body.metrics.rateLimitedDrops).toBe("number");
    expect(typeof body.metrics.backpressureDisconnects).toBe("number");
    expect(typeof body.metrics.authTimeouts).toBe("number");
  });

  test("/metrics returns Prometheus-style text", async () => {
    relay = new RelayServer();
    port = relay.start(0);

    const res = await fetch(`http://localhost:${port}/metrics`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("relay_clients ");
    expect(text).toContain("relay_frames_in ");
    expect(text).toContain("relay_rate_limited_drops ");
    expect(text).toContain("relay_backpressure_disconnects ");
    expect(text).toContain("relay_auth_timeouts ");
  });

  test("auth timeout increments authTimeouts metric", async () => {
    relay = new RelayServer({ authTimeoutMs: 100 });
    port = relay.start(0);

    const ws = await connectWs(port);
    await waitForClose(ws);
    // Allow the close handler to flush.
    await Bun.sleep(50);

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as { metrics: { authTimeouts: number } };
    expect(body.metrics.authTimeouts).toBeGreaterThanOrEqual(1);
  });

  test("relay.auth.ok includes a resume token", async () => {
    relay = new RelayServer({ resumeSecret: "z".repeat(64) });
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
    const ok = (await waitForMessage(
      ws,
      (m) => m.t === "relay.auth.ok",
    )) as RelayAuthOk;
    expect(ok.resumeToken).toBeTruthy();
    expect(typeof ok.resumeToken).toBe("string");
    expect(ok.resumeExpiresAt).toBeGreaterThan(Date.now());
    expect(ok.resumed).toBe(false);
    ws.close();
  });

  test("relay.auth.resume reconnects without re-sending token", async () => {
    relay = new RelayServer({ resumeSecret: "z".repeat(64) });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    // First connection: full auth, capture resume token.
    const first = await connectWs(port);
    first.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    const ok1 = (await waitForMessage(
      first,
      (m) => m.t === "relay.auth.ok",
    )) as RelayAuthOk;
    const resumeToken = ok1.resumeToken;
    expect(resumeToken).toBeTruthy();
    first.close();
    await Bun.sleep(50);

    // Reconnect with relay.auth.resume only.
    const second = await connectWs(port);
    second.send(
      JSON.stringify({ t: "relay.auth.resume", v: 1, token: resumeToken }),
    );
    const ok2 = (await waitForMessage(
      second,
      (m) => m.t === "relay.auth.ok",
    )) as RelayAuthOk;
    expect(ok2.daemonId).toBe(DAEMON_ID);
    expect(ok2.resumed).toBe(true);
    expect(ok2.resumeToken).toBeTruthy();

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as {
      metrics: { resumesAccepted: number; resumesAttempted: number };
    };
    expect(body.metrics.resumesAttempted).toBe(1);
    expect(body.metrics.resumesAccepted).toBe(1);

    second.close();
  });

  test("relay.auth.resume rejects bad tokens with relay.auth.err", async () => {
    relay = new RelayServer({ resumeSecret: "z".repeat(64) });
    port = relay.start(0);

    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth.resume",
        v: 1,
        token: "garbage-not-a-real-token",
      }),
    );
    const err = (await waitForMessage(
      ws,
      (m) => m.t === "relay.auth.err",
    )) as RelayAuthErr;
    expect(err.t).toBe("relay.auth.err");
    expect(err.e).toContain("invalid");

    const res = await fetch(`http://localhost:${port}/health`);
    const body = (await res.json()) as {
      metrics: { resumesRejected: number };
    };
    expect(body.metrics.resumesRejected).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  test("relay.auth.resume rejects tokens for unregistered daemons", async () => {
    relay = new RelayServer({ resumeSecret: "z".repeat(64) });
    port = relay.start(0);
    relay.registerToken(TOKEN, DAEMON_ID);

    // Auth once to obtain a valid token.
    const first = await connectWs(port);
    first.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: DAEMON_ID,
        token: TOKEN,
      }),
    );
    const ok = (await waitForMessage(
      first,
      (m) => m.t === "relay.auth.ok",
    )) as RelayAuthOk;
    const resumeToken = ok.resumeToken;
    expect(resumeToken).toBeTruthy();
    first.close();
    await Bun.sleep(50);

    // Unregister the daemon and stop / restart relay would be too heavy;
    // instead just delete the registration via a fresh server with the
    // same resume secret but no registerToken call.
    relay.stop();
    relay = new RelayServer({ resumeSecret: "z".repeat(64) });
    port = relay.start(0);

    const second = await connectWs(port);
    second.send(
      JSON.stringify({ t: "relay.auth.resume", v: 1, token: resumeToken }),
    );
    const err = (await waitForMessage(
      second,
      (m) => m.t === "relay.auth.err",
    )) as RelayAuthErr;
    expect(err.e).toContain("no longer registered");
    second.close();
  });
});
