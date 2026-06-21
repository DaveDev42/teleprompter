import { describe, expect, test } from "bun:test";
import { parseSessionServerMessage } from "./session-server-guard";

/**
 * Assert the guard accepts `input` and returns it structurally unchanged.
 * `input` is typed `unknown` on purpose: the fixtures use wide object literals
 * (their `t` is `string`, not a discriminant literal), so the structural
 * `toEqual` exercises the "unknown in, validated union out" contract without
 * TypeScript narrowing the fixture to a single union member.
 */
function expectAccepted(input: unknown): void {
  expect(parseSessionServerMessage(input)).toEqual(
    input as ReturnType<typeof parseSessionServerMessage>,
  );
}

/** Assert the guard rejects `input` (returns null). */
function expectRejected(input: unknown): void {
  expect(parseSessionServerMessage(input)).toBeNull();
}

const META = {
  sid: "s1",
  state: "running" as const,
  cwd: "/work",
  worktreePath: "/wt",
  claudeVersion: "2.1.0",
  createdAt: 100,
  updatedAt: 200,
  lastSeq: 5,
};

/**
 * Zero-trust boundary tests for the daemon→frontend session-data plane. The
 * frontend's handleFrame used to cast `JSON.parse(decrypted)` straight to `any`
 * and dereference `msg.d.sessions`, `msg.seq`, `msg.d` (as arrays) with no
 * validation — a daemon on a mismatched protocol version or a truncated payload
 * that happened to decrypt would crash inside an event handler. These tests pin
 * every accept/reject path of the guard.
 */
describe("parseSessionServerMessage", () => {
  describe("non-objects and missing discriminant", () => {
    test.each<[unknown]>([
      [null],
      [undefined],
      [42],
      ["string"],
      [true],
      [[]],
      [[1, 2]],
    ])("rejects non-plain-object %p", (v) => {
      expectRejected(v);
    });

    test("rejects object with no `t`", () => {
      expectRejected({ sid: "s" });
    });
    test("rejects object with non-string `t`", () => {
      expectRejected({ t: 7 });
    });
    test("rejects an unknown discriminant", () => {
      expectRejected({ t: "session.bogus" });
      // A frontend→daemon control type (not a server message) must be rejected.
      expectRejected({ t: "attach", sid: "s" });
    });
  });

  describe("hello", () => {
    test("accepts with empty session list", () => {
      expectAccepted({ t: "hello", v: 2, d: { sessions: [] } });
    });
    test("accepts with sessions and a union daemonLabel", () => {
      expectAccepted({
        t: "hello",
        v: 2,
        d: { sessions: [META], daemonLabel: { set: true, value: "Office" } },
      });
    });
    test("accepts a legacy string daemonLabel unchanged (forgiving read)", () => {
      // An older daemon sends a bare string; the guard rides it through and the
      // call site normalizes it via decodeKxLabelOrKeep.
      expectAccepted({
        t: "hello",
        v: 2,
        d: { sessions: [], daemonLabel: "Legacy" },
      });
    });
    test("drops daemonLabel only when absent (not stamped as undefined)", () => {
      const parsed = parseSessionServerMessage({
        t: "hello",
        v: 2,
        d: { sessions: [] },
      });
      expect(parsed).toEqual({ t: "hello", v: 2, d: { sessions: [] } });
      expect("daemonLabel" in (parsed as { d: object }).d).toBe(false);
    });
    test.each<[string, unknown]>([
      ["non-number v", { t: "hello", v: "2", d: { sessions: [] } }],
      ["missing d", { t: "hello", v: 2 }],
      ["d not an object", { t: "hello", v: 2, d: "x" }],
      ["sessions not an array", { t: "hello", v: 2, d: { sessions: "s" } }],
      [
        "a session with bad state",
        { t: "hello", v: 2, d: { sessions: [{ ...META, state: "weird" }] } },
      ],
      [
        "a session missing cwd",
        { t: "hello", v: 2, d: { sessions: [{ ...META, cwd: undefined }] } },
      ],
      [
        "a session with non-number lastSeq",
        { t: "hello", v: 2, d: { sessions: [{ ...META, lastSeq: "5" }] } },
      ],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("state", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "state", sid: "s1", d: META });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "state", d: META }],
      ["d not a SessionMeta", { t: "state", sid: "s1", d: { sid: "s1" } }],
      [
        "d with bad state",
        { t: "state", sid: "s1", d: { ...META, state: "x" } },
      ],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("rec", () => {
    const valid = {
      t: "rec",
      sid: "s1",
      seq: 0,
      k: "io" as const,
      ns: "claude" as const,
      n: "stdout",
      d: "YmFzZTY0",
      ts: 1000,
    };
    test("accepts well-formed (seq=0 is valid)", () => {
      expectAccepted(valid);
    });
    test("accepts without optional ns/n", () => {
      expectAccepted({
        t: "rec",
        sid: "s1",
        seq: 1,
        k: "event",
        d: "x",
        ts: 1,
      });
    });
    test.each<[string, unknown]>([
      ["missing sid", { ...valid, sid: undefined }],
      ["non-number seq", { ...valid, seq: "0" }],
      ["bad kind k", { ...valid, k: "stdout" }],
      ["bad namespace ns", { ...valid, ns: "unknown" }],
      ["missing payload d", { ...valid, d: undefined }],
      ["missing ts", { ...valid, ts: undefined }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("batch", () => {
    const rec = { t: "rec", sid: "s1", seq: 1, k: "io", d: "x", ts: 1 };
    test("accepts well-formed", () => {
      expectAccepted({ t: "batch", sid: "s1", d: [rec, { ...rec, seq: 2 }] });
    });
    test("accepts empty batch", () => {
      expectAccepted({ t: "batch", sid: "s1", d: [] });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "batch", d: [rec] }],
      ["d not an array", { t: "batch", sid: "s1", d: rec }],
      [
        "a batch element with bad kind",
        { t: "batch", sid: "s1", d: [{ ...rec, k: "nope" }] },
      ],
      [
        "a batch element that isn't a rec",
        { t: "batch", sid: "s1", d: [{ t: "state", sid: "s1" }] },
      ],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("pong", () => {
    test("accepts (no fields)", () => {
      expectAccepted({ t: "pong" });
    });
    test("strips extra fields", () => {
      expect(parseSessionServerMessage({ t: "pong", evil: 1 })).toEqual({
        t: "pong",
      });
    });
  });

  describe("err", () => {
    test("accepts with optional m", () => {
      expectAccepted({ t: "err", e: "boom", m: "detail" });
    });
    test("accepts without m", () => {
      expectAccepted({ t: "err", e: "boom" });
    });
    test.each<[string, unknown]>([
      ["missing e", { t: "err" }],
      ["non-string e", { t: "err", e: 1 }],
      ["non-string m", { t: "err", e: "boom", m: 2 }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("worktree.list / worktree.created / worktree.removed", () => {
    const info = {
      path: "/wt",
      branch: "main",
      head: "abc123",
      isMain: true,
    };
    test("accepts worktree.list", () => {
      expectAccepted({
        t: "worktree.list",
        d: [info, { ...info, isMain: false }],
      });
    });
    test("accepts empty worktree.list", () => {
      expectAccepted({ t: "worktree.list", d: [] });
    });
    test("accepts worktree.created with optional sid", () => {
      expectAccepted({ t: "worktree.created", d: info, sid: "s1" });
    });
    test("accepts worktree.created without sid", () => {
      expectAccepted({ t: "worktree.created", d: info });
    });
    test("accepts worktree.removed", () => {
      expectAccepted({ t: "worktree.removed", path: "/wt" });
    });
    test.each<[string, unknown]>([
      ["list d not an array", { t: "worktree.list", d: info }],
      [
        "list element missing branch",
        { t: "worktree.list", d: [{ ...info, branch: undefined }] },
      ],
      [
        "list element non-boolean isMain",
        { t: "worktree.list", d: [{ ...info, isMain: "yes" }] },
      ],
      ["created d not info", { t: "worktree.created", d: { path: "/wt" } }],
      ["created non-string sid", { t: "worktree.created", d: info, sid: 5 }],
      ["removed missing path", { t: "worktree.removed" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("session.exported", () => {
    test("accepts json", () => {
      expectAccepted({
        t: "session.exported",
        sid: "s1",
        format: "json",
        d: "{}",
      });
    });
    test("accepts markdown", () => {
      expectAccepted({
        t: "session.exported",
        sid: "s1",
        format: "markdown",
        d: "# x",
      });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "session.exported", format: "json", d: "{}" }],
      [
        "bad format",
        { t: "session.exported", sid: "s1", format: "csv", d: "x" },
      ],
      ["missing d", { t: "session.exported", sid: "s1", format: "json" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("session.create.ok", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "session.create.ok", sid: "new-sid" });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "session.create.ok" }],
      ["non-string sid", { t: "session.create.ok", sid: 7 }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
    test("drops extra fields", () => {
      expect(
        parseSessionServerMessage({
          t: "session.create.ok",
          sid: "s",
          evil: 1,
        }),
      ).toEqual({ t: "session.create.ok", sid: "s" });
    });
  });

  test("does not carry over extra fields onto the result", () => {
    // The guard reconstructs each object field-by-field, so attacker-supplied
    // extra keys (a spoofed flag, a __proto__ payload) are dropped rather than
    // passed through to a handler.
    const m = { t: "err", e: "boom", evil: "should-not-survive" };
    const parsed = parseSessionServerMessage(m);
    expect(parsed).toEqual({ t: "err", e: "boom" });
    expect(
      (parsed as unknown as Record<string, unknown>)["evil"],
    ).toBeUndefined();
  });
});
