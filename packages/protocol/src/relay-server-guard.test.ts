import { describe, expect, test } from "bun:test";
import { parseRelayServerMessage } from "./relay-server-guard";

/**
 * Assert the guard accepts `input` and returns it structurally unchanged.
 * `input` is typed `unknown` on purpose: the fixtures use wide object literals
 * (their `t` is `string`, not a discriminant literal), so the structural
 * `toEqual` comparison exercises the "unknown in, validated union out" contract
 * without TypeScript narrowing the fixture to a single union member.
 */
function expectAccepted(input: unknown): void {
  expect(parseRelayServerMessage(input)).toEqual(
    input as ReturnType<typeof parseRelayServerMessage>,
  );
}

/** Assert the guard rejects `input` (returns null). */
function expectRejected(input: unknown): void {
  expect(parseRelayServerMessage(input)).toBeNull();
}

/**
 * Zero-trust boundary tests for the relay→client direction. Both RelayClients
 * (daemon + frontend) used to cast `JSON.parse(event.data)` straight to
 * RelayServerMessage and switch on `.t`, so a hostile or buggy relay could send
 * a `relay.frame` with no ct/seq/from, a `relay.presence` with a non-array
 * `sessions`, or an unknown discriminant the switch silently dropped. These
 * tests pin every accept/reject path of the guard.
 */
describe("parseRelayServerMessage", () => {
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
      expectRejected({ daemonId: "d" });
    });

    test("rejects object with non-string `t`", () => {
      expectRejected({ t: 7 });
    });

    test("rejects an unknown discriminant", () => {
      expectRejected({ t: "relay.bogus" });
      // A type that exists on the CLIENT→relay union but not relay→client must
      // also be rejected (it is not a RelayServerMessage).
      expectRejected({ t: "relay.pub", sid: "s", ct: "x", seq: 0 });
    });
  });

  describe("relay.auth.ok", () => {
    test("accepts minimal (only daemonId)", () => {
      expectAccepted({ t: "relay.auth.ok", daemonId: "d1" });
    });
    test("accepts with all optional resume fields", () => {
      expectAccepted({
        t: "relay.auth.ok",
        daemonId: "d1",
        resumeToken: "tok",
        resumeExpiresAt: 123,
        resumed: true,
      });
    });
    test.each<[string, unknown]>([
      ["missing daemonId", { t: "relay.auth.ok" }],
      ["non-string daemonId", { t: "relay.auth.ok", daemonId: 1 }],
      [
        "non-string resumeToken",
        { t: "relay.auth.ok", daemonId: "d", resumeToken: 5 },
      ],
      [
        "non-number resumeExpiresAt",
        { t: "relay.auth.ok", daemonId: "d", resumeExpiresAt: "x" },
      ],
      [
        "NaN resumeExpiresAt",
        { t: "relay.auth.ok", daemonId: "d", resumeExpiresAt: Number.NaN },
      ],
      [
        "non-boolean resumed",
        { t: "relay.auth.ok", daemonId: "d", resumed: "yes" },
      ],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.auth.err / relay.register.err", () => {
    test("accepts auth.err", () => {
      expectAccepted({ t: "relay.auth.err", e: "bad token" });
    });
    test("accepts register.err", () => {
      expectAccepted({ t: "relay.register.err", e: "taken" });
    });
    test.each<[string, unknown]>([
      ["auth.err missing e", { t: "relay.auth.err" }],
      ["auth.err non-string e", { t: "relay.auth.err", e: 9 }],
      ["register.err missing e", { t: "relay.register.err" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.register.ok", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "relay.register.ok", daemonId: "d1" });
    });
    test.each<[string, unknown]>([
      ["missing daemonId", { t: "relay.register.ok" }],
      ["non-string daemonId", { t: "relay.register.ok", daemonId: 0 }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.frame", () => {
    const valid = {
      t: "relay.frame",
      sid: "s1",
      ct: "cipher",
      seq: 0,
      from: "daemon",
    };
    test("accepts well-formed (seq=0 is valid)", () => {
      expectAccepted(valid);
    });
    test("accepts with optional frontendId", () => {
      expectAccepted({ ...valid, from: "frontend", frontendId: "fe1" });
    });
    test.each<[string, unknown]>([
      ["missing sid", { ...valid, sid: undefined }],
      ["missing ct", { ...valid, ct: undefined }],
      ["missing seq", { ...valid, seq: undefined }],
      ["non-number seq", { ...valid, seq: "1" }],
      ["NaN seq", { ...valid, seq: Number.NaN }],
      ["bad from", { ...valid, from: "relay" }],
      ["missing from", { ...valid, from: undefined }],
      ["non-string frontendId", { ...valid, frontendId: 5 }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.kx.frame", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "relay.kx.frame", ct: "cipher", from: "frontend" });
    });
    test.each<[string, unknown]>([
      ["missing ct", { t: "relay.kx.frame", from: "daemon" }],
      ["bad from", { t: "relay.kx.frame", ct: "x", from: "peer" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.presence", () => {
    const valid = {
      t: "relay.presence",
      daemonId: "d1",
      online: true,
      sessions: ["s1", "s2"],
      lastSeen: 1000,
    };
    test("accepts well-formed", () => {
      expectAccepted(valid);
    });
    test("accepts empty sessions array", () => {
      expectAccepted({ ...valid, sessions: [] });
    });
    test.each<[string, unknown]>([
      ["missing daemonId", { ...valid, daemonId: undefined }],
      ["non-boolean online", { ...valid, online: "yes" }],
      ["non-array sessions", { ...valid, sessions: "s1" }],
      ["sessions with non-string", { ...valid, sessions: ["s1", 2] }],
      ["missing lastSeen", { ...valid, lastSeen: undefined }],
      ["non-number lastSeen", { ...valid, lastSeen: "x" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.pong", () => {
    test("accepts with optional ts", () => {
      expectAccepted({ t: "relay.pong", ts: 42 });
    });
    test("accepts without ts", () => {
      expectAccepted({ t: "relay.pong" });
    });
    test("rejects non-number ts", () => {
      expectRejected({ t: "relay.pong", ts: "x" });
    });
  });

  describe("relay.err", () => {
    test("accepts with optional m", () => {
      expectAccepted({ t: "relay.err", e: "boom", m: "detail" });
    });
    test("accepts without m", () => {
      expectAccepted({ t: "relay.err", e: "boom" });
    });
    test.each<[string, unknown]>([
      ["missing e", { t: "relay.err" }],
      ["non-string e", { t: "relay.err", e: 1 }],
      ["non-string m", { t: "relay.err", e: "boom", m: 2 }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.notification", () => {
    const valid = { t: "relay.notification", title: "Hi", body: "Body" };
    test("accepts without optional data", () => {
      expectAccepted(valid);
    });
    test("accepts with well-formed data", () => {
      expectAccepted({
        ...valid,
        data: { sid: "s", daemonId: "d", event: "Stop" },
      });
    });
    test.each<[string, unknown]>([
      ["missing title", { ...valid, title: undefined }],
      ["missing body", { ...valid, body: undefined }],
      ["data not an object", { ...valid, data: "nope" }],
      ["data missing sid", { ...valid, data: { daemonId: "d", event: "e" } }],
      [
        "data with non-string event",
        { ...valid, data: { sid: "s", daemonId: "d", event: 9 } },
      ],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  test("does not carry over extra fields onto the result", () => {
    // The guard reconstructs each object field-by-field, so attacker-supplied
    // extra keys (a spoofed internal flag, a __proto__ payload) are dropped
    // rather than passed through to a handler.
    const m = {
      t: "relay.pong",
      ts: 5,
      evil: "should-not-survive",
    };
    const parsed = parseRelayServerMessage(m);
    expect(parsed).toEqual({ t: "relay.pong", ts: 5 });
    expect((parsed as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});
