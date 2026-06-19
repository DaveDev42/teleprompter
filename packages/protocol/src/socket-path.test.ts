import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { dirname } from "path";
import { getSocketPath, resolveRuntimeDir } from "./socket-path";

describe("getSocketPath", () => {
  test("returns a path ending with daemon.sock", () => {
    const path = getSocketPath();
    expect(path).toMatch(/daemon\.sock$/);
  });

  test("returns a consistent path on repeated calls", () => {
    const path1 = getSocketPath();
    const path2 = getSocketPath();
    expect(path1).toBe(path2);
  });

  test("path contains expected directory structure", () => {
    const path = getSocketPath();
    // Either XDG_RUNTIME_DIR or /tmp/teleprompter-{uid}
    expect(path).toMatch(/teleprompter|daemon\.sock/);
  });

  // Security regression: the /tmp fallback directory holds the daemon IPC
  // socket and lives in world-writable /tmp shared across local users. It used
  // to be created without a mode, so under a loose umask it could be
  // world-readable/traversable. getSocketPath must force it to 0700.
  test("creates a fresh /tmp fallback directory with 0700 permissions", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    // The /tmp branch only runs when XDG is unset AND /run/user/<uid> is absent
    // (resolveRuntimeDir prefers the systemd dir when present). Skip where it
    // exists — the systemd-dir preference is covered separately.
    if (existsSync(`/run/user/${process.getuid()}`)) return;
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    try {
      // Force the /tmp fallback branch.
      delete process.env.XDG_RUNTIME_DIR;
      // Remove any directory left by a prior test so this asserts the
      // freshly-created mode, not a pre-existing one (the chmod path is
      // covered by the next test). force:true so a missing dir is fine.
      const dir = `/tmp/teleprompter-${process.getuid()}`;
      rmSync(dir, { recursive: true, force: true });
      const path = getSocketPath();
      expect(dirname(path)).toBe(dir);
      // Mask to the permission bits; the directory must be owner-only (0700).
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });

  test("tightens a pre-existing loose-mode fallback directory to 0700", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    // Same gate as above: the chmod-tightening only fires on the /tmp branch,
    // which resolveRuntimeDir skips when /run/user/<uid> is present.
    if (existsSync(`/run/user/${process.getuid()}`)) return;
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      // Pre-create the fallback dir with a deliberately loose mode, simulating a
      // directory left behind by an earlier run under a permissive umask.
      const dir = `/tmp/teleprompter-${process.getuid()}`;
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      // getSocketPath must chmod it back down to 0700 (defense in depth).
      getSocketPath();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });

  test("honors XDG_RUNTIME_DIR when set", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    try {
      const xdg = `/tmp/xdg-runtime-test-${process.getuid()}`;
      mkdirSync(xdg, { recursive: true });
      process.env.XDG_RUNTIME_DIR = xdg;
      expect(getSocketPath()).toBe(`${xdg}/daemon.sock`);
      expect(resolveRuntimeDir()).toBe(xdg);
      rmSync(xdg, { recursive: true, force: true });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });
});

// Regression guard for the WSL/systemd duplicate-daemon bug: a systemd `--user`
// daemon binds its socket under XDG_RUNTIME_DIR=/run/user/<uid>, but an
// interactive WSL login shell has XDG_RUNTIME_DIR unset. If resolveRuntimeDir
// fell straight through to /tmp in that case, the interactive `tp` would miss
// the running daemon, report "not running", and spawn a duplicate → SQLITE_BUSY.
describe("resolveRuntimeDir — systemd /run/user preference", () => {
  test("prefers /run/user/<uid> over /tmp when XDG unset and it exists", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    const uid = process.getuid();
    const systemdDir = `/run/user/${uid}`;
    // This branch can only be exercised where /run/user/<uid> actually exists
    // (a real systemd login — Linux desktop, WSL with systemd). On macOS / CI
    // runners without it, the dir is absent so we skip rather than fabricate it
    // (creating under /run requires root and would not model the real signal).
    if (!existsSync(systemdDir)) return;
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      expect(resolveRuntimeDir()).toBe(systemdDir);
      expect(getSocketPath()).toBe(`${systemdDir}/daemon.sock`);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });

  test("falls back to /tmp when XDG unset and /run/user/<uid> absent", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    const uid = process.getuid();
    if (existsSync(`/run/user/${uid}`)) return; // only meaningful without it
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      expect(resolveRuntimeDir()).toBe(`/tmp/teleprompter-${uid}`);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
    }
  });
});
