import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { getWindowsSocketPath } from "@teleprompter/protocol";
import { rmRetry } from "@teleprompter/protocol/test-utils";
import { type Subprocess, spawn } from "bun";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = ["bun", "run", "apps/cli/src/index.ts"];

describe("tp pair new (blocking)", () => {
  let home: string;
  let env: Record<string, string>;
  let daemon: Subprocess | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-pair-blocking-"));
    // On Windows, getSocketPath() keys the Named Pipe name on
    // process.env.USERNAME, which would collide across parallel test runs
    // and across developer machines. Scope it to a unique per-test value
    // so we can run the test in isolation.
    const winUser =
      process.platform === "win32"
        ? `tp-blk-${process.pid}-${Date.now()}`
        : undefined;
    env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, "xdg"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      LOG_LEVEL: "error",
      // Prevent the first-run install prompt from waiting on stdin
      TP_NO_AUTO_INSTALL: "1",
      ...(winUser ? { USERNAME: winUser } : {}),
    } as Record<string, string>;
  });

  afterEach(async () => {
    try {
      daemon?.kill();
    } catch {
      /* noop */
    }
    daemon = null;
    await rmRetry(home);
  });

  test("SIGINT before frontend scan → exit 130, empty store", async () => {
    // Start daemon in a child process
    daemon = spawn({
      cmd: [...CLI, "daemon", "start"],
      env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });

    // Wait for daemon to accept connections. A successful connect + close is
    // the definitive readiness signal (more reliable than existsSync, which
    // is inconsistent for Windows Named Pipes across Bun/Node versions).
    const socketPath =
      process.platform === "win32"
        ? getWindowsSocketPath(env.USERNAME)
        : join(home, "runtime", "daemon.sock");
    const deadline = Date.now() + 5000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const probe = await Bun.connect({
          unix: socketPath,
          socket: { data() {}, open() {}, close() {}, error() {} },
        });
        probe.end();
        ready = true;
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(ready).toBe(true);

    // Run tp pair new
    const cli = spawn({
      cmd: [...CLI, "pair", "new"],
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    // Give pair.begin time to reach daemon and QR to print
    await Bun.sleep(1000);

    // Interrupt
    cli.kill("SIGINT");
    const code = await cli.exited;
    expect(code).toBe(130);

    // Store should have no pairings
    const storeDir = join(home, "xdg", "teleprompter", "vault");
    const store = new Store(storeDir);
    try {
      expect(store.listPairings().length).toBe(0);
    } finally {
      store.close();
    }
  }, 15_000);
});
