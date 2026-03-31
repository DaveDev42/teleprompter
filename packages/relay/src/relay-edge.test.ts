import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  RelayError,
  RelayFrame,
  RelayServerMessage,
} from "@teleprompter/protocol";
import { RelayServer } from "./relay-server";

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("connect failed"));
    setTimeout(() => reject(new Error("timeout")), 3000);
  });
}

function waitMsg(
  ws: WebSocket,
  pred?: (m: RelayServerMessage) => boolean,
): Promise<RelayServerMessage> {
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string) as RelayServerMessage;
      if (!pred || pred(msg)) {
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("timeout"));
    }, 3000);
  });
}

describe("RelayServer edge cases", () => {
  let relay: RelayServer;
  let port: number;

  beforeEach(() => {
    relay = new RelayServer();
    port = relay.start(0);
    relay.registerToken("token-1", "daemon-1");
  });

  afterEach(() => relay.stop());

  test("rejects auth with mismatched daemonId", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: "wrong-daemon",
        token: "token-1",
      }),
    );
    const msg = await waitMsg(ws);
    expect(msg.t).toBe("relay.auth.err");
    ws.close();
  });

  test("handles malformed JSON gracefully", async () => {
    const ws = await connectWs(port);
    ws.send("not json at all {{{");
    const msg = await waitMsg(ws);
    expect(msg.t).toBe("relay.err");
    expect((msg as RelayError).e).toBe("PARSE_ERROR");
    ws.close();
  });

  test("handles unknown message type", async () => {
    const ws = await connectWs(port);
    ws.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: "daemon-1",
        token: "token-1",
      }),
    );
    await waitMsg(ws, (m) => m.t === "relay.auth.ok");

    ws.send(JSON.stringify({ t: "relay.nonexistent" }));
    const err = await waitMsg(ws, (m) => m.t === "relay.err");
    expect((err as RelayError).e).toBe("UNKNOWN_TYPE");
    ws.close();
  });

  test("multiple frontends can subscribe to same session", async () => {
    const daemon = await connectWs(port);
    const frontend1 = await connectWs(port);
    const frontend2 = await connectWs(port);

    // Auth all
    for (const [ws, role] of [
      [daemon, "daemon"],
      [frontend1, "frontend"],
      [frontend2, "frontend"],
    ] as const) {
      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role,
          daemonId: "daemon-1",
          token: "token-1",
        }),
      );
      await waitMsg(ws, (m) => m.t === "relay.auth.ok");
    }

    // Both frontends subscribe
    frontend1.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    frontend2.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);

    // Daemon publishes
    daemon.send(
      JSON.stringify({ t: "relay.pub", sid: "s1", ct: "payload", seq: 1 }),
    );

    // Both frontends receive
    const f1msg = await waitMsg(frontend1, (m) => m.t === "relay.frame");
    const f2msg = await waitMsg(frontend2, (m) => m.t === "relay.frame");
    expect((f1msg as RelayFrame).ct).toBe("payload");
    expect((f2msg as RelayFrame).ct).toBe("payload");

    daemon.close();
    frontend1.close();
    frontend2.close();
  });

  test("unsubscribe stops receiving frames", async () => {
    const daemon = await connectWs(port);
    const frontend = await connectWs(port);

    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: "daemon-1",
        token: "token-1",
      }),
    );
    await waitMsg(daemon, (m) => m.t === "relay.auth.ok");

    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: "daemon-1",
        token: "token-1",
      }),
    );
    await waitMsg(frontend, (m) => m.t === "relay.auth.ok");

    // Subscribe, receive, unsubscribe, should not receive
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);

    daemon.send(
      JSON.stringify({ t: "relay.pub", sid: "s1", ct: "visible", seq: 1 }),
    );
    const msg = await waitMsg(frontend, (m) => m.t === "relay.frame");
    expect((msg as RelayFrame).ct).toBe("visible");

    // Unsubscribe
    frontend.send(JSON.stringify({ t: "relay.unsub", sid: "s1" }));
    await Bun.sleep(50);

    // Publish again — frontend should NOT receive
    daemon.send(
      JSON.stringify({ t: "relay.pub", sid: "s1", ct: "invisible", seq: 2 }),
    );
    await Bun.sleep(200);

    // Resubscribe and verify we get new frames
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    await Bun.sleep(50);
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "s1",
        ct: "visible-again",
        seq: 3,
      }),
    );
    const msg2 = await waitMsg(frontend, (m) => m.t === "relay.frame");
    expect((msg2 as RelayFrame).ct).toBe("visible-again");

    daemon.close();
    frontend.close();
  });
});
