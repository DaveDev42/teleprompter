import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync } from "fs";
import { dirname } from "path";
import { getSocketPath } from "./socket-path";

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
    const savedXdg = process.env["XDG_RUNTIME_DIR"];
    try {
      // Force the /tmp fallback branch.
      delete process.env["XDG_RUNTIME_DIR"];
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
      if (savedXdg === undefined) delete process.env["XDG_RUNTIME_DIR"];
      else process.env["XDG_RUNTIME_DIR"] = savedXdg;
    }
  });

  test("tightens a pre-existing loose-mode fallback directory to 0700", () => {
    if (typeof process.getuid !== "function") return; // POSIX-only (no Windows)
    const savedXdg = process.env["XDG_RUNTIME_DIR"];
    try {
      delete process.env["XDG_RUNTIME_DIR"];
      // Pre-create the fallback dir with a deliberately loose mode, simulating a
      // directory left behind by an earlier run under a permissive umask.
      const dir = `/tmp/teleprompter-${process.getuid()}`;
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      // getSocketPath must chmod it back down to 0700 (defense in depth).
      getSocketPath();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      if (savedXdg === undefined) delete process.env["XDG_RUNTIME_DIR"];
      else process.env["XDG_RUNTIME_DIR"] = savedXdg;
    }
  });
});
