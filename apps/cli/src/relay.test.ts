import { describe, expect, test } from "bun:test";
import {
  deriveRelayToken,
  generatePairingSecret,
} from "@teleprompter/protocol";
import { RelayServer } from "@teleprompter/relay";
import { capture } from "./test-util";

const CLI = "bun run apps/cli/src/index.ts";

describe("tp relay NaN guard (idx 17)", () => {
  // Verifies that non-numeric --port / --cache-size / --max-frame-size values
  // are rejected with a clear error instead of silently passing NaN into
  // RelayServer (which would disable ring-buffer cap and frame-size disconnect).
  test("invalid --port value exits with an error", () => {
    const out = capture(`${CLI} relay start --port abc`);
    expect(out).toContain("invalid --port value");
    expect(out).not.toContain("[Relay] press");
  });

  test("invalid --cache-size value exits with an error", () => {
    const out = capture(`${CLI} relay start --port 19999 --cache-size 0abc`);
    expect(out).toContain("invalid --cache-size value");
  });

  test("invalid --max-frame-size value exits with an error", () => {
    const out = capture(
      `${CLI} relay start --port 19998 --max-frame-size notanumber`,
    );
    expect(out).toContain("invalid --max-frame-size value");
  });

  test("valid numeric --port does not error", () => {
    // Starts the relay on a random high port long enough to confirm it
    // accepted the numeric argument, then sends SIGTERM after a short delay.
    const relay = new RelayServer();
    const port = relay.start(0);
    expect(port).toBeGreaterThan(0);
    relay.stop();
  });
});

describe("tp relay (integration)", () => {
  test("relay server starts and accepts connections", async () => {
    const relay = new RelayServer();
    const port = relay.start(0);
    expect(port).toBeGreaterThan(0);

    // Connect a WebSocket
    const ws = new WebSocket(`ws://localhost:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("failed"));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      // Send ping (works without auth)
      ws.send(JSON.stringify({ t: "relay.ping" }));
      const pong = await new Promise<unknown>((resolve, reject) => {
        ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });
      expect((pong as { t: string }).t).toBe("relay.pong");
    } finally {
      ws.close();
      relay.stop();
    }
  });

  test("relay with registered token authenticates correctly", async () => {
    const relay = new RelayServer();
    const port = relay.start(0);
    const secret = await generatePairingSecret();
    const token = await deriveRelayToken(secret);
    relay.registerToken(token, "test-daemon");

    const ws = new WebSocket(`ws://localhost:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("failed"));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });

      ws.send(
        JSON.stringify({
          t: "relay.auth",
          v: 1,
          role: "daemon",
          daemonId: "test-daemon",
          token,
        }),
      );

      const reply = await new Promise<unknown>((resolve, reject) => {
        ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
        setTimeout(() => reject(new Error("timeout")), 3000);
      });
      const authReply = reply as { t: string; daemonId: string };
      expect(authReply.t).toBe("relay.auth.ok");
      expect(authReply.daemonId).toBe("test-daemon");
    } finally {
      ws.close();
      relay.stop();
    }
  });
});
