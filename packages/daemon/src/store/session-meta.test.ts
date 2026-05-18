import { describe, expect, test } from "bun:test";
import { toWsSessionMeta } from "./session-meta";
import type { SessionMeta } from "./store";

describe("toWsSessionMeta", () => {
  test("maps snake_case DB fields to camelCase wire fields", () => {
    const row: SessionMeta = {
      sid: "s1",
      state: "running",
      cwd: "/tmp/work",
      worktree_path: "/tmp/work/wt",
      claude_version: "1.2.3",
      created_at: 1700000000,
      updated_at: 1700000100,
      last_seq: 42,
    };

    const wire = toWsSessionMeta(row);

    expect(wire).toEqual({
      sid: "s1",
      state: "running",
      cwd: "/tmp/work",
      worktreePath: "/tmp/work/wt",
      claudeVersion: "1.2.3",
      createdAt: 1700000000,
      updatedAt: 1700000100,
      lastSeq: 42,
    });
  });

  test("converts null worktree_path and claude_version to undefined", () => {
    const row: SessionMeta = {
      sid: "s2",
      state: "stopped",
      cwd: "/home/u",
      worktree_path: null,
      claude_version: null,
      created_at: 1,
      updated_at: 2,
      last_seq: 0,
    };

    const wire = toWsSessionMeta(row);

    expect(wire.worktreePath).toBeUndefined();
    expect(wire.claudeVersion).toBeUndefined();
    // Required fields still pass through.
    expect(wire.sid).toBe("s2");
    expect(wire.state).toBe("stopped");
    expect(wire.cwd).toBe("/home/u");
    expect(wire.lastSeq).toBe(0);
  });

  test("preserves all wire-format keys (no stray DB columns)", () => {
    const row: SessionMeta = {
      sid: "s3",
      state: "running",
      cwd: "/x",
      worktree_path: null,
      claude_version: null,
      created_at: 0,
      updated_at: 0,
      last_seq: 0,
    };

    const wire = toWsSessionMeta(row);
    const keys = Object.keys(wire).sort();
    expect(keys).toEqual(
      [
        "sid",
        "state",
        "cwd",
        "worktreePath",
        "claudeVersion",
        "createdAt",
        "updatedAt",
        "lastSeq",
      ].sort(),
    );
  });
});
