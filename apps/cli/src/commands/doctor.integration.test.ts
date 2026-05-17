/**
 * Integration tests for doctorCommand.
 *
 * macOS sandbox note: when bun:test runs inside apps/cli, subprocess stdout
 * pipes are blocked (shell scripts execute but their stdout is swallowed).
 * Therefore we cannot rely on fake PATH binaries writing to stdout via
 * Bun.spawnSync. Instead we mock Bun.spawnSync / Bun.spawn directly so the
 * fake version strings arrive through the mock return value — no pipes needed.
 *
 * XDG_RUNTIME_DIR and XDG_DATA_HOME are mutated in beforeEach/afterEach to
 * point to temp dirs so:
 *   - doctorCommand sees "Daemon socket: not running" (no socket file in tmp)
 *   - Store opens an empty sqlite in tmp — no pairings → relay and E2EE
 *     blocks are skipped entirely (no network, no IPC).
 * console.log is captured via spyOn (in-process, unaffected by sandbox).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { doctorCommand } from "./doctor";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type SpawnSyncResult = ReturnType<typeof Bun.spawnSync>;

/**
 * Build a fake SpawnSyncResult that looks like a successful version probe.
 * stdout is a Uint8Array because doctor.ts calls `new TextDecoder().decode(r.stdout)`.
 */
function fakeSpawnOk(output: string): SpawnSyncResult {
  return {
    exitCode: 0,
    stdout: new TextEncoder().encode(`${output}\n`),
    stderr: new TextEncoder().encode(""),
    success: true,
  } as unknown as SpawnSyncResult;
}

function fakeSpawnFail(): SpawnSyncResult {
  return {
    exitCode: 1,
    stdout: new TextEncoder().encode(""),
    stderr: new TextEncoder().encode(""),
    success: false,
  } as unknown as SpawnSyncResult;
}

type SpawnResult = ReturnType<typeof Bun.spawn>;

/** Fake Bun.spawn result whose exited Promise resolves immediately. */
function fakeProcess(): SpawnResult {
  return {
    exited: Promise.resolve(0),
    exitCode: 0,
    pid: 0,
  } as unknown as SpawnResult;
}

// --------------------------------------------------------------------------
// Setup / teardown
// --------------------------------------------------------------------------

let tmpRuntimeDir: string;
let tmpDataDir: string;
let origRuntime: string | undefined;
let origDataHome: string | undefined;
let logLines: string[];
let consoleSpy: ReturnType<typeof spyOn<typeof console, "log">>;
let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;
let spawnSpy: ReturnType<typeof spyOn<typeof Bun, "spawn">>;

beforeEach(() => {
  tmpRuntimeDir = mkdtempSync(join(tmpdir(), "tp-doctor-runtime-"));
  tmpDataDir = mkdtempSync(join(tmpdir(), "tp-doctor-data-"));

  origRuntime = process.env.XDG_RUNTIME_DIR;
  origDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_RUNTIME_DIR = tmpRuntimeDir;
  process.env.XDG_DATA_HOME = tmpDataDir;

  logLines = [];
  consoleSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    },
  );
});

afterEach(() => {
  consoleSpy.mockRestore();
  spawnSyncSpy?.mockRestore();
  spawnSpy?.mockRestore();

  if (origRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = origRuntime;

  if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = origDataHome;

  rmSync(tmpRuntimeDir, { recursive: true, force: true });
  rmSync(tmpDataDir, { recursive: true, force: true });
});

/**
 * Install happy-path mocks: all four tool probes return version strings and
 * exit 0; claude doctor spawn resolves immediately.
 */
function setupHappyMocks(): void {
  spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(((
    cmd: string[],
    _opts?: unknown,
  ) => {
    const name = cmd[0];
    if (name === "node") return fakeSpawnOk("v20.0.0");
    if (name === "pnpm") return fakeSpawnOk("9.0.0");
    if (name === "claude") return fakeSpawnOk("1.0.0");
    if (name === "git") return fakeSpawnOk("git version 2.40.0");
    return fakeSpawnFail();
  }) as typeof Bun.spawnSync);
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    _cmd: unknown,
    _opts?: unknown,
  ) => fakeProcess()) as typeof Bun.spawn);
}

// --------------------------------------------------------------------------
// 1. Happy path — all tools present
// --------------------------------------------------------------------------

describe("doctorCommand happy path", () => {
  test("prints header and version strings for all tools", async () => {
    setupHappyMocks();
    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Teleprompter Doctor");
    expect(output).toContain("Bun");
    expect(output).toContain("Node.js");
    expect(output).toContain("v20.0.0");
    expect(output).toContain("pnpm");
    expect(output).toContain("9.0.0");
    expect(output).toContain("Claude CLI");
    expect(output).toContain("1.0.0");
  });

  test("invokes claude doctor section when claude is on PATH", async () => {
    setupHappyMocks();
    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Claude Code Doctor");
    // Bun.spawn called with claude doctor
    expect(spawnSpy).toHaveBeenCalled();
  });

  test("reports daemon socket not running (no socket in tmp runtime dir)", async () => {
    setupHappyMocks();
    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Daemon socket");
    expect(output).toContain("not running");
  });

  test("reports no pairings from empty temp store", async () => {
    setupHappyMocks();
    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Pairing data");
    expect(output).toContain("no pairings");
  });

  test("emits a summary line", async () => {
    setupHappyMocks();
    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toMatch(/issue|All checks passed/i);
  });
});

// --------------------------------------------------------------------------
// 2. Node missing
// --------------------------------------------------------------------------

describe("doctorCommand with node missing", () => {
  test("reports node not found and counts as an issue", async () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(((
      cmd: string[],
      _opts?: unknown,
    ) => {
      if (cmd[0] === "node") return fakeSpawnFail();
      if (cmd[0] === "pnpm") return fakeSpawnOk("9.0.0");
      if (cmd[0] === "claude") return fakeSpawnOk("1.0.0");
      if (cmd[0] === "git") return fakeSpawnOk("git version 2.40.0");
      return fakeSpawnFail();
    }) as typeof Bun.spawnSync);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((_cmd: unknown) =>
      fakeProcess()) as typeof Bun.spawn);

    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Node.js");
    expect(output).toContain("not found");
    expect(output).toMatch(/issue/i);
  });
});

// --------------------------------------------------------------------------
// 3. pnpm missing
// --------------------------------------------------------------------------

describe("doctorCommand with pnpm missing", () => {
  test("reports pnpm not found and counts as an issue", async () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(((
      cmd: string[],
      _opts?: unknown,
    ) => {
      if (cmd[0] === "node") return fakeSpawnOk("v20.0.0");
      if (cmd[0] === "pnpm") return fakeSpawnFail();
      if (cmd[0] === "claude") return fakeSpawnOk("1.0.0");
      if (cmd[0] === "git") return fakeSpawnOk("git version 2.40.0");
      return fakeSpawnFail();
    }) as typeof Bun.spawnSync);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((_cmd: unknown) =>
      fakeProcess()) as typeof Bun.spawn);

    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("pnpm");
    expect(output).toContain("not found");
    expect(output).toMatch(/issue/i);
  });
});

// --------------------------------------------------------------------------
// 4. claude missing
// --------------------------------------------------------------------------

describe("doctorCommand with claude missing", () => {
  test("reports Claude CLI not found and skips claude doctor", async () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockImplementation(((
      cmd: string[],
      _opts?: unknown,
    ) => {
      if (cmd[0] === "node") return fakeSpawnOk("v20.0.0");
      if (cmd[0] === "pnpm") return fakeSpawnOk("9.0.0");
      if (cmd[0] === "claude") return fakeSpawnFail(); // all claude calls fail
      if (cmd[0] === "git") return fakeSpawnOk("git version 2.40.0");
      return fakeSpawnFail();
    }) as typeof Bun.spawnSync);
    // No Bun.spawn mock needed — claude is absent so the spawn never fires.

    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Claude CLI");
    expect(output).toContain("not found");
    // When claude --version fails, the skip message is printed instead of
    // spawning claude doctor.
    expect(output).toContain("claude not found on PATH");
    expect(output).toMatch(/issue/i);
  });
});

// --------------------------------------------------------------------------
// 5. Daemon not running
// --------------------------------------------------------------------------

describe("doctorCommand with daemon not running", () => {
  test("reports daemon socket not running when no socket file exists", async () => {
    setupHappyMocks();
    // tmpRuntimeDir has no daemon.sock — daemon is down.

    await doctorCommand([]);

    const output = logLines.join("\n");
    expect(output).toContain("Daemon socket");
    expect(output).toContain("not running");
  });

  test("does not throw when daemon IPC is unreachable", async () => {
    setupHappyMocks();
    // No pairings in the empty store → relay block skipped → IPC probe never
    // attempted even if daemon socket were present.
    await expect(doctorCommand([])).resolves.toBeUndefined();
  });
});
