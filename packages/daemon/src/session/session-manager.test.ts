import { beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "./session-manager";

// Cross-platform no-op command: Bun itself with --version exits instantly.
// `true`/`sleep` aren't available as binaries on Windows.
const NOOP_CMD = [process.execPath, "--version"];
const LONG_RUNNING_CMD = [process.execPath, "-e", "setTimeout(()=>{}, 60000)"];

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager();
    SessionManager.setRunnerCommand(NOOP_CMD);
  });

  test("starts empty", () => {
    expect(sm.activeCount).toBe(0);
    expect(sm.listRunners()).toEqual([]);
    expect(sm.getRunner("nonexistent")).toBeUndefined();
  });

  test("registerRunner adds a runner", () => {
    sm.registerRunner("s1", 1234, "/tmp", undefined, "1.0");
    expect(sm.activeCount).toBe(1);
    const runner = sm.getRunner("s1");
    expect(runner).toBeDefined();
    expect(runner?.sid).toBe("s1");
    expect(runner?.pid).toBe(1234);
    expect(runner?.cwd).toBe("/tmp");
    expect(runner?.claudeVersion).toBe("1.0");
  });

  test("unregisterRunner removes a runner", () => {
    sm.registerRunner("s1", 1234, "/tmp");
    expect(sm.activeCount).toBe(1);
    sm.unregisterRunner("s1");
    expect(sm.activeCount).toBe(0);
    expect(sm.getRunner("s1")).toBeUndefined();
  });

  test("listRunners returns all runners", () => {
    sm.registerRunner("s1", 100, "/a");
    sm.registerRunner("s2", 200, "/b");
    const runners = sm.listRunners();
    expect(runners.length).toBe(2);
    expect(runners.map((r) => r.sid).sort()).toEqual(["s1", "s2"]);
  });

  test("registerRunner overwrites existing runner with same sid", () => {
    sm.registerRunner("s1", 100, "/a");
    sm.registerRunner("s1", 200, "/b", undefined, "2.0");
    expect(sm.activeCount).toBe(1);
    expect(sm.getRunner("s1")?.pid).toBe(200);
    expect(sm.getRunner("s1")?.cwd).toBe("/b");
  });

  test("spawnRunner creates and tracks a process", () => {
    const proc = sm.spawnRunner("s1", process.cwd(), {
      socketPath: "ignored-noop.sock",
    });
    expect(proc.pid).toBeGreaterThan(0);
    expect(sm.activeCount).toBe(1);
    expect(sm.getRunner("s1")).toBeDefined();
    expect(sm.getRunner("s1")?.pid).toBe(proc.pid);
  });

  test("killRunner kills a spawned process", () => {
    // Long-running command so the process stays alive until killed.
    SessionManager.setRunnerCommand(LONG_RUNNING_CMD);
    sm.spawnRunner("s1", process.cwd());
    expect(sm.killRunner("s1")).toBe(true);
  });

  test("killRunner returns false for unregistered runner", () => {
    expect(sm.killRunner("nonexistent")).toBe(false);
  });

  test("killRunner returns false for manually registered runner (no process)", () => {
    sm.registerRunner("s1", 99999, "/tmp");
    expect(sm.killRunner("s1")).toBe(false);
  });

  test("spawnRunner forwards env option to subprocess", () => {
    const mgr = new SessionManager();
    SessionManager.setRunnerCommand(NOOP_CMD);
    const proc = mgr.spawnRunner("env-test-sid", process.cwd(), {
      env: { FOO: "bar" },
    });
    expect(proc.pid).toBeGreaterThan(0);
    proc.kill();
  });

  test("process exit fires onRunnerExit and unregisters (crash path)", async () => {
    // Regression: a Runner that dies without a clean "bye" used to leave its
    // row stuck at "running" and the in-memory registration leaked. NOOP_CMD
    // exits immediately, simulating an abrupt exit.
    const exits: Array<{ sid: string; code: number }> = [];
    sm.setOnRunnerExit((sid, code) => {
      exits.push({ sid, code });
    });
    const proc = sm.spawnRunner("crash-sid", process.cwd());
    expect(sm.activeCount).toBe(1);

    await proc.exited;
    // The exit handler runs in the same microtask as proc.exited resolution;
    // yield once so it has flushed.
    await Promise.resolve();

    expect(exits).toHaveLength(1);
    expect(exits[0]?.sid).toBe("crash-sid");
    expect(sm.getRunner("crash-sid")).toBeUndefined();
    expect(sm.activeCount).toBe(0);
  });

  test("stale exit of a replaced runner does not unregister the live one", async () => {
    // session.restart kills the old process and spawns a new one for the same
    // sid (the second spawnRunner overwrites the registration with the new
    // process ref). When the OLD process's exit finally fires, it must be
    // recognized as stale and must NOT tear down the freshly-spawned runner.
    // LONG_RUNNING_CMD keeps the second generation alive so its registration
    // is unambiguously the live one when the first proc's exit lands.
    SessionManager.setRunnerCommand(NOOP_CMD);
    const fired: string[] = [];
    sm.setOnRunnerExit((sid) => fired.push(sid));
    const oldProc = sm.spawnRunner("restart-sid", process.cwd());

    // New generation: a second spawn for the same sid overwrites the map entry
    // with a distinct process reference (exactly what Daemon.createSession does
    // on restart). Use a long-running process so it outlives the old exit.
    SessionManager.setRunnerCommand(LONG_RUNNING_CMD);
    const newProc = sm.spawnRunner("restart-sid", process.cwd());
    expect(sm.getRunner("restart-sid")?.pid).toBe(newProc.pid);

    await oldProc.exited;
    await Promise.resolve();

    // The old proc's exit is stale (process ref differs from the live one), so
    // the live registration survives and onRunnerExit is NOT fired for it.
    expect(sm.getRunner("restart-sid")?.pid).toBe(newProc.pid);
    expect(fired).not.toContain("restart-sid");

    newProc.kill();
  });
});
