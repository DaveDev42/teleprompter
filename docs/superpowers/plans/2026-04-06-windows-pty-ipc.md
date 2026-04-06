# Windows PTY & IPC Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Teleprompter Runner/Daemon to work on Windows by adding platform-specific PTY (ConPTY via Node.js subprocess), IPC (Named Pipes), service management (Task Scheduler), and build targets.

**Architecture:** PTY is abstracted behind a `PtyManager` interface — `PtyBun` for macOS/Linux (existing `Bun.spawn({ terminal })`), `PtyWindows` for Windows (delegates to a Node.js subprocess running `@aspect-build/node-pty`). IPC stays on `Bun.listen`/`Bun.connect` for macOS/Linux; Windows uses `Bun.listen({ unix: named_pipe })` with `node:net` fallback. The service layer adds Windows Task Scheduler alongside existing launchd/systemd.

**Tech Stack:** TypeScript, Bun, `@aspect-build/node-pty` (Windows only), `node:net` (Windows IPC fallback), `schtasks.exe` (Windows service)

**Spec:** `docs/superpowers/specs/2026-04-06-windows-pty-ipc-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/runner/src/pty/pty-bun.ts` | macOS/Linux PTY — existing `Bun.spawn({ terminal })` code moved here |
| `packages/runner/src/pty/pty-windows.ts` | Windows PTY — manages Node.js subprocess host |
| `packages/runner/src/pty/pty-windows-host.cjs` | Node.js script that runs `@aspect-build/node-pty` ConPTY |
| `packages/runner/src/pty/pty-host-installer.ts` | Auto-installs pty-host dependencies on Windows |
| `packages/runner/src/pty/pty-windows.test.ts` | Windows PTY JSON protocol tests |
| `packages/daemon/src/ipc/server-windows.ts` | Windows IPC server (Bun named pipe + node:net fallback) |
| `packages/runner/src/ipc/client-windows.ts` | Windows IPC client (Bun named pipe + node:net fallback) |
| `apps/cli/src/lib/service-windows.ts` | Windows Task Scheduler service management |

### Modified Files

| File | Changes |
|------|---------|
| `packages/runner/src/pty/pty-manager.ts` | Convert class to interface + factory function `createPtyManager()` |
| `packages/runner/src/pty/pty-manager.test.ts` | Update imports for factory, add `createPtyManager` test |
| `packages/runner/src/runner.ts` | `new PtyManager()` → `createPtyManager()` |
| `packages/protocol/src/socket-path.ts` | Add Windows Named Pipe path |
| `packages/protocol/src/socket-path.test.ts` | Add Windows path format test |
| `packages/daemon/src/ipc/server.ts` | Extract Unix logic, delegate to `server-windows.ts` on win32 |
| `packages/runner/src/ipc/client.ts` | Extract Unix logic, delegate to `client-windows.ts` on win32 |
| `apps/cli/src/lib/service.ts` | Add win32 branch |
| `apps/cli/src/lib/service.test.ts` | Add Windows service test |
| `apps/cli/src/lib/ensure-daemon.ts` | Add win32 `isServiceInstalled` check |
| `scripts/build.ts` | Add `bun-windows-x64` target, `.exe` extension |

---

## Task 1: PTY Interface Extraction

Extract the current `PtyManager` class into an interface + `PtyBun` implementation, add a `createPtyManager()` factory. No behavior change — pure refactor.

**Files:**
- Modify: `packages/runner/src/pty/pty-manager.ts`
- Create: `packages/runner/src/pty/pty-bun.ts`
- Modify: `packages/runner/src/pty/pty-manager.test.ts`
- Modify: `packages/runner/src/runner.ts:11,35`

### Steps

- [ ] **Step 1: Create `pty-bun.ts` with existing implementation**

Move the current `PtyManager` class body into `pty-bun.ts` as `PtyBun`:

```typescript
// packages/runner/src/pty/pty-bun.ts
import type { Subprocess } from "bun";
import type { PtyManager, PtyOptions } from "./pty-manager";

export class PtyBun implements PtyManager {
  private proc: Subprocess | null = null;

  spawn(opts: PtyOptions): void {
    this.proc = Bun.spawn(opts.command, {
      cwd: opts.cwd,
      terminal: {
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 40,
        name: "xterm-256color",
        data(_term, data) {
          opts.onData(data);
        },
      },
    });

    this.proc.exited.then((code) => {
      opts.onExit(code);
    });
  }

  write(data: string | Uint8Array): void {
    if (!this.proc) return;
    (
      this.proc as unknown as {
        terminal: { write(d: string | Uint8Array): void };
      }
    ).terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.proc) return;
    (
      this.proc as unknown as {
        terminal: { resize(c: number, r: number): void };
      }
    ).terminal.resize(cols, rows);
  }

  kill(signal: number = 15): void {
    this.proc?.kill(signal);
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
}
```

- [ ] **Step 2: Convert `pty-manager.ts` to interface + factory**

Replace the class with an interface and factory:

```typescript
// packages/runner/src/pty/pty-manager.ts
export interface PtyOptions {
  command: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  onData: (data: Uint8Array) => void;
  onExit: (exitCode: number) => void;
}

export interface PtyManager {
  spawn(opts: PtyOptions): void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  readonly pid: number | undefined;
}

export function createPtyManager(): PtyManager {
  if (process.platform === "win32") {
    // Lazy import to avoid loading Windows deps on Unix
    const { PtyWindows } = require("./pty-windows") as typeof import("./pty-windows");
    return new PtyWindows();
  }
  const { PtyBun } = require("./pty-bun") as typeof import("./pty-bun");
  return new PtyBun();
}
```

- [ ] **Step 3: Update `runner.ts` to use factory**

In `packages/runner/src/runner.ts`, change:

```typescript
// Before (line 11):
import { PtyManager } from "./pty/pty-manager";
// After:
import { createPtyManager, type PtyManager } from "./pty/pty-manager";

// Before (line 35):
private pty = new PtyManager();
// After:
private pty: PtyManager = createPtyManager();
```

- [ ] **Step 4: Update test imports**

In `packages/runner/src/pty/pty-manager.test.ts`, change:

```typescript
// Before (line 2):
import { PtyManager } from "./pty-manager";
// After:
import { createPtyManager } from "./pty-manager";

// Replace all `new PtyManager()` with `createPtyManager()`:
// Lines 6, 32, 58, 79
```

Also add a factory test:

```typescript
test("createPtyManager returns PtyBun on non-windows", () => {
  const pty = createPtyManager();
  expect(pty).toBeDefined();
  expect(pty.pid).toBeUndefined(); // not spawned yet
});
```

- [ ] **Step 5: Run tests to verify no regression**

Run: `bun test packages/runner/src/pty/pty-manager.test.ts`
Expected: All 4 existing tests + 1 new test PASS

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/pty/pty-manager.ts packages/runner/src/pty/pty-bun.ts packages/runner/src/pty/pty-manager.test.ts packages/runner/src/runner.ts
git commit -m "refactor: extract PtyManager interface and PtyBun implementation

Move Bun.spawn({ terminal }) PTY code into PtyBun class.
PtyManager is now an interface with createPtyManager() factory
that selects implementation by platform."
```

---

## Task 2: Windows PTY Host Script

Create the Node.js host script that runs `@aspect-build/node-pty` and communicates via JSON lines over stdio.

**Files:**
- Create: `packages/runner/src/pty/pty-windows-host.cjs`

### Steps

- [ ] **Step 1: Create the host script**

```javascript
// packages/runner/src/pty/pty-windows-host.cjs
"use strict";

const pty = require("@aspect-build/node-pty");
const readline = require("readline");

let ptyProcess = null;

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: "error", message: "invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "spawn": {
      if (ptyProcess) {
        send({ type: "error", message: "already spawned" });
        return;
      }
      try {
        const cmd = msg.command[0];
        const args = msg.command.slice(1);
        ptyProcess = pty.spawn(cmd, args, {
          name: "xterm-256color",
          cols: msg.cols || 120,
          rows: msg.rows || 40,
          cwd: msg.cwd,
        });

        send({ type: "pid", pid: ptyProcess.pid });

        ptyProcess.onData((data) => {
          send({ type: "data", data: Buffer.from(data).toString("base64") });
        });

        ptyProcess.onExit(({ exitCode }) => {
          send({ type: "exit", code: exitCode ?? 1 });
          ptyProcess = null;
        });
      } catch (err) {
        send({ type: "error", message: err.message });
      }
      break;
    }

    case "write": {
      if (!ptyProcess) return;
      const buf = Buffer.from(msg.data, "base64");
      ptyProcess.write(buf.toString());
      break;
    }

    case "resize": {
      if (!ptyProcess) return;
      ptyProcess.resize(msg.cols, msg.rows);
      break;
    }

    case "kill": {
      if (!ptyProcess) return;
      ptyProcess.kill(msg.signal);
      break;
    }

    default:
      send({ type: "error", message: `unknown type: ${msg.type}` });
  }
});

rl.on("close", () => {
  if (ptyProcess) {
    ptyProcess.kill();
  }
  process.exit(0);
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/runner/src/pty/pty-windows-host.cjs
git commit -m "feat: add Windows PTY host script for ConPTY via @aspect-build/node-pty

Node.js CJS script that communicates with the Bun Runner via
JSON lines over stdio. Handles spawn/write/resize/kill commands."
```

---

## Task 3: PTY Host Auto-Installer

Create the module that auto-installs `@aspect-build/node-pty` on Windows at first PTY spawn.

**Files:**
- Create: `packages/runner/src/pty/pty-host-installer.ts`

### Steps

- [ ] **Step 1: Write the failing test**

Create `packages/runner/src/pty/pty-host-installer.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the helper functions, not the actual npm install
describe("pty-host-installer", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-pty-host-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("getPtyHostDir returns LOCALAPPDATA-based path on win32", async () => {
    const { getPtyHostDir } = await import("./pty-host-installer");
    const dir = getPtyHostDir();
    // On non-windows, falls back to $HOME/.local/share/teleprompter/pty-host
    expect(dir).toContain("teleprompter");
    expect(dir).toContain("pty-host");
  });

  test("needsInstall returns true when dir missing", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const missingDir = join(testDir, "nonexistent");
    expect(needsInstall(missingDir, "0.0.1")).toBe(true);
  });

  test("needsInstall returns true when version mismatch", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".version"), "0.0.1");
    expect(needsInstall(dir, "0.0.2")).toBe(true);
  });

  test("needsInstall returns false when version matches", async () => {
    const { needsInstall } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".version"), "0.0.5");
    expect(needsInstall(dir, "0.0.5")).toBe(false);
  });

  test("writeHostFiles creates package.json and host script", async () => {
    const { writeHostFiles } = await import("./pty-host-installer");
    const dir = join(testDir, "pty-host");
    mkdirSync(dir, { recursive: true });
    writeHostFiles(dir, "0.0.5");

    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(existsSync(join(dir, ".version"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@aspect-build/node-pty"]).toBeDefined();

    const version = readFileSync(join(dir, ".version"), "utf-8");
    expect(version).toBe("0.0.5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/pty/pty-host-installer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/runner/src/pty/pty-host-installer.ts
import { execSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { createLogger } from "@teleprompter/protocol";

const log = createLogger("PtyHostInstaller");

export function getPtyHostDir(): string {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA ??
      join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
    return join(localAppData, "teleprompter", "pty-host");
  }
  // Fallback for non-Windows (used in tests)
  const dataDir =
    process.env.XDG_DATA_HOME ??
    join(process.env.HOME ?? "/tmp", ".local", "share");
  return join(dataDir, "teleprompter", "pty-host");
}

export function needsInstall(dir: string, currentVersion: string): boolean {
  if (!existsSync(dir)) return true;
  const versionFile = join(dir, ".version");
  if (!existsSync(versionFile)) return true;
  const installed = readFileSync(versionFile, "utf-8").trim();
  return installed !== currentVersion;
}

export function writeHostFiles(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });

  const pkg = {
    name: "teleprompter-pty-host",
    private: true,
    dependencies: {
      "@aspect-build/node-pty": "*",
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, ".version"), version);
}

export function getHostScriptPath(): string {
  // In compiled binary, __dirname points to the binary's location
  // The host script is co-located in the source
  return join(__dirname, "pty-windows-host.cjs");
}

export function ensurePtyHost(currentVersion: string): string {
  const dir = getPtyHostDir();

  if (!needsInstall(dir, currentVersion)) {
    log.info("pty-host up to date");
    return dir;
  }

  log.info("installing pty-host dependencies...");

  writeHostFiles(dir, currentVersion);

  // Copy host script
  const srcScript = getHostScriptPath();
  const destScript = join(dir, "pty-windows-host.cjs");
  if (existsSync(srcScript)) {
    copyFileSync(srcScript, destScript);
  }

  // Run npm install
  try {
    execSync("npm install --production", {
      cwd: dir,
      stdio: "pipe",
      timeout: 60_000,
    });
    log.info("pty-host installed successfully");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`pty-host install failed: ${msg}`);
    throw new Error(
      `Failed to install PTY host dependencies. ` +
        `Ensure Node.js is installed and in PATH. ` +
        `Run 'tp doctor' for diagnostics.`,
    );
  }

  return dir;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/pty/pty-host-installer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/pty/pty-host-installer.ts packages/runner/src/pty/pty-host-installer.test.ts
git commit -m "feat: add PTY host auto-installer for Windows

Automatically installs @aspect-build/node-pty on first PTY spawn.
Checks version file to re-install on tp upgrade."
```

---

## Task 4: PtyWindows Implementation

Create the `PtyWindows` class that delegates PTY operations to the Node.js host subprocess.

**Files:**
- Create: `packages/runner/src/pty/pty-windows.ts`
- Create: `packages/runner/src/pty/pty-windows.test.ts`

### Steps

- [ ] **Step 1: Write the failing test**

The test mocks the host subprocess to verify the JSON protocol without needing Windows or node-pty. Create `packages/runner/src/pty/pty-windows.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * These tests verify the PtyWindows JSON line protocol by using
 * a mock host script (echo-host.cjs) that echoes commands back.
 * Runs on all platforms — does not require Windows or node-pty.
 */
describe("PtyWindows", () => {
  let testDir: string;
  let mockHostPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-pty-win-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Create a mock host that echoes spawn → pid, write → data, and exits on kill
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
      // Simulate some output after spawn
      send({ type: "data", data: Buffer.from("hello from pty").toString("base64") });
      break;
    case "write":
      // Echo back whatever was written
      send({ type: "data", data: msg.data });
      break;
    case "resize":
      // No response needed
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
      onExit: (code) => {
        exitCode = code;
      },
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

    // Should not throw
    pty.resize(100, 50);

    pty.kill();
    await Bun.sleep(100);
  });

  test("write/resize/kill do nothing before spawn", () => {
    const { PtyWindows } = await import("./pty-windows");
    const pty = new PtyWindows(mockHostPath);

    // Should not throw
    pty.write("test");
    pty.resize(80, 24);
    pty.kill();
    expect(pty.pid).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runner/src/pty/pty-windows.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/runner/src/pty/pty-windows.ts
import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { createLogger } from "@teleprompter/protocol";
import type { PtyManager, PtyOptions } from "./pty-manager";

const log = createLogger("PtyWindows");

export class PtyWindows implements PtyManager {
  private child: ChildProcess | null = null;
  private _pid: number | undefined;
  private hostScriptPath: string;

  constructor(hostScriptPath?: string) {
    this.hostScriptPath =
      hostScriptPath ?? require.resolve("./pty-windows-host.cjs");
  }

  spawn(opts: PtyOptions): void {
    this.child = spawn("node", [this.hostScriptPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = createInterface({ input: this.child.stdout! });

    rl.on("line", (line) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        log.error("invalid JSON from host:", line);
        return;
      }

      switch (msg.type) {
        case "pid":
          this._pid = msg.pid as number;
          break;
        case "data": {
          const buf = Buffer.from(msg.data as string, "base64");
          opts.onData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          break;
        }
        case "exit":
          opts.onExit((msg.code as number) ?? 1);
          break;
        case "error":
          log.error("host error:", msg.message);
          break;
      }
    });

    this.child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        log.error(`host process exited with code ${code}`);
      }
      this.child = null;
    });

    // Send spawn command
    this.send({
      type: "spawn",
      command: opts.command,
      cwd: opts.cwd,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
    });
  }

  write(data: string | Uint8Array): void {
    if (!this.child) return;
    const buf =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    this.send({ type: "write", data: buf.toString("base64") });
  }

  resize(cols: number, rows: number): void {
    if (!this.child) return;
    this.send({ type: "resize", cols, rows });
  }

  kill(signal: number = 15): void {
    if (!this.child) return;
    this.send({ type: "kill", signal });
  }

  get pid(): number | undefined {
    return this._pid;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runner/src/pty/pty-windows.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Run all PTY tests for regression**

Run: `bun test packages/runner/src/pty/`
Expected: All tests PASS (both pty-manager.test.ts and pty-windows.test.ts)

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/pty/pty-windows.ts packages/runner/src/pty/pty-windows.test.ts
git commit -m "feat: add PtyWindows implementation with Node.js subprocess host

Delegates PTY operations to a Node.js child process via JSON lines
over stdio. Uses mock host script in tests for cross-platform CI."
```

---

## Task 5: Windows Named Pipe Socket Path

Add Windows Named Pipe path to `socket-path.ts`.

**Files:**
- Modify: `packages/protocol/src/socket-path.ts`
- Modify: `packages/protocol/src/socket-path.test.ts`

### Steps

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/socket-path.test.ts`:

```typescript
describe("getSocketPath (win32 simulation)", () => {
  test("returns named pipe format when platform is win32", () => {
    // We can't change process.platform, so test the helper directly
    const { getWindowsSocketPath } = require("./socket-path");
    const path = getWindowsSocketPath("TestUser");
    expect(path).toBe("\\\\.\\pipe\\teleprompter-TestUser-daemon");
  });

  test("windows path does not contain forward slashes", () => {
    const { getWindowsSocketPath } = require("./socket-path");
    const path = getWindowsSocketPath("Dave");
    expect(path).not.toContain("/");
    expect(path).toMatch(/^\\\\\.\\pipe\\/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/socket-path.test.ts`
Expected: FAIL — `getWindowsSocketPath` not found

- [ ] **Step 3: Implement the changes**

Update `packages/protocol/src/socket-path.ts`:

```typescript
import { mkdirSync } from "fs";
import { join } from "path";

export function getWindowsSocketPath(
  username?: string,
): string {
  const user = username ?? process.env.USERNAME ?? "default";
  return `\\\\.\\pipe\\teleprompter-${user}-daemon`;
}

export function getSocketPath(): string {
  if (process.platform === "win32") {
    return getWindowsSocketPath();
  }
  const runtimeDir =
    process.env.XDG_RUNTIME_DIR ??
    join("/tmp", `teleprompter-${process.getuid?.()}`);
  mkdirSync(runtimeDir, { recursive: true });
  return join(runtimeDir, "daemon.sock");
}
```

Also update `packages/protocol/src/index.ts` to export `getWindowsSocketPath`:

Find the existing export line:
```typescript
export { getSocketPath } from "./socket-path";
```
Replace with:
```typescript
export { getSocketPath, getWindowsSocketPath } from "./socket-path";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/src/socket-path.test.ts`
Expected: All tests PASS (existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/socket-path.ts packages/protocol/src/socket-path.test.ts packages/protocol/src/index.ts
git commit -m "feat: add Windows Named Pipe path to socket-path

getWindowsSocketPath() returns \\.\pipe\teleprompter-{user}-daemon.
getSocketPath() now returns named pipe path on win32."
```

---

## Task 6: Windows IPC Server

Add Windows Named Pipe support to `IpcServer` with Bun native pipe attempt + `node:net` fallback.

**Files:**
- Create: `packages/daemon/src/ipc/server-windows.ts`
- Modify: `packages/daemon/src/ipc/server.ts`

### Steps

- [ ] **Step 1: Create `server-windows.ts`**

```typescript
// packages/daemon/src/ipc/server-windows.ts
import { createServer, type Server, type Socket } from "node:net";
import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  type IpcHello,
  type IpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";
import type { ConnectedRunner, IpcServerEvents } from "./server";

const log = createLogger("IpcServer:Windows");

/**
 * Adapter that wraps a node:net Socket to match QueuedWriter's
 * Writable interface (write returns number of bytes written).
 */
class NetSocketAdapter {
  constructor(private socket: Socket) {}

  write(data: Uint8Array): number {
    const canWriteMore = this.socket.write(Buffer.from(data));
    // node:net buffers the entire chunk — return full length
    // If backpressure, return 0 so QueuedWriter queues subsequent writes
    return canWriteMore ? data.byteLength : 0;
  }
}

export function startWindowsServer(
  path: string,
  events: IpcServerEvents,
  runners: Set<ConnectedRunner>,
): { server: Server; transport: "bun-pipe" | "node-net" } {
  // Try Bun.listen with named pipe first
  try {
    const bunServer = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          const runner: ConnectedRunner = {
            socket,
            writer: new QueuedWriter(),
            decoder: new FrameDecoder(),
          };
          (socket as unknown as { _runner: ConnectedRunner })._runner = runner;
          runners.add(runner);
          events.onConnect(runner);
        },
        data(socket, data) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          const messages = runner.decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            if ((msg as IpcHello).t === "hello") {
              runner.sid = (msg as IpcHello).sid;
            }
            events.onMessage(
              runner,
              msg as Parameters<IpcServerEvents["onMessage"]>[1],
            );
          }
        },
        drain(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          runner.writer.drain(socket);
        },
        close(socket) {
          const runner = (socket as unknown as { _runner: ConnectedRunner })
            ._runner;
          runners.delete(runner);
          events.onDisconnect(runner);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
      },
    });

    log.info(`listening on ${path} (bun native pipe)`);
    // Wrap Bun server to match node:net Server interface for stop()
    return {
      server: { close: () => bunServer.stop() } as unknown as Server,
      transport: "bun-pipe",
    };
  } catch {
    log.info("Bun named pipe not supported, falling back to node:net");
  }

  // Fallback: node:net
  const server = createServer((socket: Socket) => {
    const adapter = new NetSocketAdapter(socket);
    const runner: ConnectedRunner = {
      socket: adapter,
      writer: new QueuedWriter(),
      decoder: new FrameDecoder(),
    };
    runners.add(runner);
    events.onConnect(runner);

    socket.on("data", (data: Buffer) => {
      const messages = runner.decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const msg of messages) {
        if ((msg as IpcHello).t === "hello") {
          runner.sid = (msg as IpcHello).sid;
        }
        events.onMessage(
          runner,
          msg as Parameters<IpcServerEvents["onMessage"]>[1],
        );
      }
    });

    socket.on("drain", () => {
      runner.writer.drain(adapter);
    });

    socket.on("close", () => {
      runners.delete(runner);
      events.onDisconnect(runner);
    });

    socket.on("error", (err) => {
      log.error("socket error:", err.message);
    });
  });

  server.listen(path);
  log.info(`listening on ${path} (node:net fallback)`);
  return { server, transport: "node-net" };
}
```

- [ ] **Step 2: Update `server.ts` to delegate on win32**

Modify `packages/daemon/src/ipc/server.ts` — add win32 branch in `start()`:

Add import at top:
```typescript
import type { Server } from "node:net";
```

Export the `ConnectedRunner` type (needed by `server-windows.ts`):
```typescript
export interface ConnectedRunner {
  socket: unknown;
  writer: QueuedWriter;
  decoder: FrameDecoder;
  sid?: string;
}
```

Update the `server` field type and `start` method:
```typescript
export class IpcServer {
  private server: ReturnType<typeof Bun.listen> | Server | null = null;
  // ... (runners, events unchanged)

  start(socketPath?: string): string {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      const { startWindowsServer } = require("./server-windows") as typeof import("./server-windows");
      const result = startWindowsServer(path, this.events, this.runners);
      this.server = result.server;
      return path;
    }

    // Existing Unix code unchanged
    if (existsSync(path)) {
      unlinkSync(path);
    }
    // ... rest of existing Bun.listen code
  }

  stop(): void {
    if (this.server && "close" in this.server) {
      (this.server as Server).close();
    } else if (this.server && "stop" in this.server) {
      (this.server as ReturnType<typeof Bun.listen>).stop();
    }
    this.server = null;
    this.runners.clear();
  }
}
```

- [ ] **Step 3: Run existing IPC server tests for regression**

Run: `bun test packages/daemon/src/ipc/server.test.ts`
Expected: All tests PASS (we're on macOS/Linux, so the Unix path runs)

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/src/ipc/server-windows.ts packages/daemon/src/ipc/server.ts
git commit -m "feat: add Windows Named Pipe IPC server

Bun native named pipe attempted first, node:net fallback if unsupported.
NetSocketAdapter bridges node:net Socket to QueuedWriter interface.
macOS/Linux path unchanged."
```

---

## Task 7: Windows IPC Client

Add Windows Named Pipe support to `IpcClient`.

**Files:**
- Create: `packages/runner/src/ipc/client-windows.ts`
- Modify: `packages/runner/src/ipc/client.ts`

### Steps

- [ ] **Step 1: Create `client-windows.ts`**

```typescript
// packages/runner/src/ipc/client-windows.ts
import { connect as netConnect, type Socket } from "node:net";
import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  type IpcMessage,
  QueuedWriter,
} from "@teleprompter/protocol";

const log = createLogger("IpcClient:Windows");

type IncomingHandler = (msg: unknown) => void;

interface WindowsIpcConnection {
  send(msg: IpcMessage): void;
  close(): void;
}

export async function connectWindows(
  path: string,
  onMessage: IncomingHandler,
): Promise<WindowsIpcConnection> {
  // Try Bun.connect first
  try {
    const writer = new QueuedWriter();
    const decoder = new FrameDecoder();

    const socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const messages = decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            onMessage(msg);
          }
        },
        drain(socket) {
          writer.drain(socket);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
        close() {
          log.info("disconnected");
        },
      },
    });

    log.info(`connected to ${path} (bun native pipe)`);
    return {
      send(msg: IpcMessage) {
        const frame = encodeFrame(msg);
        writer.write(socket, frame);
      },
      close() {
        socket.end();
      },
    };
  } catch {
    log.info("Bun named pipe connect failed, falling back to node:net");
  }

  // Fallback: node:net
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const socket: Socket = netConnect(path, () => {
      log.info(`connected to ${path} (node:net fallback)`);
      resolve({
        send(msg: IpcMessage) {
          const frame = encodeFrame(msg);
          socket.write(Buffer.from(frame));
        },
        close() {
          socket.end();
        },
      });
    });

    socket.on("data", (data: Buffer) => {
      const messages = decoder.decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
      for (const msg of messages) {
        onMessage(msg);
      }
    });

    socket.on("error", (err) => {
      log.error("socket error:", err.message);
      reject(err);
    });

    socket.on("close", () => {
      log.info("disconnected");
    });
  });
}
```

- [ ] **Step 2: Update `client.ts` to delegate on win32**

Modify `packages/runner/src/ipc/client.ts`:

```typescript
import {
  createLogger,
  encodeFrame,
  FrameDecoder,
  getSocketPath,
  type IpcAck,
  type IpcInput,
  type IpcMessage,
  type IpcResize,
  QueuedWriter,
} from "@teleprompter/protocol";

const log = createLogger("IpcClient");

type IncomingMessage = IpcAck | IpcInput | IpcResize;
type MessageHandler = (msg: IncomingMessage) => void;

export class IpcClient {
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer S>
    ? S
    : never = null as never;
  private writer = new QueuedWriter();
  private decoder = new FrameDecoder();
  private onMessage: MessageHandler;
  // Windows connection (when using fallback)
  private winConn: { send(msg: IpcMessage): void; close(): void } | null = null;

  constructor(onMessage: MessageHandler) {
    this.onMessage = onMessage;
  }

  async connect(socketPath?: string): Promise<void> {
    const path = socketPath ?? getSocketPath();

    if (process.platform === "win32") {
      const { connectWindows } = require("./client-windows") as typeof import("./client-windows");
      this.winConn = await connectWindows(path, (msg) => {
        this.onMessage(msg as IncomingMessage);
      });
      return;
    }

    // Existing Unix code unchanged
    const self = this;
    this.socket = await Bun.connect({
      unix: path,
      socket: {
        data(_socket, data) {
          const messages = self.decoder.decode(new Uint8Array(data));
          for (const msg of messages) {
            self.onMessage(msg as IncomingMessage);
          }
        },
        drain(socket) {
          self.writer.drain(socket);
        },
        error(_socket, err) {
          log.error("socket error:", err.message);
        },
        close() {
          log.info("disconnected");
        },
      },
    });
  }

  send(msg: IpcMessage): void {
    if (this.winConn) {
      this.winConn.send(msg);
      return;
    }
    const frame = encodeFrame(msg);
    this.writer.write(this.socket, frame);
  }

  close(): void {
    if (this.winConn) {
      this.winConn.close();
      this.winConn = null;
      return;
    }
    this.socket.end();
  }
}
```

- [ ] **Step 3: Run existing IPC client tests for regression**

Run: `bun test packages/runner/src/ipc/client.test.ts`
Expected: All tests PASS (Unix path unchanged)

- [ ] **Step 4: Run integration tests**

Run: `bun test packages/daemon/src/integration.test.ts packages/daemon/src/e2e.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/ipc/client-windows.ts packages/runner/src/ipc/client.ts
git commit -m "feat: add Windows Named Pipe IPC client

Bun native pipe attempted first, node:net fallback if unsupported.
macOS/Linux path unchanged."
```

---

## Task 8: Windows Service Management

Add Task Scheduler support for `tp daemon install/uninstall` on Windows.

**Files:**
- Create: `apps/cli/src/lib/service-windows.ts`
- Modify: `apps/cli/src/lib/service.ts`
- Modify: `apps/cli/src/lib/service.test.ts`
- Modify: `apps/cli/src/lib/ensure-daemon.ts:140-147`

### Steps

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/lib/service.test.ts`:

```typescript
// Add at the end, inside the outer describe:
describe("windows", () => {
  test("generateSchtasksArgs produces correct arguments", async () => {
    const { generateSchtasksArgs } = await import("./service-windows");
    const args = generateSchtasksArgs(
      "C:\\Users\\Test\\.local\\bin\\tp.exe",
      "C:\\Users\\Test\\AppData\\Local\\teleprompter\\logs",
    );

    expect(args).toContain("/Create");
    expect(args).toContain("/TN");
    expect(args).toContain("TeleprompterDaemon");
    expect(args).toContain("/SC");
    expect(args).toContain("ONLOGON");
    expect(args).toContain("/RL");
    expect(args).toContain("LIMITED");
    expect(args).toContain("/F");

    // TR should contain the binary path and redirect to log
    const trIndex = args.indexOf("/TR");
    const trValue = args[trIndex + 1];
    expect(trValue).toContain("tp.exe");
    expect(trValue).toContain("daemon start");
    expect(trValue).toContain("daemon.log");
  });

  test("resolveTpBinary returns a string", async () => {
    const { resolveTpBinary } = await import("./service-windows");
    const binary = resolveTpBinary();
    expect(typeof binary).toBe("string");
    expect(binary.length).toBeGreaterThan(0);
  });

  test("getLogDir returns LOCALAPPDATA-based path", async () => {
    const { getLogDir } = await import("./service-windows");
    const dir = getLogDir();
    expect(dir).toContain("teleprompter");
    expect(dir).toContain("logs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/cli/src/lib/service.test.ts`
Expected: FAIL — `service-windows` module not found

- [ ] **Step 3: Implement `service-windows.ts`**

```typescript
// apps/cli/src/lib/service-windows.ts
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";

const TASK_NAME = "TeleprompterDaemon";

export function getLogDir(): string {
  const localAppData =
    process.env.LOCALAPPDATA ??
    join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Local");
  return join(localAppData, "teleprompter", "logs");
}

export function resolveTpBinary(): string {
  const candidates = [
    join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "tp",
      "tp.exe",
    ),
    join(process.env.USERPROFILE ?? "", ".local", "bin", "tp.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return process.argv[0];
}

export function isServiceInstalled(): boolean {
  const result = Bun.spawnSync([
    "schtasks",
    "/Query",
    "/TN",
    TASK_NAME,
  ]);
  return result.exitCode === 0;
}

export function getTaskName(): string {
  return TASK_NAME;
}

export function generateSchtasksArgs(
  tpBinary: string,
  logDir: string,
): string[] {
  const logFile = join(logDir, "daemon.log");
  const tr = `"${tpBinary}" daemon start > "${logFile}" 2>&1`;

  return [
    "/Create",
    "/TN",
    TASK_NAME,
    "/TR",
    tr,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
  ];
}

export async function installWindows(): Promise<void> {
  const tpBinary = resolveTpBinary();
  const logDir = getLogDir();

  await mkdir(logDir, { recursive: true });

  const args = generateSchtasksArgs(tpBinary, logDir);
  const result = Bun.spawnSync(["schtasks", ...args]);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    console.error(`[Service] schtasks create failed: ${stderr}`);
    return;
  }

  console.log(`[Service] Installed Task Scheduler task: ${TASK_NAME}`);
  console.log(`[Service] Binary: ${tpBinary}`);
  console.log(`[Service] Logs: ${join(logDir, "daemon.log")}`);
  console.log(`\nThe daemon will start automatically on login.`);
  console.log(`To check status: schtasks /Query /TN ${TASK_NAME}`);
}

export async function uninstallWindows(): Promise<void> {
  if (!isServiceInstalled()) {
    console.log(`[Service] No scheduled task found: ${TASK_NAME}`);
    return;
  }

  const result = Bun.spawnSync([
    "schtasks",
    "/Delete",
    "/TN",
    TASK_NAME,
    "/F",
  ]);

  if (result.exitCode !== 0) {
    console.error(
      `[Service] schtasks delete failed: ${result.stderr.toString()}`,
    );
    return;
  }

  console.log(`[Service] Uninstalled scheduled task: ${TASK_NAME}`);
}
```

- [ ] **Step 4: Update `service.ts` with win32 branch**

In `packages/apps/cli/src/lib/service.ts`, add win32 before the error fallthrough:

```typescript
import { platform } from "os";

export async function installService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    const { installDarwin } = await import("./service-darwin");
    return installDarwin();
  }
  if (os === "linux") {
    const { installLinux } = await import("./service-linux");
    return installLinux();
  }
  if (os === "win32") {
    const { installWindows } = await import("./service-windows");
    return installWindows();
  }
  console.error(`[Service] Unsupported platform: ${os}`);
  console.error(
    `[Service] Supported: macOS (launchd), Linux (systemd), Windows (Task Scheduler)`,
  );
  process.exit(1);
}

export async function uninstallService(): Promise<void> {
  const os = platform();
  if (os === "darwin") {
    const { uninstallDarwin } = await import("./service-darwin");
    return uninstallDarwin();
  }
  if (os === "linux") {
    const { uninstallLinux } = await import("./service-linux");
    return uninstallLinux();
  }
  if (os === "win32") {
    const { uninstallWindows } = await import("./service-windows");
    return uninstallWindows();
  }
  console.error(`[Service] Unsupported platform: ${os}`);
  process.exit(1);
}
```

- [ ] **Step 5: Update `ensure-daemon.ts` with win32 check**

In `apps/cli/src/lib/ensure-daemon.ts`, around line 140-147, add the win32 check:

```typescript
const os = platform();
if (os === "darwin") {
  const { isServiceInstalled } = await import("./service-darwin");
  if (isServiceInstalled()) return;
} else if (os === "linux") {
  const { isServiceInstalled } = await import("./service-linux");
  if (isServiceInstalled()) return;
} else if (os === "win32") {
  const { isServiceInstalled } = await import("./service-windows");
  if (isServiceInstalled()) return;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test apps/cli/src/lib/service.test.ts`
Expected: All tests PASS (existing + 3 new Windows tests)

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/lib/service-windows.ts apps/cli/src/lib/service.ts apps/cli/src/lib/service.test.ts apps/cli/src/lib/ensure-daemon.ts
git commit -m "feat: add Windows Task Scheduler service management

tp daemon install/uninstall now supports Windows via schtasks.exe.
Runs as limited user, starts on logon, logs to %LOCALAPPDATA%."
```

---

## Task 9: Build Target Addition

Add `bun-windows-x64` to the build script with `.exe` extension handling.

**Files:**
- Modify: `scripts/build.ts`

### Steps

- [ ] **Step 1: Update TARGETS and outFile**

In `scripts/build.ts`:

Update the TARGETS array (line 20-25):
```typescript
const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;
```

Update the `outFile` function (line 29-31):
```typescript
function outFile(name: string, target: Target): string {
  const suffix = target.replace("bun-", "").replace("-", "_");
  const ext = target.includes("windows") ? ".exe" : "";
  return `${OUT_DIR}/${name}-${suffix}${ext}`;
}
```

- [ ] **Step 2: Verify build script parses correctly**

Run: `bun run scripts/build.ts --target bun-windows-x64`
Expected: Builds successfully (cross-compilation), produces `dist/tp-windows_x64.exe`

- [ ] **Step 3: Commit**

```bash
git add scripts/build.ts
git commit -m "feat: add bun-windows-x64 build target

Cross-compiles tp for Windows x64 with .exe extension."
```

---

## Task 10: Full Test Suite & Type Check

Run the complete test suite and type check to verify no regressions.

**Files:** None (verification only)

### Steps

- [ ] **Step 1: Run full test suite**

Run: `bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `pnpm type-check:all`
Expected: No errors

- [ ] **Step 3: Fix any failures**

If any tests fail or type errors arise, fix them before proceeding.

---

## Task 11: Documentation Updates

Update project docs to reflect Windows support.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `TODO.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRD.md`

### Steps

- [ ] **Step 1: Update TODO.md**

Check the two Windows items in the Future section:

```markdown
- [x] Windows PTY 지원 — `@aspect-build/node-pty` via Node.js subprocess (ConPTY)
- [x] Windows IPC — Named Pipes (`Bun.listen` native pipe + `node:net` fallback)
```

- [ ] **Step 2: Update CLAUDE.md**

In the Tech Stack section, add Windows note:
```markdown
- **Windows PTY**: Node.js subprocess + `@aspect-build/node-pty` (ConPTY). Auto-installed at `%LOCALAPPDATA%\teleprompter\pty-host\`
- **Windows IPC**: Named Pipes via `Bun.listen({ unix })` with `node:net` fallback
- **Windows Service**: Task Scheduler (`schtasks.exe`)
```

In the CLI Commands section, update the supported platforms error message reference.

In the Testing Strategy, add notes about platform-guarded Windows tests.

In the build targets doc comment in `scripts/build.ts`, mention `bun-windows-x64`.

- [ ] **Step 3: Update ARCHITECTURE.md**

In the IPC section:
```markdown
Windows: Named Pipe `\\.\pipe\teleprompter-{username}-daemon` (Bun native pipe attempt, node:net fallback)
```

In the PTY/Runner section:
```markdown
Windows: Node.js subprocess + @aspect-build/node-pty (ConPTY). JSON lines stdio protocol.
```

- [ ] **Step 4: Update PRD.md**

Change Windows support status from "미지원" to supported:
```markdown
- Windows: `@aspect-build/node-pty` via Node.js subprocess (ConPTY). Node.js 필요.
```

And for IPC:
```markdown
- Windows: Named Pipes (`\\.\pipe\teleprompter-{username}-daemon`)
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md TODO.md ARCHITECTURE.md PRD.md
git commit -m "docs: update documentation for Windows PTY, IPC, and service support"
```

---

## Task Order & Dependencies

```
Task 1 (PTY Interface)
  └── Task 2 (PTY Host Script)
        └── Task 3 (PTY Host Installer)
              └── Task 4 (PtyWindows)

Task 5 (Socket Path) ──independent──

Task 6 (IPC Server Windows) ──depends on Task 5──
Task 7 (IPC Client Windows) ──depends on Task 5──

Task 8 (Windows Service) ──independent──

Task 9 (Build Target) ──independent──

Task 10 (Full Tests) ──depends on all above──
Task 11 (Docs) ──depends on Task 10──
```

Tasks 1-4 are sequential (PTY chain). Tasks 5, 8, 9 are independent and can run in parallel with the PTY chain. Tasks 6-7 depend on Task 5. Task 10 verifies everything. Task 11 is last.
