import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ClientRegistry } from "./client-registry";
import { WsServer } from "./ws-server";
import type { WsClient } from "./client-registry";

describe("WsServer", () => {
  let registry: ClientRegistry;
  let server: WsServer;
  let port: number;

  // Track event calls
  const events: { name: string; args: unknown[] }[] = [];

  beforeEach(() => {
    events.length = 0;
    registry = new ClientRegistry();
    server = new WsServer(registry, {
      onHello: (client) => {
        events.push({ name: "hello", args: [client.id] });
        registry.send(client, { t: "hello", v: 1, d: { sessions: [] } });
      },
      onAttach: (client, sid) => {
        events.push({ name: "attach", args: [client.id, sid] });
        registry.attach(client, sid);
      },
      onDetach: (client, sid) => {
        events.push({ name: "detach", args: [client.id, sid] });
        registry.detach(client, sid);
      },
      onResume: (client, sid, cursor) => {
        events.push({ name: "resume", args: [client.id, sid, cursor] });
        registry.send(client, { t: "batch", sid, d: [] });
      },
      onInChat: (client, sid, text) => {
        events.push({ name: "inChat", args: [client.id, sid, text] });
      },
      onInTerm: (client, sid, data) => {
        events.push({ name: "inTerm", args: [client.id, sid, data] });
      },
    });

    // Use port 0 to get random available port
    server.start(0);
    port = server.port!;
  });

  afterEach(() => {
    server.stop();
  });

  function connect(): WebSocket {
    return new WebSocket(`ws://localhost:${port}`);
  }

  function waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(e);
    });
  }

  function waitForMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
    });
  }

  function waitForClose(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      ws.onclose = () => resolve();
    });
  }

  test("hello handshake", async () => {
    const ws = connect();
    await waitForOpen(ws);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ t: "hello", v: 1 }));
    const reply = await msgPromise;

    expect(reply).toEqual({ t: "hello", d: { sessions: [] } });
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("hello");

    ws.close();
    await waitForClose(ws);
  });

  test("ping/pong", async () => {
    const ws = connect();
    await waitForOpen(ws);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ t: "ping" }));
    const reply = await msgPromise;

    expect(reply).toEqual({ t: "pong" });

    ws.close();
    await waitForClose(ws);
  });

  test("attach dispatches event", async () => {
    const ws = connect();
    await waitForOpen(ws);

    ws.send(JSON.stringify({ t: "attach", sid: "test-session" }));
    // Give time for message processing
    await Bun.sleep(50);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("attach");
    expect(events[0].args[1]).toBe("test-session");

    ws.close();
    await waitForClose(ws);
  });

  test("resume dispatches with cursor", async () => {
    const ws = connect();
    await waitForOpen(ws);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ t: "resume", sid: "s1", c: 42 }));
    const reply = await msgPromise;

    expect(reply).toEqual({ t: "batch", sid: "s1", d: [] });
    expect(events[0].name).toBe("resume");
    expect(events[0].args).toEqual([expect.any(Number), "s1", 42]);

    ws.close();
    await waitForClose(ws);
  });

  test("in.chat dispatches event", async () => {
    const ws = connect();
    await waitForOpen(ws);

    ws.send(JSON.stringify({ t: "in.chat", sid: "s1", d: "hello world" }));
    await Bun.sleep(50);

    expect(events[0].name).toBe("inChat");
    expect(events[0].args[2]).toBe("hello world");

    ws.close();
    await waitForClose(ws);
  });

  test("in.term dispatches event", async () => {
    const ws = connect();
    await waitForOpen(ws);

    ws.send(JSON.stringify({ t: "in.term", sid: "s1", d: "aGVsbG8=" }));
    await Bun.sleep(50);

    expect(events[0].name).toBe("inTerm");
    expect(events[0].args[2]).toBe("aGVsbG8=");

    ws.close();
    await waitForClose(ws);
  });

  test("invalid JSON returns error", async () => {
    const ws = connect();
    await waitForOpen(ws);

    const msgPromise = waitForMessage(ws);
    ws.send("not json");
    const reply = await msgPromise;

    expect(reply).toEqual({ t: "err", e: "PARSE_ERROR", m: "Invalid JSON" });

    ws.close();
    await waitForClose(ws);
  });

  test("broadcast reaches subscribed clients", async () => {
    const ws1 = connect();
    const ws2 = connect();
    await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

    // Both attach to same session
    ws1.send(JSON.stringify({ t: "attach", sid: "s1" }));
    ws2.send(JSON.stringify({ t: "attach", sid: "s1" }));
    await Bun.sleep(50);

    // Broadcast a rec
    const msg1 = waitForMessage(ws1);
    const msg2 = waitForMessage(ws2);
    registry.broadcast("s1", {
      t: "rec",
      sid: "s1",
      seq: 1,
      k: "io",
      d: "dGVzdA==",
      ts: Date.now(),
    });

    const [r1, r2] = await Promise.all([msg1, msg2]);
    expect((r1 as { t: string }).t).toBe("rec");
    expect((r2 as { t: string }).t).toBe("rec");

    ws1.close();
    ws2.close();
    await Promise.all([waitForClose(ws1), waitForClose(ws2)]);
  });

  test("client disconnect removes from registry", async () => {
    const ws = connect();
    await waitForOpen(ws);
    expect(registry.size).toBe(1);

    ws.close();
    await waitForClose(ws);
    // Give server time to process close
    await Bun.sleep(50);
    expect(registry.size).toBe(0);
  });
});
