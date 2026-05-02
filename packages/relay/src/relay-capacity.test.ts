import { afterEach, describe, expect, test } from "bun:test";
import type { RelayError, RelayServerMessage } from "@teleprompter/protocol";
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
});
