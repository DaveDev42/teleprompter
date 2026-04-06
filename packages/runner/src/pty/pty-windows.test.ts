import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("PtyWindows", () => {
  let testDir: string;
  let mockHostPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-pty-win-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    mockHostPath = join(testDir, "mock-host.cjs");
    writeFileSync(
      mockHostPath,
      `
"use strict";
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  const msg = JSON.parse(line);
  switch (msg.type) {
    case "spawn":
      send({ type: "pid", pid: 99999 });
      send({ type: "data", data: Buffer.from("hello from pty").toString("base64") });
      break;
    case "write":
      send({ type: "data", data: msg.data });
      break;
    case "resize":
      break;
    case "kill":
      send({ type: "exit", code: 0 });
      break;
  }
});
`,
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("spawns host process and receives pid + data", async () => {
    const { PtyWindows } = await import("./pty-windows");
    const pty = new PtyWindows(mockHostPath);
    const chunks: Uint8Array[] = [];
    let exitCode = -1;

    pty.spawn({
      command: ["echo", "test"],
      cwd: testDir,
      cols: 80,
      rows: 24,
      onData: (data) => chunks.push(data),
      onExit: (code) => { exitCode = code; },
    });

    await Bun.sleep(300);
    expect(pty.pid).toBe(99999);
    const output = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(output).toContain("hello from pty");

    pty.kill();
    await Bun.sleep(200);
    expect(exitCode).toBe(0);
  });

  test("write sends data to host", async () => {
    const { PtyWindows } = await import("./pty-windows");
    const pty = new PtyWindows(mockHostPath);
    const chunks: Uint8Array[] = [];

    pty.spawn({
      command: ["cat"],
      cwd: testDir,
      onData: (data) => chunks.push(data),
      onExit: () => {},
    });

    await Bun.sleep(200);
    pty.write("test input");
    await Bun.sleep(200);

    const output = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(output).toContain("test input");
    pty.kill();
    await Bun.sleep(100);
  });

  test("resize sends resize command", async () => {
    const { PtyWindows } = await import("./pty-windows");
    const pty = new PtyWindows(mockHostPath);

    pty.spawn({
      command: ["cat"],
      cwd: testDir,
      onData: () => {},
      onExit: () => {},
    });

    await Bun.sleep(200);
    pty.resize(100, 50); // Should not throw
    pty.kill();
    await Bun.sleep(100);
  });

  test("write/resize/kill do nothing before spawn", async () => {
    const { PtyWindows } = await import("./pty-windows");
    const pty = new PtyWindows(mockHostPath);

    pty.write("test");
    pty.resize(80, 24);
    pty.kill();
    expect(pty.pid).toBeUndefined();
  });
});
