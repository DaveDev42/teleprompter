# Windows Test Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 23 failing Windows CI tests pass by fixing EBUSY cleanup, Unix command dependencies, and hardcoded paths.

**Architecture:** Two shared helpers solve most failures: (1) `rmWindows()` — retry-based rm for EBUSY file locking, (2) platform-aware test commands. PtyManager tests get `skipIf(win32)` since PtyBun is macOS/Linux only. Hardcoded `/tmp` paths become `tmpdir()`.

**Tech Stack:** Bun test, Node.js fs, os.tmpdir()

---

## Root Causes

| Cause | Tests Affected | Fix |
|-------|---------------|-----|
| EBUSY on `rm()` — Windows locks open files | 18 tests (daemon, full-stack, multi-frontend, hook-receiver) | Retry-based `rmRetry()` helper |
| Unix commands (`echo`, `cat`, `sleep`) | 3 tests (pty-manager) | `describe.skipIf(win32)` — PtyBun is macOS/Linux only |
| Hardcoded `/tmp` in test data | 8+ tests | Replace with `tmpdir()` |

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/protocol/src/test-utils.ts` | Shared `rmRetry()` helper for cross-platform cleanup |

### Modified Files

| File | Changes |
|------|---------|
| `packages/daemon/src/auto-cleanup.test.ts` | Replace `rm()` with `rmRetry()`, `/tmp` → `tmpdir()` |
| `packages/daemon/src/e2e.test.ts` | Replace `rmSync()` with async `rmRetry()` |
| `packages/daemon/src/integration.test.ts` | Replace `rmSync()` with async `rmRetry()`, `/tmp` → `tmpdir()` |
| `packages/daemon/src/bench.test.ts` | Replace `rm()` with `rmRetry()` |
| `apps/cli/src/full-stack.test.ts` | Replace `rm()` with `rmRetry()` |
| `apps/cli/src/multi-frontend.test.ts` | Replace `rm()` with `rmRetry()` |
| `packages/runner/src/hooks/hook-receiver.test.ts` | Replace `rm()` with `rmRetry()`, `/tmp` → `tmpdir()` |
| `packages/runner/src/pty/pty-manager.test.ts` | `describe.skipIf(win32)` for PtyBun tests, `/tmp` → `tmpdir()` |
| `.github/workflows/ci.yml` | Restore full test scope for Windows |

---

## Task 1: Create `rmRetry()` shared helper

**Files:**
- Create: `packages/protocol/src/test-utils.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/test-utils.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rmRetry } from "./test-utils";

describe("rmRetry", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-rm-retry-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("removes a directory", async () => {
    writeFileSync(join(testDir, "file.txt"), "hello");
    await rmRetry(testDir);
    expect(() => rmSync(testDir)).toThrow();
  });

  test("succeeds on non-existent directory", async () => {
    const nonExistent = join(tmpdir(), `tp-rm-retry-nonexistent-${Date.now()}`);
    await rmRetry(nonExistent); // should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/src/test-utils.test.ts`
Expected: FAIL — module `./test-utils` not found

- [ ] **Step 3: Write the implementation**

Create `packages/protocol/src/test-utils.ts`:

```typescript
import { rm } from "fs/promises";

/**
 * rm with retry for Windows EBUSY errors.
 * On Windows, files locked by open handles (sockets, SQLite) can't be
 * deleted immediately. This retries with exponential backoff.
 */
export async function rmRetry(
  path: string,
  opts?: { maxRetries?: number; baseDelayMs?: number },
): Promise<void> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseDelay = opts?.baseDelayMs ?? 100;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw err;
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
    }
  }
}
```

Export from `packages/protocol/src/index.ts` — add:
```typescript
export { rmRetry } from "./test-utils";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/protocol/src/test-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/test-utils.ts packages/protocol/src/test-utils.test.ts packages/protocol/src/index.ts
git commit -m "feat: add rmRetry() helper for Windows EBUSY cleanup in tests

Retries rm with exponential backoff when files are locked by open
handles (sockets, SQLite). Common on Windows where file deletion
fails while handles are still open."
```

---

## Task 2: Fix daemon auto-cleanup tests

**Files:**
- Modify: `packages/daemon/src/auto-cleanup.test.ts`

- [ ] **Step 1: Replace `rm()` with `rmRetry()` and `/tmp` with `tmpdir()`**

```typescript
// Line 1-4: Add import
import { rmRetry } from "@teleprompter/protocol";

// Line 24: Replace rm() in afterEach
// Before:
await rm(storeDir, { recursive: true, force: true });
// After:
await rmRetry(storeDir);

// Lines 30, 34, 46, 58, 108: Replace hardcoded /tmp
// Before:
store.createSession("old-session", "/tmp");
// After:
store.createSession("old-session", tmpdir());
```

Apply to ALL occurrences of `/tmp` in this file (lines 30, 34, 46, 58, 108).

- [ ] **Step 2: Run test**

Run: `bun test packages/daemon/src/auto-cleanup.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/auto-cleanup.test.ts
git commit -m "fix: use rmRetry and tmpdir in auto-cleanup tests for Windows"
```

---

## Task 3: Fix daemon e2e tests

**Files:**
- Modify: `packages/daemon/src/e2e.test.ts`

- [ ] **Step 1: Replace `rmSync()` with `rmRetry()` in afterEach**

```typescript
// Add import at top:
import { rmRetry } from "@teleprompter/protocol";

// In afterEach (around line 91-95), replace:
// Before:
rmSync(tmpDir, { recursive: true, force: true });
// After:
await rmRetry(tmpDir);
```

Note: The afterEach may need to become `async` if it isn't already.

Also replace any hardcoded `/tmp` paths with `tmpdir()` — check all occurrences of `"/tmp"` in the file.

- [ ] **Step 2: Run test**

Run: `bun test packages/daemon/src/e2e.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/e2e.test.ts
git commit -m "fix: use rmRetry in e2e tests for Windows EBUSY"
```

---

## Task 4: Fix daemon integration tests

**Files:**
- Modify: `packages/daemon/src/integration.test.ts`

- [ ] **Step 1: Replace `rmSync()` with `rmRetry()` and `/tmp` with `tmpdir()`**

```typescript
// Add import:
import { rmRetry } from "@teleprompter/protocol";

// In afterEach, replace:
// Before:
rmSync(tmpDir, { recursive: true, force: true });
// After:
await rmRetry(tmpDir);

// Line 63: Replace hardcoded /tmp
// Before:
cwd: "/tmp/project"
// After:
cwd: join(tmpdir(), "project")
```

- [ ] **Step 2: Run test**

Run: `bun test packages/daemon/src/integration.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/integration.test.ts
git commit -m "fix: use rmRetry and tmpdir in integration tests for Windows"
```

---

## Task 5: Fix daemon bench test

**Files:**
- Modify: `packages/daemon/src/bench.test.ts`

- [ ] **Step 1: Replace `rm()` with `rmRetry()` and `/tmp` with `tmpdir()`**

```typescript
// Add import:
import { rmRetry } from "@teleprompter/protocol";

// Replace rm() in cleanup with rmRetry()
// Replace any "/tmp" with tmpdir()
```

- [ ] **Step 2: Run test**

Run: `bun test packages/daemon/src/bench.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/src/bench.test.ts
git commit -m "fix: use rmRetry in bench test for Windows"
```

---

## Task 6: Fix full-stack and multi-frontend tests

**Files:**
- Modify: `apps/cli/src/full-stack.test.ts`
- Modify: `apps/cli/src/multi-frontend.test.ts`

- [ ] **Step 1: Replace `rm()` with `rmRetry()` in both files**

For both files:
```typescript
// Add import:
import { rmRetry } from "@teleprompter/protocol";

// In afterEach, replace:
// Before:
await rm(tmpDir, { recursive: true, force: true });
// After:
await rmRetry(tmpDir);
```

Also replace any `/tmp` paths with `tmpdir()`.

- [ ] **Step 2: Run tests**

Run: `bun test apps/cli/src/full-stack.test.ts apps/cli/src/multi-frontend.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/full-stack.test.ts apps/cli/src/multi-frontend.test.ts
git commit -m "fix: use rmRetry in full-stack and multi-frontend tests for Windows"
```

---

## Task 7: Fix hook-receiver test

**Files:**
- Modify: `packages/runner/src/hooks/hook-receiver.test.ts`

- [ ] **Step 1: Replace `rm()` with `rmRetry()` and `/tmp` with `tmpdir()`**

```typescript
// Add import:
import { rmRetry } from "@teleprompter/protocol";

// In afterEach, replace:
// Before:
await rm(tmpDir, { recursive: true, force: true });
// After:
await rmRetry(tmpDir);

// Lines 33, 62: Replace hardcoded /tmp in event cwd
// Before:
cwd: "/tmp",
// After:
cwd: tmpdir(),
```

Note: `tmpdir` is already imported in this file.

- [ ] **Step 2: Run test**

Run: `bun test packages/runner/src/hooks/hook-receiver.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/hooks/hook-receiver.test.ts
git commit -m "fix: use rmRetry and tmpdir in hook-receiver test for Windows"
```

---

## Task 8: Skip PtyBun tests on Windows

**Files:**
- Modify: `packages/runner/src/pty/pty-manager.test.ts`

- [ ] **Step 1: Add platform guard and fix paths**

PtyBun uses `Bun.spawn({ terminal })` which is macOS/Linux only. The Unix commands (`echo`, `cat`, `sleep`) don't exist on Windows. The factory test and no-op test should still run everywhere.

```typescript
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
    await Bun.sleep(500);
    expect(exitCode).toBe(0);
    const output = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(output).toContain("hello from pty");
  });

  test("write sends data to the PTY", async () => {
    const pty = createPtyManager();
    const chunks: Uint8Array[] = [];
    let _exitCode = -1;

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
```

- [ ] **Step 2: Run test**

Run: `bun test packages/runner/src/pty/pty-manager.test.ts`
Expected: All 5 tests PASS (3 PtyBun + 2 cross-platform on macOS/Linux)

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/pty/pty-manager.test.ts
git commit -m "fix: skip PtyBun tests on Windows, fix hardcoded /tmp paths

PtyBun uses Bun.spawn({ terminal }) which is macOS/Linux only.
Unix commands (echo, cat, sleep) don't exist on Windows.
Cross-platform factory tests still run everywhere."
```

---

## Task 9: Restore full Windows CI test scope

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update test-windows job to run all packages**

Replace the selective test step with the full suite:

```yaml
      - name: Test
        run: bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay
        shell: bash
```

Remove the comment about excluded packages.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: restore full test scope for Windows CI job

All EBUSY cleanup issues fixed with rmRetry(), Unix command tests
skipped on Windows with describe.skipIf(win32)."
```

---

## Task 10: Run full test suite and verify

- [ ] **Step 1: Run full local tests**

Run: `bun test packages/protocol packages/daemon packages/runner apps/cli packages/relay`
Expected: All tests PASS on macOS/Linux (no regressions)

- [ ] **Step 2: Push and verify Windows CI**

Push to remote and verify all CI checks pass including test-windows.

---

## Task Order & Dependencies

```
Task 1 (rmRetry helper) ── all other tasks depend on this
  ├── Task 2 (auto-cleanup)
  ├── Task 3 (e2e)
  ├── Task 4 (integration)
  ├── Task 5 (bench)
  ├── Task 6 (full-stack + multi-frontend)
  ├── Task 7 (hook-receiver)
  └── Task 8 (pty-manager skipIf) ── independent, no rmRetry needed
Task 9 (CI scope) ── depends on all above
Task 10 (verify) ── depends on Task 9
```

Tasks 2-8 are independent of each other and can be parallelized after Task 1.
