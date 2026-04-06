import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { createPtyManager } from "./pty-manager";

// PtyBun tests — only run on macOS/Linux (Bun.spawn terminal is Unix-only)
describe.skipIf(process.platform === "win32")("PtyManager", () => {
  test("spawns a command and receives output", async () => {
    const pty = createPtyManager();
    const chunks: Uint8Array[] = [];
    let exitCode = -1;

    pty.spawn({
      command: ["echo", "hello from pty"],
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      onData: (data) => chunks.push(data),
      onExit: (code) => {
        exitCode = code;
      },
    });

    expect(pty.pid).toBeGreaterThan(0);

    // Wait for process to finish
    await Bun.sleep(500);

    expect(exitCode).toBe(0);
    const output = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(output).toContain("hello from pty");
  });

  test("write sends data to the PTY", async () => {
    const pty = createPtyManager();
    const chunks: Uint8Array[] = [];
    let _exitCode = -1;

    // Use cat which echoes stdin
    pty.spawn({
      command: ["cat"],
      cwd: tmpdir(),
      onData: (data) => chunks.push(data),
      onExit: (code) => {
        _exitCode = code;
      },
    });

    await Bun.sleep(100);
    pty.write("test input\n");
    await Bun.sleep(200);

    const output = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(output).toContain("test input");

    pty.kill();
    await Bun.sleep(100);
  });

  test("kill terminates the process", async () => {
    const pty = createPtyManager();
    let exited = false;

    pty.spawn({
      command: ["sleep", "60"],
      cwd: tmpdir(),
      onData: () => {},
      onExit: () => {
        exited = true;
      },
    });

    await Bun.sleep(100);
    expect(pty.pid).toBeGreaterThan(0);

    pty.kill();
    await Bun.sleep(200);
    expect(exited).toBe(true);
  });
});

// These tests run on all platforms
describe("PtyManager (cross-platform)", () => {
  test("write does nothing when no process spawned", () => {
    const pty = createPtyManager();
    // Should not throw
    pty.write("test");
    pty.resize(80, 24);
    pty.kill();
    expect(pty.pid).toBeUndefined();
  });

  test("createPtyManager returns correct implementation", () => {
    const pty = createPtyManager();
    expect(pty).toBeDefined();
    expect(pty.pid).toBeUndefined();
  });
});
