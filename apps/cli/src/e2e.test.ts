/**
 * Real E2E tests that spawn actual claude CLI through the full tp pipeline.
 *
 * These tests require `claude` to be installed and available in PATH.
 * They exercise the complete flow:
 *   tp CLI → Daemon → Runner → claude PTY → ANSI output → IPC → Store → WS
 *
 * Uses `claude -p` (non-interactive/print mode) for deterministic testing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon, SessionManager, Store } from "@teleprompter/daemon";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveRunnerCommand } from "./spawn";

// Skip entire suite if claude is not installed
const claudeAvailable = (await Bun.spawn(["which", "claude"]).exited) === 0;

/** Poll a condition until true or timeout */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 30000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

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

function waitForWsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.onclose = () => resolve();
  });
}

describe.skipIf(!claudeAvailable)("E2E with real claude", () => {
  let tmpDir: string;
  let storeDir: string;
  let socketPath: string;
  let daemon: Daemon;
  let wsPort: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tp-real-e2e-"));
    storeDir = join(tmpDir, "vault");
    mkdirSync(join(storeDir, "sessions"), { recursive: true });
    socketPath = join(tmpDir, "daemon.sock");
    daemon = new Daemon(storeDir);
    daemon.start(socketPath);
    daemon.startWs(0);
    wsPort = daemon.wsPort!;

    SessionManager.setRunnerCommand(resolveRunnerCommand());
  });

  afterEach(() => {
    SessionManager.setRunnerCommand(null as any);
    daemon.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("claude -p produces PTY output that reaches vault with ANSI sequences", async () => {
    const sid = "real-e2e-print";

    // claude -p in non-interactive mode
    daemon.createSession(sid, tmpDir, {
      claudeArgs: ["-p", "say exactly: TELEPROMPTER_TEST_OK"],
    });

    const store = new Store(storeDir);

    await waitFor(() => {
      const s = store.getSession(sid);
      return s?.state === "stopped" || s?.state === "error";
    }, 60000);

    const session = store.getSession(sid);
    expect(session).toBeDefined();
    expect(session!.state).toBe("stopped");
    expect(session!.last_seq).toBeGreaterThanOrEqual(1);

    // Read all io records and concatenate payloads
    const db = store.getSessionDb(sid);
    expect(db).toBeDefined();
    const records = db!.getRecordsFrom(0);
    const ioRecords = records.filter((r) => r.kind === "io");
    expect(ioRecords.length).toBeGreaterThanOrEqual(1);

    // Concatenate all io payloads — this is raw PTY output (may contain ANSI)
    const fullOutput = ioRecords
      .map((r) => Buffer.from(r.payload).toString("utf-8"))
      .join("");

    // The output should contain our test string (possibly wrapped in ANSI codes)
    expect(fullOutput).toContain("TELEPROMPTER_TEST_OK");

    // Verify it's actually PTY output (likely contains ANSI escape sequences or newlines)
    expect(fullOutput).toMatch(/[\r\n]/);

    store.close();
  }, 60000);

  test("claude args are passed through correctly", async () => {
    const sid = "real-e2e-args";

    // --version is fast and deterministic
    daemon.createSession(sid, tmpDir, {
      claudeArgs: ["--version"],
    });

    const store = new Store(storeDir);

    await waitFor(() => {
      const s = store.getSession(sid);
      return s?.state === "stopped" || s?.state === "error";
    }, 15000);

    const session = store.getSession(sid);
    expect(session).toBeDefined();

    const db = store.getSessionDb(sid);
    const records = db!.getRecordsFrom(0);
    const ioRecords = records.filter((r) => r.kind === "io");

    const fullOutput = ioRecords
      .map((r) => Buffer.from(r.payload).toString("utf-8"))
      .join("");

    // claude --version outputs version string like "2.1.81 (Claude Code)"
    expect(fullOutput).toMatch(/\d+\.\d+\.\d+/);
    expect(fullOutput).toContain("Claude Code");

    store.close();
  }, 15000);

  test("WS client receives real-time records from real claude session", async () => {
    const sid = "real-e2e-ws-stream";

    // Connect WS client first
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello", v: 1 }));
    await helloReply;

    // Attach to session before it starts
    ws.send(JSON.stringify({ t: "attach", sid }));
    await Bun.sleep(50);

    const wsMessages: any[] = [];
    ws.onmessage = (e) => wsMessages.push(JSON.parse(e.data as string));

    // Start the session with a quick claude command
    daemon.createSession(sid, tmpDir, {
      claudeArgs: ["--version"],
    });

    // Wait for session to complete
    await waitFor(
      () => wsMessages.some((m) => m.t === "state" && m.d?.state === "stopped"),
      15000,
    );

    // Should have received rec messages via WS
    const recMessages = wsMessages.filter((m: any) => m.t === "rec");
    expect(recMessages.length).toBeGreaterThanOrEqual(1);

    // First rec should be io kind with PTY data
    expect(recMessages[0].k).toBe("io");
    expect(recMessages[0].d).toBeDefined(); // base64 payload

    // Decode and verify content
    const payload = Buffer.from(recMessages[0].d, "base64").toString("utf-8");
    expect(payload.length).toBeGreaterThan(0);

    // Should have state updates
    const stateMessages = wsMessages.filter((m: any) => m.t === "state");
    expect(stateMessages.length).toBeGreaterThanOrEqual(1);

    ws.close();
    await waitForWsClose(ws);
  }, 15000);

  test("WS resume after real claude session completes", async () => {
    const sid = "real-e2e-ws-resume";

    daemon.createSession(sid, tmpDir, {
      claudeArgs: ["--version"],
    });

    const store = new Store(storeDir);

    await waitFor(() => {
      const s = store.getSession(sid);
      return s?.state === "stopped";
    }, 15000);

    const totalSeq = store.getSession(sid)!.last_seq;
    expect(totalSeq).toBeGreaterThanOrEqual(1);
    store.close();

    // Connect a "late" WS client and resume from cursor 0 (get all records)
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    await waitForWsOpen(ws);

    const helloReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "hello", v: 1 }));
    const hello = (await helloReply) as any;

    // Session should appear in the session list
    expect(hello.d.sessions.length).toBe(1);
    expect(hello.d.sessions[0].sid).toBe(sid);
    expect(hello.d.sessions[0].state).toBe("stopped");

    // Resume from cursor 0 → should get all records as batch
    const batchReply = waitForWsMessage(ws);
    ws.send(JSON.stringify({ t: "resume", sid, c: 0 }));
    const batch = (await batchReply) as any;

    expect(batch.t).toBe("batch");
    expect(batch.d.length).toBe(totalSeq);

    // Verify records are sequential
    for (let i = 0; i < batch.d.length; i++) {
      expect(batch.d[i].seq).toBe(i + 1);
    }

    ws.close();
    await waitForWsClose(ws);
  }, 15000);

  test("hooks events are captured from real claude session", async () => {
    const sid = "real-e2e-hooks";

    // Use -p which triggers hooks (SessionStart, Stop at minimum)
    // --bare skips hooks, so don't use it here
    daemon.createSession(sid, tmpDir, {
      claudeArgs: ["-p", "say hi"],
    });

    const store = new Store(storeDir);

    await waitFor(() => {
      const s = store.getSession(sid);
      return s?.state === "stopped" || s?.state === "error";
    }, 60000);

    const db = store.getSessionDb(sid);
    expect(db).toBeDefined();
    const records = db!.getRecordsFrom(0);

    // Should have both io and event records
    const ioRecords = records.filter((r) => r.kind === "io");
    const eventRecords = records.filter((r) => r.kind === "event");

    expect(ioRecords.length).toBeGreaterThanOrEqual(1);
    expect(eventRecords.length).toBeGreaterThanOrEqual(1);

    // Event records should have claude namespace and hook names
    for (const rec of eventRecords) {
      expect(rec.ns).toBe("claude");
      expect(rec.name).toBeDefined();
      // Parse payload to verify structure
      const payload = JSON.parse(Buffer.from(rec.payload).toString("utf-8"));
      expect(payload.hook_event_name).toBeDefined();
    }

    // Should have a Stop event (claude -p always fires Stop)
    const stopEvents = eventRecords.filter((r) => r.name === "Stop");
    expect(stopEvents.length).toBeGreaterThanOrEqual(1);

    store.close();
  }, 60000);
});
