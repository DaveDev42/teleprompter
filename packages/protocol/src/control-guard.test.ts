import { describe, expect, test } from "bun:test";
import { parseControlMessage } from "./control-guard";
import { CONTROL_RENAME, CONTROL_UNPAIR } from "./types/control";

describe("parseControlMessage", () => {
  describe("basic validation", () => {
    test("returns null for non-objects", () => {
      expect(parseControlMessage(null)).toBeNull();
      expect(parseControlMessage(undefined)).toBeNull();
      expect(parseControlMessage("string")).toBeNull();
      expect(parseControlMessage(42)).toBeNull();
      expect(parseControlMessage(true)).toBeNull();
    });

    test("returns null when t is missing or not a string", () => {
      expect(parseControlMessage({})).toBeNull();
      expect(parseControlMessage({ t: 42 })).toBeNull();
      expect(parseControlMessage({ t: null })).toBeNull();
    });

    test("returns null for unknown discriminants", () => {
      expect(parseControlMessage({ t: "in.chat" })).toBeNull();
      expect(parseControlMessage({ t: "pushToken" })).toBeNull();
      expect(parseControlMessage({ t: "control.bogus" })).toBeNull();
    });
  });

  describe("control.unpair", () => {
    test("accepts a valid unpair", () => {
      const result = parseControlMessage({
        t: CONTROL_UNPAIR,
        daemonId: "d1",
        frontendId: "f1",
        reason: "user-initiated",
        ts: 1234,
      });
      expect(result).toEqual({
        t: CONTROL_UNPAIR,
        daemonId: "d1",
        frontendId: "f1",
        reason: "user-initiated",
        ts: 1234,
      });
    });

    test("accepts each known reason", () => {
      for (const reason of [
        "user-initiated",
        "device-removed",
        "rotated",
      ] as const) {
        const result = parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          frontendId: "f1",
          reason,
          ts: 1,
        });
        expect(result?.t).toBe(CONTROL_UNPAIR);
      }
    });

    test("rejects a missing or non-string frontendId", () => {
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          reason: "user-initiated",
          ts: 1,
        }),
      ).toBeNull();
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          frontendId: 42,
          reason: "user-initiated",
          ts: 1,
        }),
      ).toBeNull();
    });

    test("rejects a missing daemonId", () => {
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          frontendId: "f1",
          reason: "user-initiated",
          ts: 1,
        }),
      ).toBeNull();
    });

    test("rejects an unrecognized reason", () => {
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          frontendId: "f1",
          reason: "windows-rebooted",
          ts: 1,
        }),
      ).toBeNull();
    });

    test("rejects a missing or non-numeric ts", () => {
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          frontendId: "f1",
          reason: "user-initiated",
        }),
      ).toBeNull();
      expect(
        parseControlMessage({
          t: CONTROL_UNPAIR,
          daemonId: "d1",
          frontendId: "f1",
          reason: "user-initiated",
          ts: "soon",
        }),
      ).toBeNull();
    });
  });

  describe("control.rename", () => {
    test("accepts a rename carrying the new Label union", () => {
      const result = parseControlMessage({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: { set: true, value: "Office Mac" },
        ts: 1234,
      });
      expect(result).toEqual({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: { set: true, value: "Office Mac" },
        ts: 1234,
      });
    });

    test("forgivingly lifts a legacy string label", () => {
      const result = parseControlMessage({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: "Office Mac",
        ts: 1,
      });
      expect(result).toMatchObject({
        t: CONTROL_RENAME,
        label: { set: true, value: "Office Mac" },
      });
    });

    test("treats a legacy empty string as an authoritative clear", () => {
      const result = parseControlMessage({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: "",
        ts: 1,
      });
      expect(result).toMatchObject({ label: { set: false } });
    });

    test("treats a { set: false } union as a clear", () => {
      const result = parseControlMessage({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: { set: false },
        ts: 1,
      });
      expect(result).toMatchObject({ label: { set: false } });
    });

    test("falls back to clear for a malformed label rather than rejecting", () => {
      // A non-string/non-union label still yields a structurally valid rename
      // (decodeWireLabel's documented lossy fallback) — the structural fields
      // are what gate validity.
      const result = parseControlMessage({
        t: CONTROL_RENAME,
        daemonId: "d1",
        frontendId: "f1",
        label: 42,
        ts: 1,
      });
      expect(result).toMatchObject({ label: { set: false } });
    });

    test("rejects a rename missing the structural fields", () => {
      expect(
        parseControlMessage({
          t: CONTROL_RENAME,
          frontendId: "f1",
          label: { set: false },
          ts: 1,
        }),
      ).toBeNull();
      expect(
        parseControlMessage({
          t: CONTROL_RENAME,
          daemonId: "d1",
          label: { set: false },
          ts: 1,
        }),
      ).toBeNull();
      expect(
        parseControlMessage({
          t: CONTROL_RENAME,
          daemonId: "d1",
          frontendId: "f1",
          label: { set: false },
        }),
      ).toBeNull();
    });
  });
});
