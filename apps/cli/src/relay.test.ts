import { describe, test, expect } from "bun:test";
import { RelayServer } from "@teleprompter/relay";
import {
  generatePairingSecret,
  deriveRelayToken,
} from "@teleprompter/protocol";

describe("tp relay (integration)", () => {
  test("relay server starts and accepts connections", async () => {
    const relay = new RelayServer();
    const port = relay.start(0);
    expect(port).toBeGreaterThan(0);

    // Connect a WebSocket
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("failed"));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    // Send ping (works without auth)
    ws.send(JSON.stringify({ t: "relay.ping" }));
    const pong = await new Promise<any>((resolve, reject) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    expect(pong.t).toBe("relay.pong");

    ws.close();
    relay.stop();
  });

  test("relay with registered token authenticates correctly", async () => {
    const relay = new RelayServer();
    const port = relay.start(0);
    const secret = await generatePairingSecret();
    const token = await deriveRelayToken(secret);
    relay.registerToken(token, "test-daemon");

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    ws.send(
      JSON.stringify({
        t: "relay.auth",
        role: "daemon",
        daemonId: "test-daemon",
        token,
      }),
    );

    const reply = await new Promise<any>((resolve) => {
      ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
    });
    expect(reply.t).toBe("relay.auth.ok");
    expect(reply.daemonId).toBe("test-daemon");

    ws.close();
    relay.stop();
  });
});
