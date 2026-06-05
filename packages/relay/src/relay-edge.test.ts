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

async function fetchAttached(port: number): Promise<number> {
  const res = await fetch(`http://localhost:${port}/health`);
  const body = (await res.json()) as { attached: number };
  return body.attached;
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

  test("rejects a known type with missing required fields", async () => {
    // Regression for the zero-trust wire guard: a frame with a VALID
    // discriminant but missing fields used to be cast straight to
    // RelayClientMessage and dispatched, so `relay.pub` with no sid/ct/seq
    // reached handlePublish and dereferenced undefined. The guard now rejects
    // it with UNKNOWN_TYPE before any handler runs, and the connection stays
    // alive (the relay keeps serving valid frames afterward).
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

    // relay.pub with no sid/ct/seq — structurally a "known type", semantically
    // garbage. Must be rejected, not dispatched.
    ws.send(JSON.stringify({ t: "relay.pub" }));
    const err = await waitMsg(ws, (m) => m.t === "relay.err");
    expect((err as RelayError).e).toBe("UNKNOWN_TYPE");

    // Connection survived: a subsequent well-formed ping still gets a pong.
    ws.send(JSON.stringify({ t: "relay.ping", ts: 1 }));
    const pong = await waitMsg(ws, (m) => m.t === "relay.pong");
    expect(pong.t).toBe("relay.pong");
    ws.close();
  });

  test("rejects relay.pub with wrong-typed seq", async () => {
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

    // sid/ct present but seq is a string — the old cast would have let this
    // through and broken ordering math downstream.
    ws.send(JSON.stringify({ t: "relay.pub", sid: "s", ct: "x", seq: "1" }));
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

  test("M13 — closing one frontend does not remove the other frontend's session tracking", async () => {
    // Two frontends each subscribe to their own session plus the shared session.
    // Closing frontend1 must only decrement/remove frontend1's attached entries;
    // frontend2 must still receive frames on the shared session (its subscription
    // and attached count must survive). The old `?? 1` fallback in handleClose
    // would set count=0 if the entry was already absent, masking bugs, OR
    // wrongly decrement a count that belonged to frontend2 when shared sessions
    // only had frontend2 remaining at count 1.
    const daemon = await connectWs(port);
    const frontend1 = await connectWs(port);
    const frontend2 = await connectWs(port);

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

    // frontend1 subscribes to two sessions (s-shared + s-f1-only).
    // frontend2 subscribes to s-shared only.
    frontend1.send(JSON.stringify({ t: "relay.sub", sid: "s-shared" }));
    frontend1.send(JSON.stringify({ t: "relay.sub", sid: "s-f1-only" }));
    frontend2.send(JSON.stringify({ t: "relay.sub", sid: "s-shared" }));
    await Bun.sleep(50);

    // Total distinct sessions with attached frontends: s-shared (count=2) +
    // s-f1-only (count=1) → attached map has 2 entries.
    expect(await fetchAttached(port)).toBe(2);

    // Close frontend1 — s-f1-only should be removed (count 1→0), and
    // s-shared should drop from 2→1 (NOT 0, which is what the ?? 1 bug caused).
    frontend1.close();
    await Bun.sleep(100);

    // s-shared still has frontend2 → 1 distinct session remains.
    expect(await fetchAttached(port)).toBe(1);

    // frontend2 must still receive frames published by the daemon on s-shared.
    daemon.send(
      JSON.stringify({
        t: "relay.pub",
        sid: "s-shared",
        ct: "after-f1-close",
        seq: 1,
      }),
    );
    const frame = await waitMsg(frontend2, (m) => m.t === "relay.frame");
    expect((frame as RelayFrame).ct).toBe("after-f1-close");

    daemon.close();
    frontend2.close();
  });

  test("frontend close without unsub releases attached counts", async () => {
    // Regression: handleClose never decremented state.attached, so a frontend
    // that dropped without sending relay.unsub (tab close, network loss, crash)
    // leaked its attached count — pinning attached above zero forever. Subscribe
    // to multiple sessions, close abruptly, and assert the counts drain to zero.
    const frontend = await connectWs(port);
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

    // Subscribe to two distinct sessions; each adds one attached entry.
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s1" }));
    frontend.send(JSON.stringify({ t: "relay.sub", sid: "s2" }));
    await Bun.sleep(50);
    expect(await fetchAttached(port)).toBe(2);

    // Close WITHOUT unsubscribing — the leak path.
    frontend.close();
    await Bun.sleep(100);

    // handleClose must have released both sessions' attached counts.
    expect(await fetchAttached(port)).toBe(0);
  });
});
