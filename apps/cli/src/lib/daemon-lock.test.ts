import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acquireDaemonLock,
  checkDaemonLockAlive,
  getDaemonLockPath,
  readDaemonLockPid,
  releaseDaemonLock,
} from "@teleprompter/daemon";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tp-daemon-lock-test-"));
  lockPath = join(dir, "daemon.pid");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireDaemonLock", () => {
  test("fresh acquire writes current pid and returns it", () => {
    const result = acquireDaemonLock(lockPath);
    expect(result).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(true);
    const written = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    expect(written).toBe(process.pid);
  });

  test("second acquire by same process returns null (live holder)", () => {
    acquireDaemonLock(lockPath);
    // Lock file now contains current pid — process is alive, so second call returns null
    const result = acquireDaemonLock(lockPath);
    expect(result).toBeNull();
  });

  test("stale pid (dead process) is cleaned up and fresh acquire succeeds", () => {
    // Write a pid that is definitely not alive
    const deadPid = 99999999;
    writeFileSync(lockPath, `${deadPid}\n`);
    const result = acquireDaemonLock(lockPath);
    expect(result).toBe(process.pid);
    const written = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    expect(written).toBe(process.pid);
  });

  test("corrupted lock file (non-numeric) is treated as stale", () => {
    writeFileSync(lockPath, "not-a-pid\n");
    const result = acquireDaemonLock(lockPath);
    expect(result).toBe(process.pid);
  });
});

describe("releaseDaemonLock", () => {
  test("removes the lock file when we are the holder", () => {
    acquireDaemonLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    releaseDaemonLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("no-op when file does not exist", () => {
    // Should not throw
    releaseDaemonLock(lockPath);
  });

  test("does not remove lock owned by a different pid", () => {
    // Write a foreign pid — releaseDaemonLock checks that file pid === process.pid
    writeFileSync(lockPath, `${process.pid + 1}\n`);
    releaseDaemonLock(lockPath);
    // File should still exist since it doesn't belong to us
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("readDaemonLockPid", () => {
  test("returns null when file missing", () => {
    expect(readDaemonLockPid(lockPath)).toBeNull();
  });

  test("returns the pid written in the file", () => {
    writeFileSync(lockPath, "12345\n");
    expect(readDaemonLockPid(lockPath)).toBe(12345);
  });

  test("returns null for non-numeric content", () => {
    writeFileSync(lockPath, "garbage");
    expect(readDaemonLockPid(lockPath)).toBeNull();
  });
});

describe("checkDaemonLockAlive", () => {
  test("returns null when no lock file", () => {
    expect(checkDaemonLockAlive(lockPath)).toBeNull();
  });

  test("returns pid when current process is the holder", () => {
    acquireDaemonLock(lockPath);
    expect(checkDaemonLockAlive(lockPath)).toBe(process.pid);
  });

  test("returns null for a dead pid", () => {
    writeFileSync(lockPath, "99999999\n");
    expect(checkDaemonLockAlive(lockPath)).toBeNull();
  });
});

describe("getDaemonLockPath", () => {
  const origRuntime = process.env.XDG_RUNTIME_DIR;

  afterEach(() => {
    if (origRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = origRuntime;
  });

  test("honors XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/custom/runtime";
    expect(getDaemonLockPath()).toBe("/custom/runtime/daemon.pid");
  });

  test("falls back to /tmp/teleprompter-<uid> when XDG_RUNTIME_DIR is unset", () => {
    delete process.env.XDG_RUNTIME_DIR;
    const path = getDaemonLockPath();
    expect(path).toMatch(/^\/tmp\/teleprompter-\d+\/daemon\.pid$/);
  });
});
