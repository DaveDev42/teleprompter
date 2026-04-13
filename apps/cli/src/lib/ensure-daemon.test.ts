import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getSocketPath } from "@teleprompter/protocol";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { isDaemonRunning } from "./ensure-daemon";

// Unix-only: Windows named pipes take a different path in isDaemonRunning.
describe.skipIf(process.platform === "win32")("isDaemonRunning", () => {
  let runtime: string;
  let sockPath: string;
  const origRuntime = process.env.XDG_RUNTIME_DIR;

  beforeEach(() => {
    runtime = mkdtempSync(join(tmpdir(), "tp-ensure-daemon-"));
    process.env.XDG_RUNTIME_DIR = runtime;
    sockPath = join(runtime, "daemon.sock");
    // Guard against platform-specific socket-path resolution (e.g. macOS
    // falling back to TMPDIR). If this fails the other assertions would
    // silently test the developer's real daemon socket.
    if (getSocketPath() !== sockPath) {
      throw new Error(
        `getSocketPath() did not honor XDG_RUNTIME_DIR (got ${getSocketPath()})`,
      );
    }
  });

  afterEach(() => {
    if (origRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = origRuntime;
    rmSync(runtime, { recursive: true, force: true });
  });

  test("returns false when socket file does not exist", async () => {
    expect(await isDaemonRunning()).toBe(false);
  });

  test("removes stale regular file masquerading as socket", async () => {
    writeFileSync(sockPath, "");
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });

  test("returns true against a real listening socket", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      expect(await isDaemonRunning()).toBe(true);
      // File should still exist — live socket must not be unlinked.
      expect(existsSync(sockPath)).toBe(true);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
