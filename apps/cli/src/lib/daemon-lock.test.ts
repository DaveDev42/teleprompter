import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  acquireDaemonLock,
  checkDaemonLockAlive,
  getDaemonLockPath,
  readDaemonLockPid,
  releaseDaemonLock,
} from "@teleprompter/daemon";
import { getSocketPath } from "@teleprompter/protocol";
import * as fs from "fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

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

  test("closes the pid-file fd even when writeSync throws (no fd leak)", () => {
    // Regression guard: openSync('wx') hands back a live fd; if writeSync then
    // throws (e.g. ENOSPC on a near-full disk), the close MUST still run or the
    // fd leaks for the process lifetime. The try/finally in acquireDaemonLock
    // guarantees it. Pre-fix (sequential write→close), closeSync was skipped on a
    // write throw and this assertion failed.
    const closeSpy = spyOn(fs, "closeSync");
    const writeSpy = spyOn(fs, "writeSync").mockImplementation(() => {
      throw new Error("ENOSPC: simulated disk full");
    });
    let threw = false;
    try {
      acquireDaemonLock(lockPath);
    } catch {
      threw = true;
    }
    const closeCalled = closeSpy.mock.calls.length > 0;
    writeSpy.mockRestore();
    closeSpy.mockRestore();
    expect(threw).toBe(true);
    expect(closeCalled).toBe(true);
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
  const origRuntime = process.env["XDG_RUNTIME_DIR"];

  afterEach(() => {
    if (origRuntime === undefined) delete process.env["XDG_RUNTIME_DIR"];
    else process.env["XDG_RUNTIME_DIR"] = origRuntime;
  });

  test("honors XDG_RUNTIME_DIR", () => {
    // resolveRuntimeDir ensures the XDG dir exists (the daemon binds its socket
    // there), so use a writable temp dir rather than an unwritable literal.
    const xdg = mkdtempSync(join(tmpdir(), "tp-lock-xdg-"));
    try {
      process.env["XDG_RUNTIME_DIR"] = xdg;
      expect(getDaemonLockPath()).toBe(`${xdg}/daemon.pid`);
    } finally {
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("resolves to a runtime dir + daemon.pid when XDG_RUNTIME_DIR is unset", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    delete process.env["XDG_RUNTIME_DIR"];
    const uid = process.getuid();
    const path = getDaemonLockPath();
    // Either the systemd runtime dir (/run/user/<uid>, preferred when present)
    // or the /tmp fallback — both end in daemon.pid. resolveRuntimeDir owns the
    // choice; this only asserts the lock co-locates under it.
    expect(path).toMatch(
      new RegExp(`^(/run/user/${uid}|/tmp/teleprompter-${uid})/daemon\\.pid$`),
    );
  });

  // The bug class this guards: socket and lock must ALWAYS resolve to the same
  // directory. If they diverged (e.g. one keyed on /run/user and the other on
  // /tmp), a daemon would bind its socket in one place while the CLI looked for
  // the lock in another — exactly the WSL/systemd duplicate-daemon failure.
  test("lock path co-locates with the IPC socket path", () => {
    const savedXdg = process.env["XDG_RUNTIME_DIR"];
    // Writable temp dir — both resolvers mkdir the XDG dir before returning.
    const xdg = mkdtempSync(join(tmpdir(), "tp-lock-colocate-"));
    try {
      // Assert under both an explicit XDG dir and the unset/inferred case.
      process.env["XDG_RUNTIME_DIR"] = xdg;
      expect(dirname(getDaemonLockPath())).toBe(dirname(getSocketPath()));

      delete process.env["XDG_RUNTIME_DIR"];
      expect(dirname(getDaemonLockPath())).toBe(dirname(getSocketPath()));
    } finally {
      if (savedXdg === undefined) delete process.env["XDG_RUNTIME_DIR"];
      else process.env["XDG_RUNTIME_DIR"] = savedXdg;
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
