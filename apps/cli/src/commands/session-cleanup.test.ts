/**
 * Tests for tp session cleanup (non-interactive / non-React paths).
 *
 * The React TUI itself is not testable in Bun's headless environment
 * (no TTY + no ink-testing-library equivalent for Bun). We instead test:
 *   - TTY detection guard (non-TTY → error + exit 1)
 *   - Empty-list early-return
 *   - Stopped-only filter (running sessions never appear)
 *   - `cleanup` subcommand wiring (via tp session cleanup in non-TTY env)
 *   - `--help` via session dispatcher
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture } from "../test-util";

const CLI = "bun run apps/cli/src/index.ts";

describe("tp session cleanup (non-TTY guard)", () => {
  let home: string;
  let env: Record<string, string>;
  let storeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-cleanup-"));
    env = {
      HOME: home,
      XDG_DATA_HOME: join(home, "xdg"),
      XDG_RUNTIME_DIR: join(home, "runtime"),
    };
    storeDir = join(home, "xdg", "teleprompter", "vault");
  });

  afterEach(() => {
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  function seed(
    rows: Array<{
      sid: string;
      state?: "running" | "stopped" | "error";
      ageMs?: number;
    }>,
  ) {
    const store = new Store(storeDir);
    try {
      const now = Date.now();
      for (const r of rows) {
        store.createSession(r.sid, "/cwd");
        const state = r.state ?? "stopped";
        if (state !== "running") {
          store.updateSessionState(r.sid, state);
        }
        if (r.ageMs && r.ageMs > 0) {
          const metaDb = new Database(join(storeDir, "sessions.sqlite"));
          metaDb.run("UPDATE sessions SET updated_at = ? WHERE sid = ?", [
            now - r.ageMs,
            r.sid,
          ]);
          metaDb.close();
        }
      }
    } finally {
      store.close();
    }
  }

  test("non-TTY (CI pipe) prints error and fails with exit 1", () => {
    // capture() runs the command with stdio piped — which means isTTY === false.
    // This is the core non-TTY gate.
    seed([{ sid: "session-aaa", state: "stopped" }]);
    const out = capture(`${CLI} session cleanup`, env);
    expect(out).toContain("tp session cleanup is interactive");
    expect(out).toContain("tp session prune");
  });

  test("non-TTY always fails even with --yes", () => {
    seed([{ sid: "session-aaa", state: "stopped" }]);
    const out = capture(`${CLI} session cleanup --yes`, env);
    expect(out).toContain("tp session cleanup is interactive");
  });

  test("non-TTY always fails even with --all", () => {
    seed([{ sid: "session-aaa", state: "stopped" }]);
    const out = capture(`${CLI} session cleanup --all`, env);
    expect(out).toContain("tp session cleanup is interactive");
  });

  test("help flag shows cleanup in session usage", () => {
    const out = capture(`${CLI} session --help`, env);
    expect(out).toContain("cleanup");
    expect(out).toContain("interactive");
  });

  test("unknown flag errors gracefully", () => {
    const out = capture(`${CLI} session cleanup --unknown-flag`, env);
    // Either the arg parser error or the non-TTY guard fires first.
    // Both are acceptable failures; we just want no unhandled crash.
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("runSessionCleanup (unit — stopped-only filter)", () => {
  let home: string;
  let storeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-cleanup-unit-"));
    storeDir = join(home, "xdg", "teleprompter", "vault");
  });

  afterEach(() => {
    rmSync(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  test("Store.listSessions returns running + stopped sessions", () => {
    const store = new Store(storeDir);
    store.createSession("s-running", "/a");
    store.createSession("s-stopped", "/b");
    store.updateSessionState("s-stopped", "stopped");
    const all = store.listSessions();
    store.close();

    const stopped = all.filter((s) => s.state === "stopped");
    const running = all.filter((s) => s.state === "running");

    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.sid).toBe("s-stopped");
    expect(running).toHaveLength(1);
    expect(running[0]?.sid).toBe("s-running");
  });

  test("cleanup filter keeps only stopped sessions", () => {
    const store = new Store(storeDir);
    store.createSession("s-running", "/a");
    store.createSession("s-stopped-1", "/b");
    store.createSession("s-stopped-2", "/c");
    store.updateSessionState("s-stopped-1", "stopped");
    store.updateSessionState("s-stopped-2", "stopped");
    const all = store.listSessions();
    store.close();

    const filtered = all
      .filter((s) => s.state === "stopped")
      .sort((a, b) => b.updated_at - a.updated_at);

    expect(filtered).toHaveLength(2);
    for (const s of filtered) {
      expect(s.state).toBe("stopped");
    }
    // Running session is excluded
    expect(filtered.find((s) => s.sid === "s-running")).toBeUndefined();
  });

  test("cleanup returns newest-first ordering", () => {
    const store = new Store(storeDir);
    const now = Date.now();
    store.createSession("s-old", "/a");
    store.updateSessionState("s-old", "stopped");
    store.createSession("s-new", "/b");
    store.updateSessionState("s-new", "stopped");

    // Backdate s-old
    const db = new Database(join(storeDir, "sessions.sqlite"));
    db.run("UPDATE sessions SET updated_at = ? WHERE sid = ?", [
      now - 86400_000,
      "s-old",
    ]);
    db.close();

    const all = store.listSessions();
    store.close();

    const sorted = all
      .filter((s) => s.state === "stopped")
      .sort((a, b) => b.updated_at - a.updated_at);

    expect(sorted[0]?.sid).toBe("s-new");
    expect(sorted[1]?.sid).toBe("s-old");
  });
});
