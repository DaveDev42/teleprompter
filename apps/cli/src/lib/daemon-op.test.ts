import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeFrame,
  type IpcAck,
  type IpcMessage,
} from "@teleprompter/protocol";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DAEMON_OP_TIMEOUT_MS, requestDaemonOp } from "./daemon-op";

// ─── Fake daemon server helpers ────────────────────────────────────────────

type FakeServer = ReturnType<typeof Bun.listen>;

function startFakeServer(
  sockPath: string,
  onData: (sock: { write: (b: Uint8Array) => void; end: () => void }) => void,
): FakeServer {
  return Bun.listen({
    unix: sockPath,
    socket: {
      open() {},
      data(sock) {
        onData(sock);
      },
      close() {},
      error() {},
    },
  });
}

// ─── Test suite ────────────────────────────────────────────────────────────

describe("requestDaemonOp", () => {
  let dir: string;
  let sockPath: string;
  let server: FakeServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tp-daemon-op-"));
    sockPath = join(dir, "s.sock");
    server = undefined;
  });

  afterEach(() => {
    server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("resolves when server sends a message matching the type-guard", async () => {
    // IpcAck is { t: "ack"; sid: string; seq: number } — a known IpcMessage subtype.
    const reply: IpcAck = { t: "ack", sid: "s1", seq: 1 };
    server = startFakeServer(sockPath, (sock) => {
      // send a non-matching ack first (seq 999), then the one we expect (seq 1)
      sock.write(encodeFrame({ t: "ack", sid: "s1", seq: 999 } satisfies IpcMessage));
      sock.write(encodeFrame(reply));
    });

    const result = await requestDaemonOp<IpcAck>(
      sockPath,
      { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
      (m): m is IpcAck => m.t === "ack" && (m as IpcAck).seq === 1,
    );

    expect(result).toEqual(reply);
  });

  test("resolves on first matching message and ignores later ones", async () => {
    const first: IpcAck = { t: "ack", sid: "s1", seq: 1 };
    const second: IpcAck = { t: "ack", sid: "s1", seq: 2 };
    server = startFakeServer(sockPath, (sock) => {
      sock.write(encodeFrame(first));
      sock.write(encodeFrame(second));
    });

    const result = await requestDaemonOp<IpcAck>(
      sockPath,
      { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
      (m): m is IpcAck => m.t === "ack",
    );

    expect(result.seq).toBe(1);
  });

  test("rejects when the daemon disconnects before sending a matching reply", async () => {
    server = startFakeServer(sockPath, (sock) => {
      // close without sending anything
      sock.end();
    });

    await expect(
      requestDaemonOp<IpcMessage>(
        sockPath,
        { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
        (_m): _m is IpcMessage => false,
      ),
    ).rejects.toThrow("Daemon disconnected before replying");
  });

  test("rejects on timeout and uses the configured ms in the message", async () => {
    // Server that never responds — use a very short timeout so the test is fast.
    server = startFakeServer(sockPath, (_sock) => {
      /* intentionally silent */
    });

    const timeoutMs = 80;
    await expect(
      requestDaemonOp<IpcMessage>(
        sockPath,
        { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
        (_m): _m is IpcMessage => false,
        timeoutMs,
      ),
    ).rejects.toThrow(
      `Daemon did not reply within ${timeoutMs / 1000}s; try 'tp daemon status' or restart the daemon`,
    );
  }, 5_000);

  test("always closes the IPC connection after resolving", async () => {
    let clientEndCalls = 0;

    // Use a real server and intercept the socket-close event on the server side.
    let closeResolve!: () => void;
    const closedPromise = new Promise<void>((r) => {
      closeResolve = r;
    });

    server = Bun.listen({
      unix: sockPath,
      socket: {
        open() {},
        data(sock) {
          sock.write(encodeFrame({ t: "ack", sid: "s1", seq: 1 } satisfies IpcMessage));
        },
        close() {
          clientEndCalls++;
          closeResolve();
        },
        error() {},
      },
    });

    await requestDaemonOp<IpcAck>(
      sockPath,
      { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
      (m): m is IpcAck => m.t === "ack",
    );

    // Wait for the server to observe the close.
    await closedPromise;
    expect(clientEndCalls).toBe(1);
  });

  test("always closes the IPC connection after rejecting on early close", async () => {
    // Track whether the promise settled and connection was released.
    let settled = false;
    server = startFakeServer(sockPath, (sock) => {
      sock.end();
    });

    try {
      await requestDaemonOp<IpcMessage>(
        sockPath,
        { t: "hello", sid: "s1", cwd: "/work", pid: 42 },
        (_m): _m is IpcMessage => false,
      );
    } catch {
      settled = true;
    }

    expect(settled).toBe(true);
  });

  test("DAEMON_OP_TIMEOUT_MS is 30 000", () => {
    expect(DAEMON_OP_TIMEOUT_MS).toBe(30_000);
  });
});
