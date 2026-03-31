/**
 * End-to-end flow tests.
 *
 * These tests exercise the full pipeline:
 *   Runner (stub PTY) → IPC → Daemon → Vault + WS → Frontend (WS client)
 *
 * Instead of the real `claude` CLI, we use a stub script that spawns a simple
 * process in a PTY and generates both io output and hook events.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Daemon } from "./daemon";
import { SessionManager } from "./session/session-manager";
import { Store } from "./store";

const protocolSrc = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "packages",
  "protocol",
  "src",
  "index.ts",
);

// ── helpers ──

function waitForWsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
}

function waitForWsMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(e.data as string));
  });
}

function collectWsMessages(ws: WebSocket, messages: unknown[]): void {
  ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
}

function waitForWsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.onclose = () => resolve();
  });
}

/** Poll a condition until true or timeout */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

// ── test suite ──

describe("E2E flow", () => {
  let tmpDir: string;
  let storeDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let wsPort: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tp-e2e-"));
    storeDir = join(tmpDir, "vault");
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
    socketPath = join(tmpDir, "daemon.sock");
    daemon = new Daemon(storeDir);
    daemon.start(socketPath);
    daemon.startWs(0);
    // Extract the actual port from the WS server
    wsPort = daemon.wsPort!;
  });

  afterEach(() => {
    SessionManager.setRunnerCommand(null as unknown as string[]);
    daemon.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Full pipeline: Runner → Daemon → Vault → WS Client ───

  test("full pipeline: stub runner output reaches WS client via daemon", async () => {
    const sid = "e2e-full-pipeline";

    // Stub runner: connects to daemon IPC, sends hello + io record + event record + bye
    const stubPath = join(tmpDir, "stub-runner.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/e2e", pid: process.pid,
      }));

      setTimeout(() => {
        // io record
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "io", ts: Date.now(),
          payload: Buffer.from("hello from runner").toString("base64"),
        }));

        // event record (Stop hook)
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "event", ts: Date.now(),
          ns: "claude", name: "Stop",
          payload: Buffer.from(JSON.stringify({
            hook_event_name: "Stop",
            last_assistant_message: "Done!",
          })).toString("base64"),
        }));

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

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);

    // Connect WS client and attach to session before spawning
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    // Hello handshake
    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await helloReply;

    // Collect all subsequent messages
    const wsMessages: unknown[] = [];
    collectWsMessages(ws, wsMessages);

    // Now spawn the runner
    daemon.createSession(sid, tmpDir);

    // Wait until we get the "state" messages and "rec" messages via WS
    // The WS client needs to attach first to get rec broadcasts.
    // But state messages go to all clients via sendAll.
    await waitFor(() =>
      wsMessages.some((m) => {
        const msg = m as Record<string, unknown>;
        return (
          msg.t === "state" &&
          (msg.d as Record<string, unknown>)?.state === "running"
        );
      }),
    );

    // Attach to session to receive rec broadcasts
    ws.send(JSON.stringify({ t: "attach", sid }));
    await Bun.sleep(50);

    // Wait for session to stop
    await waitFor(() =>
      wsMessages.some((m) => {
        const msg = m as Record<string, unknown>;
        return (
          msg.t === "state" &&
          (msg.d as Record<string, unknown>)?.state === "stopped"
        );
      }),
    );

    // Verify store
    const store = new Store(storeDir);
    const session = store.getSession(sid);
    expect(session).toBeDefined();
    expect(session!.state).toBe("stopped");
    expect(session!.last_seq).toBe(2);

    const db = store.getSessionDb(sid);
    const records = db!.getRecordsFrom(0);
    expect(records.length).toBe(2);
    expect(records[0]!.kind).toBe("io");
    expect(records[1]!.kind).toBe("event");
    expect(records[1]!.name).toBe("Stop");

    // Verify WS client received state updates
    const stateMessages = wsMessages.filter(
      (m) => (m as Record<string, unknown>).t === "state",
    );
    expect(stateMessages.length).toBeGreaterThanOrEqual(2); // running + stopped

    store.close();
    ws.close();
    await waitForWsClose(ws);
  });

  // ─── 2. WS resume: reconnect and get backlog ───

  test("WS resume: client reconnects and receives backlog from vault", async () => {
    const sid = "e2e-resume";

    // Stub runner: sends hello + 5 records + bye
    const stubPath = join(tmpDir, "stub-runner-5.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/e2e", pid: process.pid,
      }));

      setTimeout(() => {
        for (let i = 0; i < 5; i++) {
          writer.write(s, encodeFrame({
            t: "rec", sid, kind: "io", ts: Date.now(),
            payload: Buffer.from("line-" + i).toString("base64"),
          }));
        }
        setTimeout(() => {
          writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 0 }));
          setTimeout(() => s.end(), 50);
        }, 100);
      }, 50);
    },
    close() {},
    error() {},
  },
});
`,
    );

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);
    daemon.createSession(sid, tmpDir);

    // Wait for session to finish
    const store = new Store(storeDir);
    await waitFor(() => store.getSession(sid)?.state === "stopped");
    expect(store.getSession(sid)!.last_seq).toBe(5);
    store.close();

    // Now simulate a "new" WS client connecting and resuming from cursor 3
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    const hello = (await helloReply) as Record<string, unknown>;
    expect(hello.t).toBe("hello");
    const helloData = hello.d as { sessions: Array<{ sid: string }> };
    expect(helloData.sessions.length).toBe(1);
    expect(helloData.sessions[0].sid).toBe(sid);

    // Resume from cursor 3 → should get records 4 and 5
    const batchReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "resume", sid, c: 3 }));
    const batch = (await batchReply) as Record<string, unknown>;

    expect(batch.t).toBe("batch");
    expect(batch.sid).toBe(sid);
    const batchData = batch.d as Array<{ seq: number }>;
    expect(batchData.length).toBe(2);
    expect(batchData[0].seq).toBe(4);
    expect(batchData[1].seq).toBe(5);

    ws.close();
    await waitForWsClose(ws);
  });

  // ─── 3. Multiple concurrent sessions ───

  test("multiple concurrent sessions: records don't leak between sessions", async () => {
    const sid1 = "e2e-multi-1";
    const sid2 = "e2e-multi-2";

    // Generic stub runner that sends N records based on env var
    const stubPath = join(tmpDir, "stub-runner-multi.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/" + sid, pid: process.pid,
      }));

      setTimeout(() => {
        for (let i = 0; i < 3; i++) {
          writer.write(s, encodeFrame({
            t: "rec", sid, kind: "io", ts: Date.now(),
            payload: Buffer.from(sid + "-data-" + i).toString("base64"),
          }));
        }
        setTimeout(() => {
          writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 0 }));
          setTimeout(() => s.end(), 50);
        }, 100);
      }, 50);
    },
    close() {},
    error() {},
  },
});
`,
    );

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);

    // Spawn both sessions
    daemon.createSession(sid1, tmpDir);
    daemon.createSession(sid2, tmpDir);

    // Wait for both to finish
    const store = new Store(storeDir);
    await waitFor(
      () =>
        store.getSession(sid1)?.state === "stopped" &&
        store.getSession(sid2)?.state === "stopped",
    );

    // Verify session 1
    const db1 = store.getSessionDb(sid1);
    expect(db1).toBeDefined();
    const records1 = db1!.getRecordsFrom(0);
    expect(records1.length).toBe(3);
    for (const rec of records1) {
      const payload = Buffer.from(rec.payload).toString("utf-8");
      expect(payload).toStartWith("e2e-multi-1-data-");
    }

    // Verify session 2
    const db2 = store.getSessionDb(sid2);
    expect(db2).toBeDefined();
    const records2 = db2!.getRecordsFrom(0);
    expect(records2.length).toBe(3);
    for (const rec of records2) {
      const payload = Buffer.from(rec.payload).toString("utf-8");
      expect(payload).toStartWith("e2e-multi-2-data-");
    }

    // Verify sessions are independent
    expect(store.listSessions().length).toBe(2);

    store.close();
  });

  // ─── 4. Runner crashes mid-stream (non-zero exit) ───

  test("runner crash: non-zero exit sets session state to error", async () => {
    const sid = "e2e-crash";

    const stubPath = join(tmpDir, "stub-runner-crash.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/crash", pid: process.pid,
      }));

      setTimeout(() => {
        // Send one record then crash with bye exitCode=1
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "io", ts: Date.now(),
          payload: Buffer.from("partial output").toString("base64"),
        }));

        setTimeout(() => {
          writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 1 }));
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

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);
    daemon.createSession(sid, tmpDir);

    const store = new Store(storeDir);
    await waitFor(() => {
      const s = store.getSession(sid);
      return s?.state === "error" || s?.state === "stopped";
    });

    const session = store.getSession(sid);
    expect(session!.state).toBe("error");
    expect(session!.last_seq).toBe(1);

    // Record before crash should still be persisted
    const db = store.getSessionDb(sid);
    const records = db!.getRecordsFrom(0);
    expect(records.length).toBe(1);

    store.close();
  });

  // ─── 5. WS client broadcast: records stream in real-time ───

  test("real-time streaming: WS client receives records as runner sends them", async () => {
    const sid = "e2e-streaming";

    // Stub runner that sends records with delays (simulating streaming)
    const stubPath = join(tmpDir, "stub-runner-stream.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    async open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/stream", pid: process.pid,
      }));

      await Bun.sleep(50);

      // Send 3 records with delays
      for (let i = 0; i < 3; i++) {
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "io", ts: Date.now(),
          payload: Buffer.from("chunk-" + i).toString("base64"),
        }));
        await Bun.sleep(30);
      }

      await Bun.sleep(50);
      writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 0 }));
      await Bun.sleep(50);
      s.end();
    },
    close() {},
    error() {},
  },
});
`,
    );

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);

    // Connect WS client first, attach to session
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await helloReply;

    // Pre-attach to sid so broadcasts reach us
    ws.send(JSON.stringify({ t: "attach", sid }));
    await Bun.sleep(50);

    const wsMessages: unknown[] = [];
    collectWsMessages(ws, wsMessages);

    // Now spawn runner
    daemon.createSession(sid, tmpDir);

    // Wait for session to complete
    await waitFor(() =>
      wsMessages.some((m) => {
        const msg = m as Record<string, unknown>;
        return (
          msg.t === "state" &&
          (msg.d as Record<string, unknown>)?.state === "stopped"
        );
      }),
    );

    // Verify we received the rec broadcasts
    const recMessages = wsMessages.filter((m) => {
      const msg = m as Record<string, unknown>;
      return msg.t === "rec" && msg.sid === sid;
    }) as Array<Record<string, unknown>>;
    expect(recMessages.length).toBe(3);
    expect(recMessages[0].seq).toBe(1);
    expect(recMessages[1].seq).toBe(2);
    expect(recMessages[2].seq).toBe(3);

    // Verify ordering
    for (let i = 0; i < recMessages.length; i++) {
      const payload = Buffer.from(
        recMessages[i].d as string,
        "base64",
      ).toString("utf-8");
      expect(payload).toBe(`chunk-${i}`);
    }

    ws.close();
    await waitForWsClose(ws);
  });

  // ─── 6. WS input relay: frontend → daemon → runner ───

  test("input relay: WS in.term reaches runner via daemon IPC", async () => {
    const sid = "e2e-input-relay";

    // Stub runner that waits for input from daemon, echoes it back as a record
    const stubPath = join(tmpDir, "stub-runner-input.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, FrameDecoder, QueuedWriter } from "${protocolSrc}";

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
const decoder = new FrameDecoder();
let gotInput = false;

await Bun.connect({
  unix: socketPath,
  socket: {
    data(s, data) {
      const msgs = decoder.decode(new Uint8Array(data));
      for (const msg of msgs) {
        if ((msg as any).t === "input" && !gotInput) {
          gotInput = true;
          // Echo the received input back as an io record
          const inputText = Buffer.from((msg as any).data, "base64").toString("utf-8");
          writer.write(s, encodeFrame({
            t: "rec", sid, kind: "io", ts: Date.now(),
            payload: Buffer.from("echo:" + inputText).toString("base64"),
          }));
          setTimeout(() => {
            writer.write(s, encodeFrame({ t: "bye", sid, exitCode: 0 }));
            setTimeout(() => s.end(), 50);
          }, 50);
        }
      }
    },
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/input", pid: process.pid,
      }));
    },
    close() {},
    error() {},
  },
});

// Timeout safety: exit after 5s if no input received
setTimeout(() => {
  if (!gotInput) process.exit(1);
}, 5000);
`,
    );

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);
    daemon.createSession(sid, tmpDir);

    // Wait for session to be created (hello processed)
    const store = new Store(storeDir);
    await waitFor(() => store.getSession(sid)?.state === "running");

    // Connect WS client and send terminal input
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    await helloReply;

    ws.send(JSON.stringify({ t: "attach", sid }));
    await Bun.sleep(50);

    // Send terminal input via WS
    const inputData = Buffer.from("user-typed-text\n").toString("base64");
    ws.send(JSON.stringify({ t: "in.term", sid, d: inputData }));

    // Wait for the runner to echo it back and session to stop
    await waitFor(() => store.getSession(sid)?.state === "stopped");

    // Verify the echoed record
    const db = store.getSessionDb(sid);
    const records = db!.getRecordsFrom(0);
    expect(records.length).toBe(1);
    const payload = Buffer.from(records[0]!.payload).toString("utf-8");
    expect(payload).toBe("echo:user-typed-text\n");

    store.close();
    ws.close();
    await waitForWsClose(ws);
  });

  // ─── 7. Runner abrupt disconnect (no bye) ───

  test("abrupt disconnect: runner exits without sending bye", async () => {
    const sid = "e2e-abrupt";

    const stubPath = join(tmpDir, "stub-runner-abrupt.ts");
    writeFileSync(
      stubPath,
      `
import { parseArgs } from "util";
import { encodeFrame, QueuedWriter } from "${protocolSrc}";

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

await Bun.connect({
  unix: socketPath,
  socket: {
    data() {},
    drain(s) { writer.drain(s); },
    open(s) {
      writer.write(s, encodeFrame({
        t: "hello", sid, cwd: "/tmp/abrupt", pid: process.pid,
      }));

      setTimeout(() => {
        writer.write(s, encodeFrame({
          t: "rec", sid, kind: "io", ts: Date.now(),
          payload: Buffer.from("before-crash").toString("base64"),
        }));

        // Abruptly exit without sending bye
        setTimeout(() => process.exit(1), 50);
      }, 50);
    },
    close() {},
    error() {},
  },
});
`,
    );

    SessionManager.setRunnerCommand(["bun", "run", stubPath]);
    daemon.createSession(sid, tmpDir);

    // Wait for the runner process to exit
    await Bun.sleep(500);

    // The record before crash should be persisted
    const store = new Store(storeDir);
    const db = store.getSessionDb(sid);
    if (db) {
      const records = db.getRecordsFrom(0);
      expect(records.length).toBe(1);
      const payload = Buffer.from(records[0]!.payload).toString("utf-8");
      expect(payload).toBe("before-crash");
    }

    // Session state should still be "running" since no bye was sent
    // (daemon doesn't auto-detect runner crashes without bye)
    const session = store.getSession(sid);
    expect(session).toBeDefined();
    expect(session!.state).toBe("running");

    store.close();
  });
});
