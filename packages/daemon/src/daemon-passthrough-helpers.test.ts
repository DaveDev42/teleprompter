import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";

// Skipped on Windows: this suite constructs a Daemon which opens an IPC
// server bound to a Unix domain socket path. Windows IPC uses Named Pipes
// via a different code path, so the helper surface exercised here is not
// directly applicable on win32.
describe.skipIf(process.platform === "win32")(
  "Daemon passthrough helpers",
  () => {
    let storeDir: string;
    let daemon: Daemon;

    beforeEach(() => {
      storeDir = mkdtempSync(join(tmpdir(), "tp-passthrough-helpers-"));
      daemon = new Daemon(storeDir);
    });

    afterEach(() => {
      daemon.stop();
      rmSync(storeDir, { recursive: true, force: true });
    });

    test("onRecord callback is a nullable public property", () => {
      expect(daemon.onRecord).toBeNull();
      let called = false;
      daemon.onRecord = () => {
        called = true;
      };
      daemon.onRecord("sid", "io", Buffer.from("x"));
      expect(called).toBe(true);
    });

    test("sendInput is a no-op when no runner is connected", () => {
      daemon.sendInput("nonexistent-sid", Buffer.from("hello"));
    });

    test("resizeSession is a no-op when no runner is connected", () => {
      daemon.resizeSession("nonexistent-sid", 80, 24);
    });
  },
);
