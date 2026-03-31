import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RelayServer } from "./relay-server";

describe("Relay Performance", () => {
  let relay: RelayServer;
  let port: number;

  beforeEach(() => {
    relay = new RelayServer();
    port = relay.start(0);
    relay.registerToken("bench-token", "bench-daemon");
  });

  afterEach(() => relay.stop());

  test("throughput: 100 frames daemon→frontend", async () => {
    const daemon = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((r) => {
      daemon.onopen = () => r();
    });
    daemon.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "daemon",
        daemonId: "bench-daemon",
        token: "bench-token",
      }),
    );

    const frontend = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((r) => {
      frontend.onopen = () => r();
    });
    frontend.send(
      JSON.stringify({
        t: "relay.auth",
        v: 1,
        role: "frontend",
        daemonId: "bench-daemon",
        token: "bench-token",
      }),
    );
    await Bun.sleep(100);

    frontend.send(JSON.stringify({ t: "relay.sub", sid: "bench" }));
    await Bun.sleep(50);

    let received = 0;
    frontend.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (msg.t === "relay.frame") received++;
    };

    const COUNT = 100;
    const start = Date.now();
    for (let i = 0; i < COUNT; i++) {
      daemon.send(
        JSON.stringify({
          t: "relay.pub",
          sid: "bench",
          ct: `data-${i}`,
          seq: i,
        }),
      );
    }

    // Wait with short polls
    for (let i = 0; i < 200 && received < COUNT; i++) {
      await Bun.sleep(10);
    }
    const elapsed = Date.now() - start;

    console.log(`[Bench] relay: ${received}/${COUNT} frames in ${elapsed}ms`);
    expect(received).toBe(COUNT);

    daemon.close();
    frontend.close();
  });
});
