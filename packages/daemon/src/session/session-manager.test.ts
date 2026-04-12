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
});
