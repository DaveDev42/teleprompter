import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "@teleprompter/daemon";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture } from "../test-util";
import { matchSessions, parseDuration } from "./session";

const CLI = "bun run apps/cli/src/index.ts";

describe("parseDuration", () => {
  test("parses Nd as days", () => {
    expect(parseDuration("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses Nh as hours", () => {
    expect(parseDuration("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseDuration("2h")).toBe(2 * 60 * 60 * 1000);
  });

  test("parses Nm as minutes", () => {
    expect(parseDuration("30m")).toBe(30 * 60 * 1000);
  });

  test("parses Ns as seconds", () => {
    expect(parseDuration("45s")).toBe(45 * 1000);
  });

  test("rejects unknown suffix", () => {
    expect(() => parseDuration("7w")).toThrow();
  });

  test("rejects missing suffix", () => {
    expect(() => parseDuration("42")).toThrow();
  });

  test("rejects empty", () => {
    expect(() => parseDuration("")).toThrow();
  });

  test("rejects negative", () => {
    expect(() => parseDuration("-5d")).toThrow();
  });

  test("rejects zero", () => {
    expect(() => parseDuration("0h")).toThrow();
  });
});

describe("matchSessions", () => {
  const sessions = [
    { sid: "session-mncx9824" },
    { sid: "session-aaaa1111" },
    { sid: "session-aaaa2222" },
  ];

  test("matches by exact sid", () => {
    const out = matchSessions(sessions, "session-aaaa1111");
    expect(out).toHaveLength(1);
    expect(out[0]?.sid).toBe("session-aaaa1111");
  });

  test("matches by prefix", () => {
    const out = matchSessions(sessions, "session-mncx");
    expect(out).toHaveLength(1);
    expect(out[0]?.sid).toBe("session-mncx9824");
  });

  test("returns multiple on ambiguous prefix", () => {
    const out = matchSessions(sessions, "session-aaaa");
    expect(out).toHaveLength(2);
  });

  test("returns empty on no match", () => {
    const out = matchSessions(sessions, "nope");
    expect(out).toHaveLength(0);
  });

  test("rejects middle-of-string substring match", () => {
    // 'ncx9' occurs mid-sid in 'session-mncx9824' but is neither prefix
    // nor exact — the contract is that substring matches never hit.
    const out = matchSessions(sessions, "ncx9");
    expect(out).toHaveLength(0);
  });

  test("exact match wins over ambiguous prefix", () => {
    // The sessions table has `sid TEXT PRIMARY KEY`, so at runtime the
    // Store can never hand us two rows where one's sid equals the search
    // and another's starts with it. This test pins the pure-function
    // behavior of `matchSessions` under a hypothetical so a future refactor
    // (e.g. searching a different collection) can't silently regress it.
    const cands = [{ sid: "abc" }, { sid: "abcdef" }];
    const out = matchSessions(cands, "abc");
    expect(out).toHaveLength(1);
    expect(out[0]?.sid).toBe("abc");
  });
});

describe("tp session", () => {
  test("--help prints usage", () => {
    const home = mkdtempSync(join(tmpdir(), "tp-session-help-"));
    try {
      const out = capture(`${CLI} session --help`, { HOME: home });
      expect(out).toContain("tp session");
      expect(out).toContain("list");
      expect(out).toContain("delete");
      expect(out).toContain("prune");
    } finally {
      rmSync(home, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
});

describe("tp session list/delete/prune (daemon-less fallback)", () => {
  let home: string;
  let env: Record<string, string>;
  let storeDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tp-session-"));
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
        // Backdate via direct SQL — Store exposes no `updated_at` setter.
        // Only `updated_at` matters here: the dispatcher's prune filter
        // reads `updated_at` (not `created_at`), so leaving `created_at`
        // at `now` is fine. If a future change switches to `created_at`,
        // backdate both columns here to keep this helper honest.
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

  test("list shows empty state", () => {
    const out = capture(`${CLI} session list`, env);
    expect(out).toContain("No sessions");
  });

  test("list shows seeded sessions", () => {
    seed([
      { sid: "session-aaaa", state: "stopped" },
      { sid: "session-bbbb", state: "stopped" },
    ]);
    const out = capture(`${CLI} session list`, env);
    expect(out).toContain("session-aaaa");
    expect(out).toContain("session-bbbb");
    expect(out).toContain("stopped");
  });

  test("delete by exact sid removes one session", () => {
    seed([
      { sid: "session-aaaa", state: "stopped" },
      { sid: "session-bbbb", state: "stopped" },
    ]);
    const out = capture(`${CLI} session delete session-aaaa --yes`, env);
    expect(out).toContain("Deleted session session-aaaa");
    const store = new Store(storeDir);
    const remaining = store.listSessions().map((s) => s.sid);
    store.close();
    expect(remaining).toEqual(["session-bbbb"]);
  });

  test("delete by prefix match", () => {
    seed([{ sid: "session-mncx9824", state: "stopped" }]);
    const out = capture(`${CLI} session delete session-mncx --yes`, env);
    expect(out).toContain("Deleted session session-mncx9824");
  });

  test("delete errors on no match", () => {
    seed([{ sid: "session-aaaa", state: "stopped" }]);
    const out = capture(`${CLI} session delete nope --yes`, env);
    expect(out).toContain("No session matches");
  });

  test("delete errors on ambiguous prefix", () => {
    seed([
      { sid: "session-aaaa1", state: "stopped" },
      { sid: "session-aaaa2", state: "stopped" },
    ]);
    const out = capture(`${CLI} session delete session-aaaa --yes`, env);
    expect(out).toContain("ambiguous");
    expect(out).toContain("session-aaaa1");
    expect(out).toContain("session-aaaa2");
  });

  test("delete without --yes on non-TTY refuses", () => {
    seed([{ sid: "session-aaaa", state: "stopped" }]);
    const out = capture(`${CLI} session delete session-aaaa`, env);
    expect(out).toContain("Refusing to delete");
    const store = new Store(storeDir);
    expect(store.listSessions()).toHaveLength(1);
    store.close();
  });

  test("prune --dry-run lists candidates without deleting", () => {
    seed([
      { sid: "old-session", state: "stopped", ageMs: 8 * 24 * 60 * 60_000 },
      { sid: "new-session", state: "stopped", ageMs: 60_000 },
    ]);
    const out = capture(`${CLI} session prune --older-than 7d --dry-run`, env);
    expect(out).toContain("old-session");
    expect(out).not.toContain("new-session");
    expect(out.toLowerCase()).toContain("dry");

    const store = new Store(storeDir);
    const remaining = store
      .listSessions()
      .map((s) => s.sid)
      .sort();
    store.close();
    expect(remaining).toEqual(["new-session", "old-session"]);
  });

  test("prune --older-than 7d --yes deletes old stopped sessions", () => {
    seed([
      { sid: "old-session", state: "stopped", ageMs: 8 * 24 * 60 * 60_000 },
      { sid: "new-session", state: "stopped", ageMs: 60_000 },
      { sid: "running-old", state: "running", ageMs: 8 * 24 * 60 * 60_000 },
    ]);
    const out = capture(`${CLI} session prune --older-than 7d --yes`, env);
    expect(out).toContain("old-session");

    const store = new Store(storeDir);
    const remaining = store
      .listSessions()
      .map((s) => s.sid)
      .sort();
    store.close();
    expect(remaining).toEqual(["new-session", "running-old"]);
  });

  test("prune --all --yes deletes every stopped session", () => {
    seed([
      { sid: "s-1", state: "stopped" },
      { sid: "s-2", state: "stopped" },
      { sid: "s-running", state: "running" },
    ]);
    const out = capture(`${CLI} session prune --all --yes`, env);
    expect(out).toContain("s-1");
    expect(out).toContain("s-2");

    const store = new Store(storeDir);
    const remaining = store.listSessions().map((s) => s.sid);
    store.close();
    expect(remaining).toEqual(["s-running"]);
  });

  test("prune --all --running --yes sweeps stale running rows", () => {
    // Simulates a crashed daemon leaving a "running" row behind. With no
    // live daemon attached, --running + --yes must sweep it.
    seed([
      { sid: "stale-running", state: "running" },
      { sid: "stopped-normal", state: "stopped" },
    ]);
    const out = capture(`${CLI} session prune --all --running --yes`, env);
    expect(out).toContain("stale-running");
    expect(out).toContain("stopped-normal");

    const store = new Store(storeDir);
    const remaining = store.listSessions();
    store.close();
    expect(remaining).toEqual([]);
  });

  test("prune with no match reports 0 selected", () => {
    seed([{ sid: "new-session", state: "stopped", ageMs: 60_000 }]);
    const out = capture(`${CLI} session prune --older-than 7d --yes`, env);
    // Tight match: the literal "No sessions selected (0 matched)." line
    // from the CLI. A loose `/0|no session/` would also match "10 sessions"
    // if a future refactor accidentally changed the output shape.
    expect(out).toMatch(/No sessions selected \(0 matched\)\./);
  });

  test("prune rejects invalid duration", () => {
    const out = capture(`${CLI} session prune --older-than 7w --yes`, env);
    expect(out.toLowerCase()).toContain("invalid");
  });

  test("prune --running without --yes twice refuses on non-TTY", () => {
    seed([{ sid: "running-old", state: "running" }]);
    const out = capture(`${CLI} session prune --all --running`, env);
    // Requires two confirmations — non-TTY should refuse without --yes.
    expect(out).toContain("Refusing");
    const store = new Store(storeDir);
    expect(store.listSessions()).toHaveLength(1);
    store.close();
  });

  test("delete removes session db file from disk", () => {
    seed([{ sid: "session-cleanup", state: "stopped" }]);
    const dbPath = join(storeDir, "sessions", "session-cleanup.sqlite");
    expect(existsSync(dbPath)).toBe(true);
    capture(`${CLI} session delete session-cleanup --yes`, env);
    expect(existsSync(dbPath)).toBe(false);
  });
});
