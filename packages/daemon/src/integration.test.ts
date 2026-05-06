import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  type IpcAck,
  type IpcBye,
  type IpcHello,
  type IpcRec,
} from "@teleprompter/protocol";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HookReceiver } from "../../runner/src/hooks/hook-receiver";
import { Daemon } from "./daemon";
import { SessionManager } from "./session/session-manager";
import { Store } from "./store";

describe("Integration", () => {
  let tmpDir: string;
  let storeDir: string;
  let socketPath: string;
  let daemon: Daemon;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tp-integration-"));
    storeDir = join(tmpDir, "vault");
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
    socketPath = join(tmpDir, "daemon.sock");
    daemon = new Daemon(storeDir);
    daemon.start(socketPath);
  });

  afterEach(async () => {
    daemon.stop();
    await rmRetry(tmpDir);
  });

  test("mock runner pipeline: hello → rec → bye → store verify", async () => {
    const sid = "test-session-1";
    const decoder = new FrameDecoder();
    const acks: IpcAck[] = [];

    // Connect as mock runner
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, data) {
          const frames = decoder.decode(new Uint8Array(data));
          for (const frame of frames) {
            acks.push(frame.data as IpcAck);
          }
        },
        open() {},
        close() {},
        error() {},
      },
    });

    // Send hello
    const hello: IpcHello = {
      t: "hello",
      sid,
      cwd: join(tmpdir(), "project"),
      pid: process.pid,
    };
    socket.write(encodeFrame(hello));

    // Small delay for processing
    await Bun.sleep(50);

    // Send records
    const rec1: IpcRec = {
      t: "rec",
      sid,
      kind: "io",
      ts: Date.now(),
      payload: Buffer.from("hello world").toString("base64"),
    };
    socket.write(encodeFrame(rec1));

    const rec2: IpcRec = {
      t: "rec",
      sid,
      kind: "event",
      ts: Date.now(),
      ns: "claude",
      name: "Stop",
      payload: Buffer.from(
        JSON.stringify({
          hook_event_name: "Stop",
          last_assistant_message: "Hi!",
        }),
      ).toString("base64"),
    };
    socket.write(encodeFrame(rec2));

    await Bun.sleep(100);

    // Send bye
    const bye: IpcBye = { t: "bye", sid, exitCode: 0 };
    socket.write(encodeFrame(bye));
    socket.end();

    await Bun.sleep(200);

    // Verify store
    const store = new Store(storeDir);
    const session = store.getSession(sid);
    if (!session) throw new Error("expected session");
    expect(session.state).toBe("stopped");
    expect(session.last_seq).toBe(2);

    const db = store.getSessionDb(sid);
    if (!db) throw new Error("expected db");
    const records = db.getRecordsFrom(0);
    expect(records.length).toBe(2);
    const storedRec0 = records[0];
    const storedRec1 = records[1];
    if (!storedRec0 || !storedRec1) throw new Error("expected records");
    expect(storedRec0.kind).toBe("io");
    expect(storedRec1.kind).toBe("event");
    expect(storedRec1.name).toBe("Stop");

    // Verify acks received
    expect(acks.length).toBe(2);
    const ack0 = acks[0];
    const ack1 = acks[1];
    if (!ack0 || !ack1) throw new Error("expected acks");
    expect(ack0.t).toBe("ack");
    expect(ack0.seq).toBe(1);
    expect(ack1.seq).toBe(2);

    store.close();
  });

  test("backpressure: 10000 records burst", async () => {
    const sid = "test-burst";
    const decoder = new FrameDecoder();
    let _ackCount = 0;
    const writer = new (await import("@teleprompter/protocol")).QueuedWriter();

    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, data) {
          const messages = decoder.decode(new Uint8Array(data));
          _ackCount += messages.length;
        },
        drain(socket) {
          writer.drain(socket);
        },
        open() {},
        close() {},
        error() {},
      },
    });

    // Hello
    writer.write(
      socket,
      encodeFrame({
        t: "hello",
        sid,
        cwd: tmpDir,
        pid: process.pid,
      } as IpcHello),
    );
    await Bun.sleep(20);

    // Burst 10000 records
    const total = 10000;
    for (let i = 0; i < total; i++) {
      const rec: IpcRec = {
        t: "rec",
        sid,
        kind: "io",
        ts: Date.now(),
        payload: Buffer.from(`data-${i}`).toString("base64"),
      };
      writer.write(socket, encodeFrame(rec));
    }

    // Wait for processing — drain + server-side sqlite writes
    // Allow up to 50s (500 * 100ms) for slow CI runners
    for (let i = 0; i < 500; i++) {
      await Bun.sleep(100);
      const v = new Store(storeDir);
      const db = v.getSessionDb(sid);
      if (db && db.getLastSeq() >= total) {
        v.close();
        break;
      }
      v.close();
    }

    writer.write(socket, encodeFrame({ t: "bye", sid, exitCode: 0 } as IpcBye));
    socket.end();
    await Bun.sleep(100);

    // Verify all records stored
    const store = new Store(storeDir);
    const db = store.getSessionDb(sid);
    if (!db) throw new Error("expected db");
    expect(db.getLastSeq()).toBe(total);
    store.close();
  }, 60_000);

  test("hook receiver: JSON event → onEvent callback", async () => {
    const hookSocketPath = join(tmpDir, "hook-test.sock");
    const receivedEvents: unknown[] = [];

    const receiver = new HookReceiver(hookSocketPath, (event) => {
      receivedEvents.push(event);
    });
    receiver.start();

    // Simulate hook script sending JSON
    const event = {
      session_id: "s1",
      hook_event_name: "Stop",
      cwd: tmpDir,
      last_assistant_message: "Done!",
    };

    const _hookSocket = await Bun.connect({
      unix: hookSocketPath,
      socket: {
        open(socket) {
          socket.write(JSON.stringify(event));
          socket.end();
        },
        data() {},
        close() {},
        error() {},
      },
    });

    await Bun.sleep(100);

    expect(receivedEvents.length).toBe(1);
    expect(
      (receivedEvents[0] as { hook_event_name: string }).hook_event_name,
    ).toBe("Stop");

    receiver.stop();
  });

  test("pushNotifier: Notification event triggers sendPush with parsed payload", async () => {
    const sid = "test-push-pipeline";
    const decoder = new FrameDecoder();

    type PushCall = [string, string, string, string, unknown];
    const pushCalls: PushCall[] = [];

    // Replace the PushNotifier deps with a spy. Reach into the daemon to
    // register a token so the notifier doesn't short-circuit on empty map.
    // biome-ignore lint/suspicious/noExplicitAny: test reaches private field
    const pn: any = (daemon as any).pushNotifier;
    pn.deps.sendPush = (
      frontendId: string,
      token: string,
      title: string,
      body: string,
      data: { sid: string; event: string },
    ) => {
      pushCalls.push([frontendId, token, title, body, data]);
    };
    pn.registerToken("fe-test", "tok-test", "ios");

    // Open the runner IPC socket, hello + Notification record + bye.
    const socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, data) {
          decoder.decode(new Uint8Array(data));
        },
        open() {},
        close() {},
        error() {},
      },
    });

    const hello: IpcHello = {
      t: "hello",
      sid,
      cwd: join(tmpdir(), "project"),
      pid: process.pid,
    };
    socket.write(encodeFrame(hello));
    await Bun.sleep(30);

    const rec: IpcRec = {
      t: "rec",
      sid,
      kind: "event",
      ts: Date.now(),
      ns: "claude",
      name: "Notification",
      payload: Buffer.from(
        JSON.stringify({
          session_id: sid,
          hook_event_name: "Notification",
          cwd: "/tmp",
          message: "Claude needs your permission to use Bash",
        }),
      ).toString("base64"),
    };
    socket.write(encodeFrame(rec));
    await Bun.sleep(50);

    const bye: IpcBye = { t: "bye", sid, exitCode: 0 };
    socket.write(encodeFrame(bye));
    socket.end();

    await Bun.sleep(50);

    expect(pushCalls.length).toBe(1);
    const call = pushCalls[0];
    if (!call) throw new Error("expected push call");
    const [frontendId, token, title, body, data] = call;
    expect(frontendId).toBe("fe-test");
    expect(token).toBe("tok-test");
    expect(title).toBe("Permission needed");
    expect(body).toBe("Claude needs your permission to use Bash");
    expect(data).toEqual({ sid, event: "Notification" });
  });

  test("self-spawn: daemon.createSession() spawns stub runner via setRunnerCommand", async () => {
    const sid = "test-self-spawn";

    // Write a stub runner script that mimics the real runner's CLI interface
    // but only sends hello → rec → bye over IPC and exits
    const stubPath = join(tmpDir, "stub-runner.ts");
    const protocolPath = join(
      __dirname,
      "..",
      "..",
      "..",
      "packages",
      "protocol",
      "src",
      "index.ts",
    ).replaceAll("\\", "/");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolPath}";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    sid: { type: "string" },
    cwd: { type: "string" },
    "socket-path": { type: "string" },
  },
  strict: false,
});

const sid = values.sid!;
const socketPath = values["socket-path"]!;
const writer = new QueuedWriter();

const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      // hello
      writer.write(s, encodeFrame({ t: "hello", sid, cwd: "${tmpDir}/stub", pid: process.pid }));

      // record
      setTimeout(() => {
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "io", ts: Date.now(),
          payload: Buffer.from("stub-output").toString("base64"),
        }));

        // bye
        setTimeout(() => {
          writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 0 }));
          setTimeout(() => s.end(), 50);
        }, 50);
      }, 50);
    },
    close() {},
    error() {},
  },
});
`,
    );

    // Inject stub as the runner command
    SessionManager.setRunnerCommand(["bun", "run", stubPath]);

    try {
      // This triggers spawnRunner internally
      daemon.createSession(sid, tmpDir);

      // Poll vault until session is stopped or timeout
      const store = new Store(storeDir);
      let stopped = false;
      for (let i = 0; i < 50; i++) {
        await Bun.sleep(100);
        const session = store.getSession(sid);
        if (session?.state === "stopped") {
          stopped = true;
          break;
        }
      }

      expect(stopped).toBe(true);

      const session = store.getSession(sid);
      if (!session) throw new Error("expected session");
      expect(session.state).toBe("stopped");
      expect(session.last_seq).toBe(1);

      const db = store.getSessionDb(sid);
      if (!db) throw new Error("expected db");
      const records = db.getRecordsFrom(0);
      expect(records.length).toBe(1);
      const rec0 = records[0];
      if (!rec0) throw new Error("expected record");
      expect(rec0.kind).toBe("io");

      store.close();
    } finally {
      // Reset runner command for other tests
      SessionManager.setRunnerCommand(null as unknown as string[]);
    }
  });
});
