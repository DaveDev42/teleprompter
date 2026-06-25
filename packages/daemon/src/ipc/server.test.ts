import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  type IpcAck,
  type IpcBye,
  type IpcHello,
  type IpcMessage,
  type IpcRec,
  type IpcSessionDelete,
  type IpcSessionPrune,
} from "@teleprompter/protocol";
import { mkdtemp, rm } from "fs/promises";
import { connect } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { IpcServer } from "./server";

describe("IpcServer", () => {
  let server: IpcServer;
  let socketPath: string;
  let tmpDir: string;
  let receivedMessages: IpcMessage[] = [];
  let connectedCount = 0;
  let disconnectedCount = 0;
  // When set, onMessage throws for the matching frame type once (then clears).
  // Drives the rank-2 "onMessage throw is contained to the socket" test.
  let throwOnMessageType: string | null = null;

  beforeEach(async () => {
    receivedMessages = [];
    connectedCount = 0;
    disconnectedCount = 0;
    throwOnMessageType = null;
    tmpDir = await mkdtemp(join(tmpdir(), "tp-ipc-test-"));
    socketPath = join(tmpDir, "test.sock");

    server = new IpcServer({
      onMessage: (_runner, msg) => {
        if (throwOnMessageType !== null && msg.t === throwOnMessageType) {
          throwOnMessageType = null;
          throw new Error("simulated transient SQLite write failure");
        }
        receivedMessages.push(msg);
      },
      onConnect: () => {
        connectedCount++;
      },
      onDisconnect: () => {
        disconnectedCount++;
      },
    });
    server.start(socketPath);
  });

  afterEach(async () => {
    server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function connectClient(): Promise<ReturnType<typeof connect>> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.on("connect", () => resolve(socket));
      socket.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
  }

  test("accepts connections", async () => {
    const client = await connectClient();
    await Bun.sleep(50);
    expect(connectedCount).toBe(1);
    client.end();
    await Bun.sleep(50);
    expect(disconnectedCount).toBe(1);
  });

  test("receives hello message", async () => {
    const client = await connectClient();
    const hello: IpcHello = {
      t: "hello",
      sid: "test-session",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);
    expect(receivedMessages.length).toBe(1);
    const msg0 = receivedMessages[0];
    if (msg0 === undefined) throw new Error("expected message 0");
    expect(msg0.t).toBe("hello");
    expect((msg0 as IpcHello).sid).toBe("test-session");
    client.end();
  });

  test("receives multiple framed messages", async () => {
    const client = await connectClient();

    const hello: IpcHello = {
      t: "hello",
      sid: "multi-test",
      cwd: "/tmp",
      pid: process.pid,
    };
    const rec: IpcRec = {
      t: "rec",
      sid: "multi-test",
      kind: "io",
      payload: Buffer.from("hello world").toString("base64"),
      ts: Date.now(),
    };
    const bye: IpcBye = {
      t: "bye",
      sid: "multi-test",
      exitCode: 0,
    };

    client.write(Buffer.from(encodeFrame(hello)));
    client.write(Buffer.from(encodeFrame(rec)));
    client.write(Buffer.from(encodeFrame(bye)));

    await Bun.sleep(100);
    expect(receivedMessages.length).toBe(3);
    const m0 = receivedMessages[0];
    const m1 = receivedMessages[1];
    const m2 = receivedMessages[2];
    if (m0 === undefined) throw new Error("expected message 0");
    if (m1 === undefined) throw new Error("expected message 1");
    if (m2 === undefined) throw new Error("expected message 2");
    expect(m0.t).toBe("hello");
    expect(m1.t).toBe("rec");
    expect(m2.t).toBe("bye");
    client.end();
  });

  test("findRunnerBySid finds registered runner", async () => {
    const client = await connectClient();
    const hello: IpcHello = {
      t: "hello",
      sid: "find-me",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);

    const found = server.findRunnerBySid("find-me");
    expect(found).toBeDefined();
    expect(found?.sid).toBe("find-me");

    const notFound = server.findRunnerBySid("no-such");
    expect(notFound).toBeUndefined();

    client.end();
  });

  test("sends ack back to runner", async () => {
    const client = await connectClient();
    const decoder = new FrameDecoder();
    const received: unknown[] = [];

    client.on("data", (data: Buffer) => {
      const frames = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const frame of frames) received.push(frame.data);
    });

    const hello: IpcHello = {
      t: "hello",
      sid: "ack-test",
      cwd: "/tmp",
      pid: process.pid,
    };
    client.write(Buffer.from(encodeFrame(hello)));
    await Bun.sleep(50);

    const runner = server.findRunnerBySid("ack-test");
    if (!runner) throw new Error("Expected runner to be registered");
    const ack: IpcAck = { t: "ack", sid: "ack-test", seq: 42 };
    server.send(runner, ack);

    await Bun.sleep(50);
    expect(received.length).toBe(1);
    expect((received[0] as IpcAck).t).toBe("ack");
    expect((received[0] as IpcAck).seq).toBe(42);

    client.end();
  });

  test("handles multiple simultaneous connections", async () => {
    const client1 = await connectClient();
    const client2 = await connectClient();

    client1.write(
      Buffer.from(encodeFrame({ t: "hello", sid: "c1", cwd: "/a", pid: 1 })),
    );
    client2.write(
      Buffer.from(encodeFrame({ t: "hello", sid: "c2", cwd: "/b", pid: 2 })),
    );
    await Bun.sleep(50);

    expect(connectedCount).toBe(2);
    expect(receivedMessages.length).toBe(2);
    expect(server.findRunnerBySid("c1")).toBeDefined();
    expect(server.findRunnerBySid("c2")).toBeDefined();

    client1.end();
    client2.end();
  });

  // Regression for PR #150 — `session.delete` / `session.prune` commands sent
  // from the CLI were dropped by `parseIpcMessage` (missing cases), so the
  // dispatcher never saw them and the CLI hit its 30s timeout. This test
  // pushes both frames through the real IPC server and asserts they arrive
  // at `onMessage` with the full payload, which only happens if the guard
  // accepts them.
  test("session.delete and session.prune survive the guard", async () => {
    const client = await connectClient();

    const del: IpcSessionDelete = { t: "session.delete", sid: "to-delete" };
    const prune: IpcSessionPrune = {
      t: "session.prune",
      age: { kind: "olderThan", ms: 86_400_000 },
      includeRunning: false,
      dryRun: true,
    };

    client.write(Buffer.from(encodeFrame(del)));
    client.write(Buffer.from(encodeFrame(prune)));
    await Bun.sleep(50);

    expect(receivedMessages.length).toBe(2);
    expect(receivedMessages[0]).toEqual(del);
    expect(receivedMessages[1]).toEqual(prune);

    client.end();
  });

  // Rank-2 regression (daemon-audit): onMessage → dispatchIpc runs synchronous
  // SQLite writes that CAN throw (disk full, SQLITE_BUSY, corrupt page). Bun
  // does NOT wrap socket `data` callbacks in a try/catch, so an unguarded throw
  // escapes the event-loop callback. The guard contains it deterministically:
  // it catches the throw INSIDE the data callback, logs an attributable
  // "onMessage handler threw" line, and end()s only the offending socket.
  //
  // We assert on the LOG ATTRIBUTION because that is what genuinely distinguishes
  // the fix from its absence: pre-fix, the escaped throw is routed to Bun's
  // socket `error` handler (server.ts:119), which logs "socket error:" instead —
  // an undocumented, version-dependent fallback we must not rely on. The guard
  // makes containment our own deterministic code path. Both paths happen to keep
  // the daemon alive on this Bun build, so survival alone would NOT be
  // fix-sensitive; the log path is.
  test("an onMessage throw is contained by OUR guard, not Bun's error fallback; mux survives (rank 2)", async () => {
    const errSpy = spyOn(console, "error");
    try {
      // First runner: its hello triggers a throw inside onMessage.
      throwOnMessageType = "hello";
      const bad = await connectClient();
      bad.write(
        Buffer.from(encodeFrame({ t: "hello", sid: "bad", cwd: "/a", pid: 1 })),
      );
      await Bun.sleep(80);

      // The throwing message was NOT recorded (it threw before push).
      expect(receivedMessages.some((m) => (m as IpcHello).sid === "bad")).toBe(
        false,
      );

      // The guard ran: an attributable "onMessage handler threw" line was
      // logged via OUR catch (with the simulated cause)...
      const logged = errSpy.mock.calls.map((c) => c.map(String).join(" "));
      expect(
        logged.some(
          (line) =>
            line.includes("onMessage handler threw") &&
            line.includes("simulated transient SQLite write failure"),
        ),
      ).toBe(true);
      // ...and the throw did NOT escape to Bun's socket `error` fallback
      // (pre-fix this is the ONLY line that appears — its absence proves the
      // guard caught it first).
      expect(logged.some((line) => line.includes("socket error:"))).toBe(false);

      // The daemon is still alive: a brand-new runner connects and its messages
      // flow through normally (throwOnMessageType auto-cleared after firing).
      const good = await connectClient();
      good.write(
        Buffer.from(
          encodeFrame({ t: "hello", sid: "good", cwd: "/b", pid: 2 }),
        ),
      );
      await Bun.sleep(80);

      expect(server.findRunnerBySid("good")).toBeDefined();
      expect(receivedMessages.some((m) => (m as IpcHello).sid === "good")).toBe(
        true,
      );

      good.end();
      bad.end();
    } finally {
      errSpy.mockRestore();
    }
  });

  // Socket-dirent-heal regression: the in-kernel listening socket survives a
  // dirent unlink, but the path becomes unreachable by connect() (macOS
  // AF_UNIX = VFS, no abstract namespace), so a live daemon goes silently
  // unreachable — every new `tp` client sees ENOENT, reports "not running",
  // and risks spawning a duplicate. The heal timer re-binds when it notices the
  // dirent vanished. This drives that path synchronously via __healNow().
  //
  // GENUINE-GUARD PROOF (source-only revert): revert just the heal logic
  // (make __healNow a no-op / drop the re-listen) and this test FAILS at the
  // post-heal connect, because the unlinked path stays ENOENT forever.
  test("re-binds the socket after its dirent is unlinked out from under a live daemon", async () => {
    const { unlinkSync, existsSync } = await import("fs");

    // An EXISTING runner connection (tracked by sid) must SURVIVE the re-bind:
    // re-binding drops only the listening socket, not already-accepted sockets.
    const survivor = await connectClient();
    survivor.write(
      Buffer.from(
        encodeFrame({ t: "hello", sid: "survivor", cwd: "/s", pid: 7 }),
      ),
    );
    await Bun.sleep(50);
    expect(server.findRunnerBySid("survivor")).toBeDefined();
    expect(existsSync(socketPath)).toBe(true);

    // Simulate the in-the-wild unlink (restart race / stray pre-unlink / OS
    // churn): the dirent is removed while the listening socket stays alive
    // in-kernel.
    unlinkSync(socketPath);
    expect(existsSync(socketPath)).toBe(false);

    // The split-brain symptom: the daemon is alive but unreachable by path.
    await expect(connectClient()).rejects.toThrow();

    // Heal (the heal timer's body, run synchronously). It must re-create a
    // usable dirent.
    const healed = server.__healNow();
    expect(healed).toBe(true);
    expect(existsSync(socketPath)).toBe(true);

    // The pre-existing runner is still registered after the re-bind, and the
    // daemon can still send to it (its accepted socket was untouched).
    const survivorRunner = server.findRunnerBySid("survivor");
    expect(survivorRunner).toBeDefined();
    if (survivorRunner) {
      server.send(survivorRunner, { t: "ack", sid: "survivor", seq: 1 });
    }

    // Reachable again: a brand-new client connects and its hello flows through.
    const after = await connectClient();
    after.write(
      Buffer.from(
        encodeFrame({ t: "hello", sid: "healed", cwd: "/h", pid: 9 }),
      ),
    );
    await Bun.sleep(50);
    expect(server.findRunnerBySid("healed")).toBeDefined();
    after.end();
    survivor.end();
  });

  // A healthy dirent must NOT trigger a needless re-bind (no churn, no dropped
  // listener) — __healNow returns false when the socket file is present.
  test("does not re-bind when the socket dirent is healthy", async () => {
    expect(server.__healNow()).toBe(false);
    // Still reachable (the original listener was untouched).
    const client = await connectClient();
    client.end();
  });

  // After stop(), the heal path is inert — a relisten must never resurrect a
  // socket the daemon deliberately tore down.
  test("does not heal after stop()", async () => {
    const { unlinkSync, existsSync } = await import("fs");
    server.stop();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    expect(server.__healNow()).toBe(false);
    expect(existsSync(socketPath)).toBe(false);
    // re-start so afterEach's stop() is a clean no-op pairing.
    server.start(socketPath);
  });
});
