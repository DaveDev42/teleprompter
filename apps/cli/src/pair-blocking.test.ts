import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { type Subprocess, spawn } from "bun";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = ["bun", "run", "apps/cli/src/index.ts"];

describe.skipIf(process.platform === "win32")("tp pair new (blocking)", () => {
  let home: string;
  let env: Record<string, string>;
  let daemon: Subprocess | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-pair-blocking-"));
    env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: join(home, "xdg"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
      LOG_LEVEL: "error",
      // Prevent the first-run install prompt from waiting on stdin
      TP_NO_AUTO_INSTALL: "1",
    } as Record<string, string>;
  });

  afterEach(() => {
    try {
      daemon?.kill();
    } catch {
      /* noop */
    }
    daemon = null;
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
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

    // Wait for daemon socket to appear — poll
    const socketPath = join(home, "runtime", "daemon.sock");
    const deadline = Date.now() + 5000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    expect(existsSync(socketPath)).toBe(true);

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
