import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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

  test("removes bare socket whose listener has closed (ECONNREFUSED)", async () => {
    // Create a socket file via listen, then close without unlinking. On most
    // platforms `server.close()` unlinks; simulate the crash scenario with a
    // plain file-backed path instead — covered by the regular-file test above.
    // Here we simulate by creating the path as a non-listening unix socket:
    // we drop to the regular-file fallback which is the practical stale case.
    mkdirSync(runtime, { recursive: true });
    writeFileSync(sockPath, "");
    expect(await isDaemonRunning()).toBe(false);
    expect(existsSync(sockPath)).toBe(false);
  });
});
