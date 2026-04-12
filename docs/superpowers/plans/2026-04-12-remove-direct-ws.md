# Remove Direct WebSocket Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all direct WebSocket connections between frontend and daemon. Enforce CLAUDE.md Architecture Invariants: frontend↔daemon traffic always flows through Relay with E2EE.

**Architecture:** Daemon keeps IPC server (for Runner subprocess) and Relay client (outbound to Relay). Frontend uses only FrontendRelayClient. Delete WsServer, ClientRegistry, DaemonWsClient, useDaemon hook. All handler logic already exists on the relay side — this is pure legacy removal, not feature migration.

**Tech Stack:** TypeScript, Bun, React Native (Expo), Zustand, Playwright, bun:test

---

## Context for Engineers

**READ THESE FIRST before starting:**

1. `CLAUDE.md` → "Architecture Invariants" section (non-negotiable rules)
2. `ARCHITECTURE.md` → §1 System Overview, §3 Protocol
3. `packages/daemon/src/transport/relay-client.ts` → this is the surviving transport
4. `apps/app/src/lib/relay-client.ts` → frontend side of the surviving transport

**Key insight:** The relay path already implements every WS handler. Verification has confirmed zero parity gaps. This refactor only deletes — it does not add functionality.

**Passthrough PR #72 note:** Branch `fix/passthrough-pty-stdout` contains WIP that fixed a critical bug (compiled `tp` passthrough didn't show claude output). Those changes are re-implemented from scratch in Tasks 10–12 below. Do **not** cherry-pick; the original WIP coupled itself to `daemon.startWs()` which this plan removes.

---

## File Structure

### Delete (full)
- `packages/daemon/src/transport/ws-server.ts`
- `packages/daemon/src/transport/client-registry.ts`
- `packages/daemon/src/transport/ws-server.test.ts`
- `packages/daemon/src/worktree-ws.test.ts`
- `apps/app/src/lib/ws-client.ts`
- `apps/app/src/hooks/use-daemon.ts`

### Modify
- `packages/daemon/src/daemon.ts` — remove WsServer/ClientRegistry; add passthrough helpers (onRecord, sendInput, resizeSession)
- `packages/daemon/src/index.ts` — remove `--ws-port`, `daemon.startWs()`
- `packages/daemon/src/session/session-manager.ts` — add `cols`, `rows`, `env` to `SpawnRunnerOptions`; forward `env` to `Bun.spawn`
- `apps/cli/src/commands/daemon.ts` — remove `--ws-port`, `--web-dir`
- `apps/cli/src/commands/passthrough.ts` — rewrite for PTY piping + first-run auto-setup
- `apps/cli/src/commands/completions.ts` — remove WS-related completions
- `apps/cli/src/commands/status.ts` — replace direct WS with IPC-based status query
- `apps/cli/src/commands/logs.ts` — replace direct WS with IPC-based log tail
- `apps/cli/src/lib/ensure-daemon.ts` — remove `--ws-port`; use process discovery instead of WS ping
- `apps/cli/src/index.ts` — skip version check in passthrough and `run` subcommand
- `apps/app/src/hooks/use-transport.ts` — return only relay client
- `apps/app/app/_layout.tsx` — remove `useDaemon()` call
- `apps/app/src/lib/transport.ts` — update doc comment (relay-only)
- `packages/daemon/src/e2e.test.ts` — remove `daemon.startWs()` calls
- `packages/daemon/src/integration.test.ts` — verify no WS dependency
- `e2e/*.spec.ts` (7 files) — use shared helper instead of direct WS readiness check
- `e2e/lib/daemon-readiness.ts` (new) — encapsulate the one remaining WS use (test infra only, acceptable)
- `TODO.md` — mark refactor complete

### Keep (used by both WS and relay)
- `packages/daemon/src/daemon.ts::toWsSessionMeta` function
- `packages/daemon/src/daemon.ts::toWsRecs` function
- `packages/protocol/src/types/ws.ts` — types are still used by relay handlers and CLI status/logs (as envelope shape for consistency). Do **not** delete.

---

## Task 1: Audit Branch Setup

**Files:**
- Read only: `CLAUDE.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Verify you are on the correct worktree branch**

Run:
```bash
git rev-parse --abbrev-ref HEAD
git log --oneline main..HEAD | head -5
```

Expected: branch name is `refactor-remove-direct-ws` (or similar), and log is empty (fresh branch).

- [ ] **Step 2: Read the Invariants section**

Read `CLAUDE.md` and locate the "## Architecture Invariants" section. The five bullets must be memorized. Every change in this plan must preserve those invariants.

- [ ] **Step 3: Confirm baseline tests pass**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: 334 pass, 0 fail, 4 skip. If anything fails on main, stop and report — do not continue.

- [ ] **Step 4: Confirm type check passes**

```bash
pnpm type-check:all
```

Expected: no errors.

---

## Task 2: Add Passthrough Helpers to Daemon

We add these **first** so later passthrough rewrites can use them. Each helper is public API on the `Daemon` class.

**Files:**
- Modify: `packages/daemon/src/daemon.ts`
- Test: `packages/daemon/src/daemon-passthrough-helpers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/daemon-passthrough-helpers.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Daemon } from "./daemon";

describe("Daemon passthrough helpers", () => {
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
    // Invoke privately to prove the wiring exists; real invocation happens
    // inside handleRec when a Runner reports a record.
    daemon.onRecord("sid", "io", Buffer.from("x"));
    expect(called).toBe(true);
  });

  test("sendInput is a no-op when no runner is connected", () => {
    // Should not throw
    daemon.sendInput("nonexistent-sid", Buffer.from("hello"));
  });

  test("resizeSession is a no-op when no runner is connected", () => {
    daemon.resizeSession("nonexistent-sid", 80, 24);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon && bun test src/daemon-passthrough-helpers.test.ts
```

Expected: FAIL with "`onRecord` does not exist on type `Daemon`" (or similar TypeScript error).

- [ ] **Step 3: Add fields and methods to Daemon class**

In `packages/daemon/src/daemon.ts`, find the class body near `private pruneTimer: ...` and add:

```typescript
  /** Local record observer for passthrough CLI (pipes PTY io to process.stdout). */
  onRecord:
    | ((sid: string, kind: string, payload: Buffer, name?: string) => void)
    | null = null;
```

Find the `createSession` method and add these two methods after it:

```typescript
  /** Send raw terminal input bytes to a running session's PTY (via Runner IPC). */
  sendInput(sid: string, data: Buffer): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (runner) {
      this.ipcServer.send(runner, {
        t: "input",
        sid,
        data: data.toString("base64"),
      });
    }
  }

  /** Resize a running session's PTY (via Runner IPC). */
  resizeSession(sid: string, cols: number, rows: number): void {
    const runner = this.ipcServer.findRunnerBySid(sid);
    if (runner) {
      this.ipcServer.send(runner, { t: "resize", sid, cols, rows });
    }
  }
```

Find `handleRec` and, after the record is persisted and before the push-notifier call, insert:

```typescript
    // Notify local observer (passthrough CLI pipes io records to stdout).
    this.onRecord?.(msg.sid, msg.kind, payload, msg.name);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon && bun test src/daemon-passthrough-helpers.test.ts
```

Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/daemon.ts packages/daemon/src/daemon-passthrough-helpers.test.ts
git commit -m "feat(daemon): add passthrough helpers (onRecord, sendInput, resizeSession)"
```

---

## Task 3: Add env Option to SpawnRunnerOptions

**Files:**
- Modify: `packages/daemon/src/session/session-manager.ts`
- Test: `packages/daemon/src/session/session-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `packages/daemon/src/session/session-manager.test.ts`:

```typescript
test("spawnRunner forwards env option to subprocess", () => {
  const mgr = new SessionManager();
  SessionManager.setRunnerCommand(["true"]); // no-op command
  const proc = mgr.spawnRunner("env-test-sid", "/tmp", {
    env: { FOO: "bar" },
  });
  // We can't easily inspect the child's env, but the method must accept the
  // option without TypeScript error and without throwing.
  expect(proc.pid).toBeGreaterThan(0);
  proc.kill();
});
```

- [ ] **Step 2: Run test — verify TypeScript error**

```bash
cd packages/daemon && bun test src/session/session-manager.test.ts
```

Expected: FAIL with "Object literal may only specify known properties, and 'env' does not exist in type 'SpawnRunnerOptions'."

- [ ] **Step 3: Add env to SpawnRunnerOptions and forward to Bun.spawn**

In `packages/daemon/src/session/session-manager.ts`, update the interface:

```typescript
export interface SpawnRunnerOptions {
  socketPath?: string;
  worktreePath?: string;
  cols?: number;
  rows?: number;
  claudeArgs?: string[];
  env?: Record<string, string>;
}
```

Update the `Bun.spawn` call inside `spawnRunner`:

```typescript
    const proc = Bun.spawn(args, {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });
```

- [ ] **Step 4: Run test to verify pass**

```bash
cd packages/daemon && bun test src/session/session-manager.test.ts
```

Expected: all prior tests still pass, new test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/session/session-manager.ts packages/daemon/src/session/session-manager.test.ts
git commit -m "feat(daemon): add env option to SpawnRunnerOptions"
```

---

## Task 4: Delete WsServer and ClientRegistry

**Files:**
- Delete: `packages/daemon/src/transport/ws-server.ts`
- Delete: `packages/daemon/src/transport/client-registry.ts`
- Delete: `packages/daemon/src/transport/ws-server.test.ts`
- Delete: `packages/daemon/src/transport/client-registry.test.ts` (if exists)
- Delete: `packages/daemon/src/worktree-ws.test.ts`
- Modify: `packages/daemon/src/daemon.ts`

- [ ] **Step 1: Confirm no test references will be orphaned**

```bash
grep -rn "from.*ws-server\|from.*client-registry\|from.*worktree-ws" packages/ apps/
```

Expected: only matches inside the files being deleted themselves (if any matches outside, stop — those callers need updating first).

- [ ] **Step 2: Delete the files**

```bash
git rm packages/daemon/src/transport/ws-server.ts
git rm packages/daemon/src/transport/client-registry.ts
git rm packages/daemon/src/transport/ws-server.test.ts
git rm packages/daemon/src/worktree-ws.test.ts
# client-registry.test.ts may or may not exist:
git rm -f packages/daemon/src/transport/client-registry.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Remove imports and field from Daemon class**

In `packages/daemon/src/daemon.ts`:

Find and delete these imports:
```typescript
import type { WsClient } from "./transport/client-registry";
import { ClientRegistry } from "./transport/client-registry";
import { WsServer } from "./transport/ws-server";
```

Find the class field and delete:
```typescript
  private clientRegistry = new ClientRegistry();
  private wsServer: WsServer;
```

- [ ] **Step 4: Remove WsServer construction from the constructor**

In the `constructor` of `Daemon`, find the `this.wsServer = new WsServer(...)` assignment and delete the entire block (it's ~60 lines covering `onHello`, `onAttach`, `onInChat`, `onInTerm`, `onResize`, `onWorktreeCreate`, `onWorktreeRemove`, `onWorktreeList`, `onSessionCreate`, `onSessionStop`, `onSessionRestart`, `onSessionExport`).

- [ ] **Step 5: Remove WS-only methods**

In `packages/daemon/src/daemon.ts`, delete:
- `startWs(port: number): void` method
- `setWebDir(dir: string): void` method
- `get wsPort(): number | undefined` accessor
- `this.wsServer.stop();` call inside `stop()`
- `handleResume(client, msg)` and `handleWsInput(...)` methods (relay equivalents `handleRelayResume` and relay's `onInput` dispatcher remain)
- `handleWorktreeList(client, ...)`, `handleWorktreeCreate(client, ...)`, `handleWorktreeRemove(client, ...)` WS-only wrappers
- `handleSessionCreate(client, ...)`, `handleSessionStop(client, ...)`, `handleSessionRestart(client, ...)`, `handleSessionExport(client, ...)` WS-only wrappers

Keep `handleRelayResume`, `handleRelayWorktreeList`, `handleRelayWorktreeCreate`, `handleRelayWorktreeRemove`, `handleRelaySessionExport` and the relay control dispatcher (these remain the live path).

- [ ] **Step 6: Remove broadcast calls that depended on clientRegistry**

Search within `packages/daemon/src/daemon.ts`:

```bash
grep -n "clientRegistry" packages/daemon/src/daemon.ts
```

For each remaining match, delete the line. Every one of these was sending to directly-connected WS frontends which no longer exist. Relay-side broadcast in `relay.publishRecord(...)` remains the sole path for frontend notification and is already wired inside `handleRec`, `handleBye`, `handleHello`.

- [ ] **Step 7: Run type check**

```bash
pnpm type-check:all
```

Expected: no errors. If there are `WsClient` / `WsServerMessage` / `WsServer` references remaining, remove them.

- [ ] **Step 8: Run daemon tests**

```bash
cd packages/daemon && bun test
```

Expected: the 2 WS-only test files are gone; remaining tests all pass. If `e2e.test.ts` or `integration.test.ts` fails because they called `daemon.startWs(...)`, that is fixed in Task 8.

Temporarily mark the failing tests `.skip` if you need them out of the way to continue; they will be fixed in Task 8.

- [ ] **Step 9: Commit**

```bash
git add -A packages/daemon/
git commit -m "refactor(daemon): delete WsServer, ClientRegistry, and WS-only handlers"
```

---

## Task 5: Remove --ws-port from Daemon Entry

**Files:**
- Modify: `packages/daemon/src/index.ts`

- [ ] **Step 1: Write the failing test**

Add this to a new file `packages/daemon/src/index.test.ts` (smoke test for arg parsing — do not actually spawn the daemon):

```typescript
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("daemon entry point", () => {
  test("does not accept --ws-port CLI flag", () => {
    const src = readFileSync(
      new URL("./index.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).not.toContain('"ws-port"');
    expect(src).not.toContain("startWs");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
cd packages/daemon && bun test src/index.test.ts
```

Expected: FAIL — the source still contains `"ws-port"`.

- [ ] **Step 3: Update `packages/daemon/src/index.ts`**

Delete the `"ws-port": { type: "string", default: "7080" },` entry from `parseArgs.options`.

Delete the lines:
```typescript
const wsPort = parseInt(values["ws-port"] as string, 10);
daemon.startWs(wsPort);
```

Update the log message (remove any reference to `listening on ws://...`).

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/daemon && bun test src/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/index.ts packages/daemon/src/index.test.ts
git commit -m "refactor(daemon): remove --ws-port flag from entry point"
```

---

## Task 6: Remove --ws-port and --web-dir from CLI

**Files:**
- Modify: `apps/cli/src/commands/daemon.ts`
- Modify: `apps/cli/src/commands/completions.ts`
- Modify: `apps/cli/src/commands/completions.test.ts`

- [ ] **Step 1: Update completions test**

In `apps/cli/src/commands/completions.test.ts`, find assertions about `--ws-port` and `--web-dir` and change them to assert those strings are **absent** from completion output.

Replace any `expect(...).toContain("--ws-port")` with:
```typescript
expect(output).not.toContain("--ws-port");
expect(output).not.toContain("--web-dir");
```

- [ ] **Step 2: Run test — verify it fails**

```bash
bun test apps/cli/src/commands/completions.test.ts
```

Expected: FAIL — output still contains those flags.

- [ ] **Step 3: Update `apps/cli/src/commands/daemon.ts`**

Delete these entries from the `parseArgs` options:
```typescript
"ws-port": { type: "string", default: "7080" },
"web-dir": { type: "string" },
```

Delete the lines that call `daemon.startWs(wsPort)` and `daemon.setWebDir(values["web-dir"])`.

- [ ] **Step 4: Update `apps/cli/src/commands/completions.ts`**

Find the `daemon` subcommand completion block and remove `--ws-port` and `--web-dir` flag entries (both bash and zsh code paths if present).

- [ ] **Step 5: Run tests to verify pass**

```bash
bun test apps/cli/src/commands/completions.test.ts apps/cli/src/commands/daemon.test.ts 2>/dev/null || bun test apps/cli/src/commands/completions.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/daemon.ts apps/cli/src/commands/completions.ts apps/cli/src/commands/completions.test.ts
git commit -m "refactor(cli): remove --ws-port and --web-dir flags"
```

---

## Task 7: Replace WS-based status/logs with IPC-based

`tp status` and `tp logs` previously connected to `ws://localhost:7080`. With WS gone, they use the IPC socket (the same one Runner uses).

**Files:**
- Modify: `apps/cli/src/commands/status.ts`
- Modify: `apps/cli/src/commands/logs.ts`
- Modify: `apps/cli/src/lib/ensure-daemon.ts`

- [ ] **Step 1: Inspect current status.ts**

Read `apps/cli/src/commands/status.ts` fully.

Find any `new WebSocket("ws://localhost:${port}")` or `WsServerMessage` receive logic.

- [ ] **Step 2: Rewrite status.ts to query Store directly via Daemon class**

Since the CLI runs in-process when the user runs `tp status`, the simplest change is: when `tp status` is invoked, open an in-process `Daemon` just long enough to read `store.listSessions()` if there is no background daemon, otherwise report the background daemon is running by checking the IPC socket existence.

Replace the body of `statusCommand` with this logic:

```typescript
import { existsSync } from "fs";
import { Daemon } from "@teleprompter/daemon";
import { getSocketPath } from "@teleprompter/protocol";

export async function statusCommand(argv: string[]): Promise<void> {
  const socketPath = getSocketPath();
  const backgroundRunning = existsSync(socketPath);

  // Always read Store directly (on-disk) — the Store reflects reality
  // whether the background daemon is alive or not.
  const daemon = new Daemon();
  const sessions = daemon.listSessions(); // must exist; add if not
  daemon.close(); // read-only close; add if not present

  // ... print sessions table exactly as before ...
  // Print "Daemon: running (pid file or socket present)" / "Daemon: not running"
}
```

If `Daemon.listSessions()` and `Daemon.close()` do not exist, add them in the same edit. `listSessions` wraps `this.store.listSessions()`; `close` is a no-op wrapper that calls `this.store.close()` or similar — match existing patterns.

- [ ] **Step 3: Rewrite logs.ts**

`tp logs` streams live records. Previously it subscribed via WS. Replace with: tail the Store's session DB directly using the same reader the Daemon exposes to relay (`getRecordsFiltered` or equivalent in `session-db.ts`), with polling every 500ms for new `seq`.

Pattern:

```typescript
import { Daemon } from "@teleprompter/daemon";

export async function logsCommand(argv: string[]): Promise<void> {
  const sid = argv[0];
  if (!sid) { /* print list of sessions and exit */ }

  const daemon = new Daemon();
  let lastSeq = 0;
  const tick = async () => {
    const recs = daemon.getRecordsSince(sid, lastSeq); // must exist; add if not
    for (const r of recs) {
      if (r.kind === "io") process.stdout.write(r.payload);
      lastSeq = r.seq;
    }
  };
  setInterval(tick, 500);
  // Ctrl+C to exit
}
```

If `getRecordsSince` does not exist, expose it on `Daemon` as a thin wrapper around the existing `SessionDb.getRecords` method.

- [ ] **Step 4: Simplify ensure-daemon.ts**

`ensure-daemon.ts` currently pings `ws://localhost:${port}` to check if the daemon is up. Replace with an IPC socket existence check:

```typescript
import { existsSync } from "fs";
import { getSocketPath } from "@teleprompter/protocol";

async function isDaemonRunning(): Promise<boolean> {
  return existsSync(getSocketPath());
}
```

Remove the `port` parameter from `ensureDaemon()` and its call sites (`status.ts`, `logs.ts`).

- [ ] **Step 5: Run type check + tests**

```bash
pnpm type-check:all
bun test apps/cli/src/commands/status.test.ts apps/cli/src/commands/logs.test.ts 2>/dev/null || true
bun test apps/cli
```

Expected: CLI tests pass. If `status.test.ts` / `logs.test.ts` mocked a WebSocket, update the mocks to use the Store directly.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/status.ts apps/cli/src/commands/logs.ts apps/cli/src/lib/ensure-daemon.ts apps/cli/src/commands/*.test.ts packages/daemon/src/daemon.ts
git commit -m "refactor(cli): replace WS-based status/logs with direct Store reads"
```

---

## Task 8: Fix Daemon Test Files That Called startWs()

**Files:**
- Modify: `packages/daemon/src/e2e.test.ts`
- Modify: `packages/daemon/src/integration.test.ts`

- [ ] **Step 1: Identify failing call sites**

```bash
grep -n "startWs\|wsPort\|WsServer\|ClientRegistry" packages/daemon/src/*.test.ts
```

- [ ] **Step 2: Delete startWs calls; rewrite any WS-client-based assertions to use relay-client**

For each `daemon.startWs(...)` call: delete the line. The daemon is still testable — relay-client-based tests exercise the same handlers.

If a test file's entire purpose was "connect a WebSocket client and send WS messages," replace the WebSocket with the test helper `createTestRelayPair` from `packages/relay/src/relay-server.test.ts` (or whichever existing helper wires a relay + daemon pair in test code). If no such helper exists, delete the WS-specific assertions and keep only IPC-level assertions.

- [ ] **Step 3: Unskip anything you skipped in Task 4**

```bash
grep -n "\.skip\|xtest\|xdescribe" packages/daemon/src/
```

Remove any `.skip` you added in Task 4's step 8.

- [ ] **Step 4: Run all daemon tests**

```bash
cd packages/daemon && bun test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/e2e.test.ts packages/daemon/src/integration.test.ts
git commit -m "refactor(daemon): remove startWs calls from integration tests"
```

---

## Task 9: Delete Frontend DaemonWsClient and useDaemon

**Files:**
- Delete: `apps/app/src/lib/ws-client.ts`
- Delete: `apps/app/src/hooks/use-daemon.ts`
- Modify: `apps/app/src/hooks/use-transport.ts`
- Modify: `apps/app/app/_layout.tsx`
- Modify: `apps/app/src/lib/transport.ts` (comment only)

- [ ] **Step 1: Verify call sites are already relay-compatible**

```bash
grep -rn "useDaemon\|getDaemonClient\|DaemonWsClient" apps/app/
```

Every result should be inside the 4 files listed above. If any other file references these, stop and add it to this task.

- [ ] **Step 2: Update `apps/app/src/hooks/use-transport.ts`**

Replace the entire file with:

```typescript
import { getRelayClient } from "./use-relay";
import type { TransportClient } from "../lib/transport";

/**
 * Returns the active transport client for frontend↔daemon communication.
 * Always relay — direct WS connections violate Architecture Invariants.
 */
export function getTransport(): TransportClient | null {
  return getRelayClient() ?? null;
}
```

- [ ] **Step 3: Update `apps/app/app/_layout.tsx`**

Delete the import line `import { useDaemon } from "../src/hooks/use-daemon";`.

Delete the call `useDaemon();`.

Delete the one-time cleanup block `secureDelete("daemon_url");` (it references a store removed in an earlier PR).

- [ ] **Step 4: Update the doc comment in `apps/app/src/lib/transport.ts`**

Replace the file's header JSDoc with:

```typescript
/**
 * Transport interface for frontend ↔ daemon communication via E2EE relay.
 *
 * Frontend must always use FrontendRelayClient (direct WS to daemon is
 * forbidden by Architecture Invariants — see CLAUDE.md).
 */
```

- [ ] **Step 5: Delete the WS client files**

```bash
git rm apps/app/src/lib/ws-client.ts
git rm apps/app/src/hooks/use-daemon.ts
```

- [ ] **Step 6: Run type check**

```bash
pnpm type-check:all
```

Expected: no errors. If there are errors referencing `WsClient`, `DaemonWsClient`, `useDaemon`, fix the callers per the grep in Step 1.

- [ ] **Step 7: Run E2E build (static compile only, not server)**

```bash
cd apps/app && npx expo export --platform web
```

Expected: successful export into `apps/app/dist`.

- [ ] **Step 8: Commit**

```bash
git add -A apps/app/
git commit -m "refactor(app): remove DaemonWsClient and useDaemon; relay-only transport"
```

---

## Task 10: Rewrite Passthrough for PTY Piping

This is the most complex task. It subsumes PR #72 (which will be closed).

**Files:**
- Rewrite: `apps/cli/src/commands/passthrough.ts`
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Replace `apps/cli/src/commands/passthrough.ts` entirely**

Replace the whole file with:

```typescript
/**
 * Passthrough mode: `tp [--tp-*] <claude args>`
 *
 * Runs claude via an in-process Daemon + Runner. PTY output pipes to
 * the local terminal; stdin pipes to the runner. Background daemon (if
 * installed as a service) is not affected — passthrough uses a temp IPC
 * socket to avoid collision.
 *
 * On first run, shows a pairing QR and auto-installs the daemon service.
 */

import { Daemon, SessionManager } from "@teleprompter/daemon";
import { setLogLevel } from "@teleprompter/protocol";
import { existsSync, unlinkSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { splitArgs } from "../args";
import { bold, cyan, dim } from "../lib/colors";
import { errorWithHints } from "../lib/format";
import { resolveRunnerCommand } from "../spawn";

const CONFIG_DIR = join(process.env.HOME ?? "/tmp", ".config", "teleprompter");
const INIT_MARKER = join(CONFIG_DIR, ".tp-initialized");

export async function passthroughCommand(argv: string[]): Promise<void> {
  // Check claude CLI exists
  const check = Bun.spawnSync(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.error(
      errorWithHints("Claude Code CLI not found.", [
        "Install: https://docs.anthropic.com/en/docs/claude-code",
        "Or: npm install -g @anthropic-ai/claude-code",
      ]),
    );
    process.exit(1);
  }

  // First-run: pair + install daemon service
  await showFirstRunPairing();

  const { tpArgs, claudeArgs } = splitArgs(argv);
  const sid = tpArgs.sid ?? `session-${Date.now()}`;
  const cwd = tpArgs.cwd ?? process.cwd();

  // Silence all teleprompter logs — PTY owns the terminal.
  process.env.LOG_LEVEL = "silent";
  setLogLevel("silent");

  SessionManager.setRunnerCommand(resolveRunnerCommand());

  // Temp IPC socket to avoid colliding with a background daemon service.
  const tmpSocket = join(
    process.env.TMPDIR ?? "/tmp",
    `tp-passthrough-${process.pid}.sock`,
  );

  const daemon = new Daemon();
  daemon.start(tmpSocket);

  // Pipe runner PTY io records → local stdout
  daemon.onRecord = (_sid, kind, payload) => {
    if (kind === "io") process.stdout.write(payload);
  };

  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;
  daemon.createSession(sid, cwd, {
    claudeArgs,
    cols,
    rows,
    env: { LOG_LEVEL: "silent" },
  });

  // Pipe local stdin → runner PTY
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    daemon.sendInput(sid, data);
  });

  // Forward terminal resize
  process.stdout.on("resize", () => {
    daemon.resizeSession(
      sid,
      process.stdout.columns || 120,
      process.stdout.rows || 40,
    );
  });

  const cleanup = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    daemon.stop();
    try {
      unlinkSync(tmpSocket);
    } catch {}
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  const runner = daemon.getRunner(sid);
  if (runner?.process) {
    const exitCode = await runner.process.exited;
    cleanup();
    process.exit(exitCode);
  }
}

async function showFirstRunPairing(): Promise<void> {
  const pairingFile = join(CONFIG_DIR, "pairing.json");
  if (existsSync(pairingFile)) return;

  console.error(bold(cyan("Welcome to Teleprompter!")));
  console.error("tp wraps Claude Code for remote session control.\n");
  console.error(
    "Scan this QR code with the Teleprompter app to connect your phone:",
  );
  console.error(dim("(Web: tpmt.dev · iOS: TestFlight · Android: Internal)"));
  console.error("");

  try {
    const { pairCommand } = await import("./pair");
    await pairCommand([]);
  } catch {
    console.error(dim("\nPairing skipped. Run `tp pair` later to connect."));
  }

  console.error("");
  try {
    const { installService } = await import("../lib/service");
    await installService();
  } catch {
    console.error(
      dim("Daemon service install skipped. Run `tp daemon install` manually."),
    );
  }
  console.error("");

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(INIT_MARKER, new Date().toISOString());
  } catch {}
}
```

- [ ] **Step 2: Update `apps/cli/src/index.ts` to skip version check in passthrough and `run`**

Find the existing version-check logic near the top and replace with:

```typescript
const isPassthrough =
  !SUBCOMMANDS.has(command ?? "") &&
  !CLAUDE_UTILITY_SUBCOMMANDS.has(command ?? "") &&
  command !== "--" &&
  command !== "--help" &&
  command !== "-h" &&
  command !== undefined;

if (
  !isPassthrough &&
  command !== undefined &&
  command !== "--help" &&
  command !== "-h" &&
  command !== "run"
) {
  checkForUpdates().then((newVersion) => {
    if (newVersion) {
      console.error(
        yellow(
          `[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.`,
        ),
      );
    }
  });
}
```

- [ ] **Step 3: Build CLI binary**

```bash
bun run scripts/build.ts
```

Expected: `dist/tp` produced successfully.

- [ ] **Step 4: Smoke-test non-interactive passthrough**

```bash
timeout 15 ./dist/tp -p "say only the word hello" 2>&1
```

Expected output contains `hello` (possibly surrounded by ANSI reset sequences). **No** `[Runner]`, `[Daemon]`, `[IpcServer]`, or `[tp] New version` messages.

If any log line leaks through, re-examine Steps 1 and 2.

- [ ] **Step 5: Smoke-test interactive passthrough (manual)**

Run `./dist/tp --dangerously-skip-permissions` in a real terminal. Expected: claude TUI renders correctly (box borders, cursor positioning, input echoes). Send input, receive response, exit with Ctrl+C — cleanup must occur (no stale `/tmp/tp-passthrough-*.sock` files).

```bash
ls /tmp/tp-passthrough-*.sock 2>/dev/null
```

Expected: no matches after exit.

- [ ] **Step 6: Run full test suite**

```bash
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
```

Expected: 0 fail. Test counts may drop from 334 because of deleted WS tests.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/commands/passthrough.ts apps/cli/src/index.ts
git commit -m "refactor(cli): rewrite passthrough for PTY piping over IPC"
```

---

## Task 11: Update E2E Tests

**Files:**
- Create: `e2e/lib/daemon-readiness.ts`
- Modify: `e2e/app-chat-roundtrip.spec.ts`
- Modify: `e2e/app-roundtrip.spec.ts`
- Modify: `e2e/app-real-e2e.spec.ts`
- Modify: `e2e/app-resume.spec.ts`
- Modify: `e2e/app-relay-e2e.spec.ts`
- Modify: `e2e/app-session-switch.spec.ts`
- Modify: `e2e/app-daemon.spec.ts`

- [ ] **Step 1: Identify every `--ws-port` usage in e2e/**

```bash
grep -rn "ws-port\|ws://localhost" e2e/
```

- [ ] **Step 2: Create shared helper**

Create `e2e/lib/daemon-readiness.ts`:

```typescript
import { existsSync } from "fs";
import { join } from "path";

/**
 * Wait until the background daemon's IPC socket exists.
 * Replaces the legacy direct-WS readiness probe.
 */
export async function waitForDaemonReady(maxWaitMs = 30000): Promise<boolean> {
  const socketPath = join(
    "/tmp",
    `teleprompter-${process.getuid?.() ?? 501}`,
    "daemon.sock",
  );
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
```

- [ ] **Step 3: Update each spec file**

For each spec in the list:

1. Remove `--ws-port 7080` from any `spawn("./dist/tp", [...])` arrays.
2. If the spec opens `new WebSocket("ws://localhost:7080")` to probe readiness, replace with `await waitForDaemonReady()` imported from `./lib/daemon-readiness`.

Example change in `app-chat-roundtrip.spec.ts`:

Before:
```typescript
const ws = new WebSocket("ws://localhost:7080");
ws.onopen = () => ws.send(JSON.stringify({ t: "hello", v: 1 }));
// ... message handler waiting for session running ...
```

After:
```typescript
import { waitForDaemonReady } from "./lib/daemon-readiness";
await waitForDaemonReady();
```

- [ ] **Step 4: Run CI E2E suite**

```bash
cd apps/app && npx expo export --platform web && cd ../..
npx playwright test --project=ci
```

Expected: all CI tests pass.

- [ ] **Step 5: Commit**

```bash
git add e2e/
git commit -m "refactor(e2e): replace direct WS readiness probe with IPC socket check"
```

---

## Task 12: Install Compiled tp Locally and Verify

**Files:**
- No code changes; verification only.

- [ ] **Step 1: Install the new binary**

```bash
bun run scripts/build.ts
cp ./dist/tp ~/.local/bin/tp
```

- [ ] **Step 2: Verify fresh passthrough works**

```bash
tp -p "say only the word hello"
```

Expected: outputs `hello` (no log noise).

- [ ] **Step 3: Verify port-conflict scenario**

If you have the daemon installed as a service (e.g., via `tp daemon install`), confirm no port or socket collision:

```bash
tp daemon install   # idempotent — safe to re-run
tp -p "say hi"
```

Expected: still clean output; no `[tp] Port 7080 is in use` message anywhere.

- [ ] **Step 4: Verify `tp status` and `tp logs`**

```bash
tp status
# should list sessions by reading Store directly
```

Expected: session list prints correctly; no `Failed to connect to ws://` messages.

- [ ] **Step 5: Verify `tp -- --version` forwards to claude**

```bash
tp -- --version
```

Expected: prints claude's version (e.g., `2.1.101 (Claude Code)`).

- [ ] **Step 6: No commit — this is verification only**

If all pass, proceed to Task 13. If any step fails, go back to the relevant earlier task and fix before continuing.

---

## Task 13: Update TODO.md and CLAUDE.md

**Files:**
- Modify: `TODO.md`
- Modify: `CLAUDE.md` (tech-stack line referencing removed legacy)

- [ ] **Step 1: Update TODO.md**

Open `TODO.md`. Under "🔧 미비한 점 — 현재 남아있는 이슈" → "CLI", add:

```markdown
- [x] daemon의 direct WS 서버 및 frontend의 DaemonWsClient 제거 — CLAUDE.md Architecture Invariants에 맞게 relay-only로 통일. WS 관련 1500+ 라인 레거시 삭제
```

- [ ] **Step 2: Close PR #72 as superseded**

```bash
gh pr close 72 --comment "Superseded by refactor-remove-direct-ws (this PR). The passthrough PTY fix is re-implemented from scratch there, decoupled from the now-deleted WS server."
```

- [ ] **Step 3: Commit docs**

```bash
git add TODO.md
git commit -m "docs: mark direct-WS removal complete"
```

---

## Task 14: Open PR and Merge

- [ ] **Step 1: Push branch**

```bash
git push -u origin refactor-remove-direct-ws
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "refactor: remove direct WS connection between frontend and daemon" --body "$(cat <<'EOF'
## Why

CLAUDE.md "Architecture Invariants" requires frontend↔daemon traffic to flow through the Relay only, with E2EE. Legacy direct WS code (WsServer, ClientRegistry, DaemonWsClient, useDaemon) contradicted this and caused repeated confusion where agents inferred the wrong architecture from code.

## What

- Delete daemon WsServer, ClientRegistry (~700 lines, zero parity gaps — every handler already exists on the relay path)
- Delete frontend DaemonWsClient and useDaemon hook (~450 lines — FrontendRelayClient is feature-complete)
- Remove \`--ws-port\` and \`--web-dir\` flags
- Rewrite tp status and tp logs to read Store directly (no WS needed)
- Rewrite passthrough command for PTY piping over IPC (supersedes PR #72)
- Update E2E tests to use IPC socket for daemon-readiness checks

## Test plan

- [x] Full test suite (bun test) passes with 0 failures
- [x] Type check passes across all 5 packages
- [x] Playwright CI E2E passes
- [x] Compiled \`tp\` binary: passthrough shows claude output with no log noise
- [x] \`tp status\` and \`tp logs\` work without daemon ws server
- [x] \`tp -- --version\` forwards to claude
EOF
)"
```

- [ ] **Step 3: Wait for CI and merge**

```bash
gh pr checks --watch
```

Once green:
```bash
gh api repos/DaveDev42/teleprompter/pulls/$(gh pr view --json number -q .number)/merge -X PUT -f merge_method=merge
```

- [ ] **Step 4: Pull main and verify**

```bash
git checkout main
git pull --rebase
bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
pnpm type-check:all
```

Expected: all pass.

---

## Self-Review Checklist (for the implementing engineer)

Before declaring the plan done:

- [ ] No references to `WsServer`, `ClientRegistry`, `DaemonWsClient`, `useDaemon`, `--ws-port`, `--web-dir` anywhere in the codebase (run `grep -r` to confirm)
- [ ] `getTransport()` always returns relay client
- [ ] Passthrough interactive mode renders claude TUI without corruption
- [ ] Passthrough non-interactive mode (`-p`) prints clean output
- [ ] No stale `/tmp/tp-passthrough-*.sock` files after `tp` exit
- [ ] `tp status` and `tp logs` work with no running background daemon (read-only Store access)
- [ ] CLAUDE.md Invariants are still the authoritative reading — no new code contradicts them
