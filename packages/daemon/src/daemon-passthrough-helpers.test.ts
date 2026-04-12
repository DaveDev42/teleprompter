import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";
import { rmRetry } from "./store/test-helpers";

describe("Daemon passthrough helpers", () => {
  let storeDir: string;
  let daemon: Daemon;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "tp-passthrough-helpers-"));
    daemon = new Daemon(storeDir);
  });

  afterEach(() => {
    daemon.stop();
    rmRetry(storeDir);
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
});
