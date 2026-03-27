import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import type { WsServerMessage } from "@teleprompter/protocol";

describe("tp status", () => {
  let daemon: Daemon;
  let wsPort: number;

  beforeEach(() => {
    SessionManager.setRunnerCommand(["true"]);
    daemon = new Daemon();
    daemon.start();
    daemon.startWs(0);
    wsPort = (daemon as any).wsServer.port;
  });

  afterEach(() => {
    daemon.stop();
  });

  /** Connect to daemon WS and get the hello response */
  async function getDaemonStatus(): Promise<WsServerMessage & { t: "hello" }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${wsPort}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout connecting to daemon"));
      }, 3000);

      ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1 }));
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        const msg = JSON.parse(event.data as string);
        if (msg.t === "hello") {
          ws.close();
          resolve(msg);
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WS error"));
      };
    });
  }

  test("returns hello with sessions array", async () => {
    const msg = await getDaemonStatus();
    expect(msg.t).toBe("hello");
    expect(msg.d).toBeDefined();
    expect(msg.d.sessions).toBeArray();
  });

  test("sessions have expected fields", async () => {
    const msg = await getDaemonStatus();
    // Sessions from store may exist from previous test runs
    if (msg.d.sessions.length > 0) {
      const session = msg.d.sessions[0];
      expect(session.sid).toBeString();
      expect(session.state).toBeString();
      expect(typeof session.lastSeq).toBe("number");
    }
  });
});
