import { describe, expect, test } from "bun:test";
import { parseRelayClientMessage } from "./relay-client-guard";

/**
 * Assert the guard accepts `input` and returns it structurally unchanged.
 * `input` is typed `unknown` on purpose: the test fixtures use wide object
 * literals (their `t` is `string`, not a discriminant literal), so passing
 * them straight to `toEqual` would fail to match the `RelayClientMessage`
 * overload. The guard's contract is "unknown in, validated union out", and
 * these helpers exercise exactly that boundary.
 */
function expectAccepted(input: unknown): void {
  // toEqual infers `expected` from the actual (RelayClientMessage | null), so a
  // bare `unknown` argument is rejected; the structural comparison is the same.
  expect(parseRelayClientMessage(input)).toEqual(
    input as ReturnType<typeof parseRelayClientMessage>,
  );
}

/** Assert the guard rejects `input` (returns null). */
function expectRejected(input: unknown): void {
  expect(parseRelayClientMessage(input)).toBeNull();
}

/**
 * Zero-trust boundary tests: a frame that parsed as JSON is NOT yet a valid
 * RelayClientMessage. The relay used to cast `JSON.parse(text)` straight to
 * RelayClientMessage and dispatch it, so a peer could send `{"t":"relay.pub"}`
 * with no sid/ct/seq and crash a handler on an undefined dereference. These
 * tests pin every accept/reject path of the guard.
 */
describe("parseRelayClientMessage", () => {
  describe("non-objects and missing discriminant", () => {
    // Each row is a single-element tuple: test.each spreads array rows as
    // call args, so a bare `[]` row would pass zero args (callback v=undefined,
    // read as a missing done-callback → hang) and `[1,2]` would pass two. Wrap
    // every value so exactly one arg reaches the callback.
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
      expectRejected({ t: "relay.bogus" });
      // A type that exists on the SERVER→client union but not client→relay
      // must also be rejected (it is not a RelayClientMessage).
      expectRejected({ t: "relay.frame" });
    });
  });

  describe("relay.auth", () => {
    const valid = {
      t: "relay.auth",
      role: "daemon",
      daemonId: "d1",
      token: "tok",
      v: 2,
    };

    test("accepts a well-formed daemon auth", () => {
      expectAccepted(valid);
    });

    test("accepts frontend auth with optional frontendId", () => {
      expectAccepted({ ...valid, role: "frontend", frontendId: "fe1" });
    });

    test("preserves an omitted frontendId as undefined", () => {
      const parsed = parseRelayClientMessage(valid);
      expect(parsed).not.toBeNull();
      expect((parsed as { frontendId?: string }).frontendId).toBeUndefined();
    });

    test.each<[string, unknown]>([
      ["bad role", { ...valid, role: "admin" }],
      ["missing role", { ...valid, role: undefined }],
      ["missing daemonId", { ...valid, daemonId: undefined }],
      ["non-string token", { ...valid, token: 123 }],
      ["non-number v", { ...valid, v: "2" }],
      ["NaN v", { ...valid, v: Number.NaN }],
      ["non-string frontendId", { ...valid, frontendId: 5 }],
    ])("rejects %s", (_label, msg) => {
      expectRejected(msg);
    });
  });

  describe("relay.auth.resume", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "relay.auth.resume", token: "tok", v: 2 });
    });
    test.each<[string, unknown]>([
      ["missing token", { t: "relay.auth.resume", v: 2 }],
      ["missing v", { t: "relay.auth.resume", token: "tok" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.register", () => {
    const valid = {
      t: "relay.register",
      daemonId: "d1",
      proof: "p",
      token: "tok",
      v: 2,
    };
    test("accepts well-formed", () => {
      expectAccepted(valid);
    });
    test.each<[string, unknown]>([
      ["missing proof", { ...valid, proof: undefined }],
      ["missing token", { ...valid, token: undefined }],
      ["missing daemonId", { ...valid, daemonId: undefined }],
      ["non-number v", { ...valid, v: null }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.kx", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "relay.kx", ct: "cipher", role: "frontend" });
    });
    test.each<[string, unknown]>([
      ["missing ct", { t: "relay.kx", role: "daemon" }],
      ["bad role", { t: "relay.kx", ct: "x", role: "peer" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.pub", () => {
    const valid = { t: "relay.pub", sid: "s1", ct: "cipher", seq: 0 };
    test("accepts well-formed (seq=0 is valid)", () => {
      expectAccepted(valid);
    });
    test("accepts positive seq", () => {
      expectAccepted({ t: "relay.pub", sid: "s1", ct: "cipher", seq: 42 });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "relay.pub", ct: "x", seq: 1 }],
      ["missing ct", { t: "relay.pub", sid: "s", seq: 1 }],
      ["missing seq", { t: "relay.pub", sid: "s", ct: "x" }],
      ["non-number seq", { t: "relay.pub", sid: "s", ct: "x", seq: "1" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
    // Tightened: seq must be a non-negative integer (monotonic counter).
    // Negative, fractional, and NaN values must be rejected even though they
    // are technically typeof==="number".
    test.each<[string, unknown]>([
      ["negative seq", { t: "relay.pub", sid: "s", ct: "x", seq: -1 }],
      ["fractional seq", { t: "relay.pub", sid: "s", ct: "x", seq: 1.5 }],
      ["NaN seq", { t: "relay.pub", sid: "s", ct: "x", seq: Number.NaN }],
    ])("rejects %s (non-negative-int tightening)", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.sub", () => {
    test("accepts with optional after", () => {
      expectAccepted({ t: "relay.sub", sid: "s", after: 10 });
    });
    test("accepts without after", () => {
      expectAccepted({ t: "relay.sub", sid: "s" });
    });
    test.each<[string, unknown]>([
      ["missing sid", { t: "relay.sub", after: 1 }],
      ["non-number after", { t: "relay.sub", sid: "s", after: "1" }],
    ])("rejects %s", (_l, m) => {
      expectRejected(m);
    });
  });

  describe("relay.unsub", () => {
    test("accepts well-formed", () => {
      expectAccepted({ t: "relay.unsub", sid: "s" });
    });
    test("rejects missing sid", () => {
      expectRejected({ t: "relay.unsub" });
    });
  });

  describe("relay.ping", () => {
    test("accepts with optional ts", () => {
      expectAccepted({ t: "relay.ping", ts: 123 });
    });
    test("accepts without ts", () => {
      expectAccepted({ t: "relay.ping" });
    });
    test("rejects non-number ts", () => {
      expectRejected({ t: "relay.ping", ts: "x" });
    });
  });

  describe("relay.push", () => {
    const valid = {
      t: "relay.push",
      frontendId: "fe",
      token: "ExponentPushToken[x]",
      title: "Hi",
      body: "Body",
    };
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
      ["missing frontendId", { ...valid, frontendId: undefined }],
      ["missing token", { ...valid, token: undefined }],
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

  test("does not mutate or carry over extra fields onto the result", () => {
    // The guard reconstructs the object field-by-field, so attacker-supplied
    // extra keys (e.g. a `__proto__` payload or a spoofed internal flag) are
    // dropped rather than passed through to a handler.
    const m = {
      t: "relay.unsub",
      sid: "s",
      evil: "should-not-survive",
    };
    const parsed = parseRelayClientMessage(m);
    expect(parsed).toEqual({ t: "relay.unsub", sid: "s" });
    expect(
      (parsed as unknown as Record<string, unknown>)["evil"],
    ).toBeUndefined();
  });
});
