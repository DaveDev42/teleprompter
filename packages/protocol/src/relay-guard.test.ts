import { describe, expect, test } from "bun:test";
import { parseRelayControlMessage } from "./relay-guard";

describe("parseRelayControlMessage", () => {
  describe("basic validation", () => {
    test("returns null for non-objects", () => {
      expect(parseRelayControlMessage(null)).toBeNull();
      expect(parseRelayControlMessage(undefined)).toBeNull();
      expect(parseRelayControlMessage("x")).toBeNull();
      expect(parseRelayControlMessage(42)).toBeNull();
    });

    test("returns null when t is missing or not a string", () => {
      expect(parseRelayControlMessage({})).toBeNull();
      expect(parseRelayControlMessage({ t: 5 })).toBeNull();
    });

    test("returns null for unknown discriminants", () => {
      expect(parseRelayControlMessage({ t: "unknown" })).toBeNull();
      expect(parseRelayControlMessage({ t: "in.chat" })).toBeNull();
    });
  });

  describe("hello / ping", () => {
    test("hello requires numeric v", () => {
      expect(parseRelayControlMessage({ t: "hello", v: 1 })).toEqual({
        t: "hello",
        v: 1,
      });
      expect(parseRelayControlMessage({ t: "hello" })).toBeNull();
      expect(parseRelayControlMessage({ t: "hello", v: "1" })).toBeNull();
    });

    test("ping has no fields", () => {
      expect(parseRelayControlMessage({ t: "ping" })).toEqual({ t: "ping" });
    });
  });

  describe("attach / detach", () => {
    test("attach", () => {
      expect(parseRelayControlMessage({ t: "attach", sid: "s" })).toEqual({
        t: "attach",
        sid: "s",
      });
      expect(parseRelayControlMessage({ t: "attach" })).toBeNull();
      expect(parseRelayControlMessage({ t: "attach", sid: 1 })).toBeNull();
    });

    test("detach", () => {
      expect(parseRelayControlMessage({ t: "detach", sid: "s" })).toEqual({
        t: "detach",
        sid: "s",
      });
      expect(parseRelayControlMessage({ t: "detach" })).toBeNull();
    });
  });

  describe("resume", () => {
    test("accepts valid", () => {
      expect(
        parseRelayControlMessage({ t: "resume", sid: "s", c: 10 }),
      ).toEqual({ t: "resume", sid: "s", c: 10 });
    });

    test("accepts c=0 (first-frame cursor)", () => {
      expect(parseRelayControlMessage({ t: "resume", sid: "s", c: 0 })).toEqual(
        { t: "resume", sid: "s", c: 0 },
      );
    });

    test("rejects when c is missing or not a number", () => {
      expect(parseRelayControlMessage({ t: "resume", sid: "s" })).toBeNull();
      expect(
        parseRelayControlMessage({ t: "resume", sid: "s", c: "10" }),
      ).toBeNull();
    });

    // Tightened: c is a frame-index cursor — must be a non-negative integer.
    test("rejects c=-1 (negative cursor)", () => {
      expect(
        parseRelayControlMessage({ t: "resume", sid: "s", c: -1 }),
      ).toBeNull();
    });

    test("rejects c=2.5 (fractional cursor)", () => {
      expect(
        parseRelayControlMessage({ t: "resume", sid: "s", c: 2.5 }),
      ).toBeNull();
    });
  });

  describe("resize", () => {
    test("accepts valid", () => {
      expect(
        parseRelayControlMessage({
          t: "resize",
          sid: "s",
          cols: 80,
          rows: 24,
        }),
      ).toEqual({ t: "resize", sid: "s", cols: 80, rows: 24 });
    });

    test("rejects when cols/rows missing", () => {
      expect(
        parseRelayControlMessage({ t: "resize", sid: "s", cols: 80 }),
      ).toBeNull();
      expect(
        parseRelayControlMessage({ t: "resize", sid: "s", rows: 24 }),
      ).toBeNull();
    });

    test("rejects non-positive-integer cols/rows", () => {
      // Regression: cols/rows used isNumber (typeof + finite), letting 0,
      // negatives, and fractions through to Bun.terminal.resize, where 0
      // collapses ncurses layout and a negative wraps to an absurd width.
      // A paired-but-buggy/malicious frontend could ship these in an encrypted
      // resize frame; the guard must reject them.
      for (const bad of [
        0,
        -1,
        -80,
        80.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          parseRelayControlMessage({
            t: "resize",
            sid: "s",
            cols: bad,
            rows: 24,
          }),
        ).toBeNull();
        expect(
          parseRelayControlMessage({
            t: "resize",
            sid: "s",
            cols: 80,
            rows: bad,
          }),
        ).toBeNull();
      }
    });
  });

  describe("session.* messages", () => {
    test("session.create requires cwd", () => {
      expect(
        parseRelayControlMessage({ t: "session.create", cwd: "/tmp" }),
      ).toEqual({ t: "session.create", cwd: "/tmp", sid: undefined });
      expect(
        parseRelayControlMessage({
          t: "session.create",
          cwd: "/tmp",
          sid: "s",
        }),
      ).toEqual({ t: "session.create", cwd: "/tmp", sid: "s" });
      expect(parseRelayControlMessage({ t: "session.create" })).toBeNull();
    });

    test("session.create accepts valid cols/rows, rejects non-positive-int", () => {
      expect(
        parseRelayControlMessage({
          t: "session.create",
          cwd: "/tmp",
          cols: 120,
          rows: 40,
        }),
      ).toEqual({
        t: "session.create",
        cwd: "/tmp",
        sid: undefined,
        cols: 120,
        rows: 40,
      });
      // Optional dimensions, when present, must be positive integers — same
      // PTY-resize hazard as the resize message.
      for (const bad of [0, -1, 80.5, Number.NaN]) {
        expect(
          parseRelayControlMessage({
            t: "session.create",
            cwd: "/tmp",
            cols: bad,
          }),
        ).toBeNull();
        expect(
          parseRelayControlMessage({
            t: "session.create",
            cwd: "/tmp",
            rows: bad,
          }),
        ).toBeNull();
      }
    });

    test("session.stop / session.restart require sid", () => {
      expect(parseRelayControlMessage({ t: "session.stop", sid: "s" })).toEqual(
        { t: "session.stop", sid: "s" },
      );
      expect(
        parseRelayControlMessage({ t: "session.restart", sid: "s" }),
      ).toEqual({ t: "session.restart", sid: "s" });
      expect(parseRelayControlMessage({ t: "session.stop" })).toBeNull();
    });

    test("session.export validates nested fields", () => {
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          format: "json",
          recordTypes: ["io", "event"],
          timeRange: { from: 0, to: 100 },
          limit: 500,
        }),
      ).toEqual({
        t: "session.export",
        sid: "s",
        format: "json",
        recordTypes: ["io", "event"],
        timeRange: { from: 0, to: 100 },
        limit: 500,
      });
    });

    test("session.export accepts minimal form", () => {
      const result = parseRelayControlMessage({
        t: "session.export",
        sid: "s",
      });
      expect(result?.t).toBe("session.export");
      if (result?.t === "session.export") {
        expect(result.format).toBeUndefined();
        expect(result.recordTypes).toBeUndefined();
        expect(result.timeRange).toBeUndefined();
        expect(result.limit).toBeUndefined();
      }
    });

    test("session.export rejects invalid format", () => {
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          format: "xml",
        }),
      ).toBeNull();
    });

    test("session.export rejects invalid recordTypes", () => {
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          recordTypes: ["bogus"],
        }),
      ).toBeNull();
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          recordTypes: "io",
        }),
      ).toBeNull();
    });

    test("session.export rejects invalid timeRange", () => {
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          timeRange: { from: "a" },
        }),
      ).toBeNull();
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          timeRange: "nope",
        }),
      ).toBeNull();
    });

    test("session.export rejects non-number limit", () => {
      expect(
        parseRelayControlMessage({
          t: "session.export",
          sid: "s",
          limit: "50",
        }),
      ).toBeNull();
    });
  });

  describe("worktree.* messages", () => {
    test("worktree.list", () => {
      expect(parseRelayControlMessage({ t: "worktree.list" })).toEqual({
        t: "worktree.list",
      });
    });

    test("worktree.create", () => {
      expect(
        parseRelayControlMessage({
          t: "worktree.create",
          branch: "feature-x",
        }),
      ).toEqual({
        t: "worktree.create",
        branch: "feature-x",
        baseBranch: undefined,
        path: undefined,
      });
      expect(
        parseRelayControlMessage({
          t: "worktree.create",
          branch: "f",
          baseBranch: "main",
          path: "custom",
        }),
      ).toEqual({
        t: "worktree.create",
        branch: "f",
        baseBranch: "main",
        path: "custom",
      });
      expect(parseRelayControlMessage({ t: "worktree.create" })).toBeNull();
    });

    test("worktree.remove", () => {
      expect(
        parseRelayControlMessage({ t: "worktree.remove", path: "/p" }),
      ).toEqual({ t: "worktree.remove", path: "/p", force: undefined });
      expect(
        parseRelayControlMessage({
          t: "worktree.remove",
          path: "/p",
          force: true,
        }),
      ).toEqual({ t: "worktree.remove", path: "/p", force: true });
      expect(
        parseRelayControlMessage({
          t: "worktree.remove",
          path: "/p",
          force: "yes",
        }),
      ).toBeNull();
    });
  });
});
