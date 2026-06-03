import { describe, expect, test } from "bun:test";
import {
  decodeKxLabelOrKeep,
  decodeWireLabel,
  LABEL_UNSET,
  type Label,
  labelToNullable,
  makeLabel,
} from "./label";

describe("LABEL_UNSET", () => {
  test("is the not-set variant", () => {
    expect(LABEL_UNSET).toEqual({ set: false });
  });
});

describe("makeLabel", () => {
  test("non-empty string → set", () => {
    expect(makeLabel("Office Mac")).toEqual({ set: true, value: "Office Mac" });
  });

  test("trims surrounding whitespace", () => {
    expect(makeLabel("  Office Mac  ")).toEqual({
      set: true,
      value: "Office Mac",
    });
  });

  test.each<[string, string | null | undefined]>([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n "],
    ["null", null],
    ["undefined", undefined],
  ])("%s → not set", (_label, input) => {
    expect(makeLabel(input)).toEqual({ set: false });
  });
});

describe("labelToNullable", () => {
  test("set → value", () => {
    expect(labelToNullable({ set: true, value: "x" })).toBe("x");
  });

  test("not set → null", () => {
    expect(labelToNullable({ set: false })).toBeNull();
  });

  test("round-trips with makeLabel for a real value", () => {
    const l = makeLabel("Office Mac");
    expect(makeLabel(labelToNullable(l))).toEqual(l);
  });

  test("round-trips with makeLabel for unset", () => {
    const l = makeLabel(null);
    expect(makeLabel(labelToNullable(l))).toEqual(l);
  });
});

describe("decodeWireLabel — authoritative-clear surfaces (ControlRename, SQLite, IPC)", () => {
  test.each<[string, unknown, Label]>([
    // legacy string shape
    [
      "legacy non-empty string",
      "Office Mac",
      { set: true, value: "Office Mac" },
    ],
    [
      "legacy string trimmed",
      "  Office Mac ",
      { set: true, value: "Office Mac" },
    ],
    ["legacy empty string (clear)", "", { set: false }],
    ["legacy whitespace string", "   ", { set: false }],
    // legacy absence
    ["legacy null", null, { set: false }],
    ["legacy undefined", undefined, { set: false }],
    // new union shape
    [
      "new union set:true",
      { set: true, value: "Office Mac" },
      { set: true, value: "Office Mac" },
    ],
    [
      "new union set:true trims value",
      { set: true, value: "  Office Mac  " },
      { set: true, value: "Office Mac" },
    ],
    ["new union set:false", { set: false }, { set: false }],
    // malformed → safe fallback
    ["number", 42, { set: false }],
    ["boolean", true, { set: false }],
    ["array", ["x"], { set: false }],
    ["empty object", {}, { set: false }],
    ["set:true with non-string value", { set: true, value: 9 }, { set: false }],
    ["set:true with missing value", { set: true }, { set: false }],
    [
      "set:true with empty value collapses to not-set",
      { set: true, value: "" },
      { set: false },
    ],
  ])("%s", (_label, input, expected) => {
    expect(decodeWireLabel(input)).toEqual(expected);
  });
});

describe("decodeKxLabelOrKeep — keep-current surfaces (kx daemon-hello, meta hello)", () => {
  test("a real label decodes to set", () => {
    expect(decodeKxLabelOrKeep("Office Mac")).toEqual({
      set: true,
      value: "Office Mac",
    });
    expect(decodeKxLabelOrKeep({ set: true, value: "Office Mac" })).toEqual({
      set: true,
      value: "Office Mac",
    });
  });

  test.each<[string, unknown]>([
    ["legacy null → keep-current", null],
    ["legacy undefined → keep-current", undefined],
    ["legacy empty string → keep-current", ""],
    ["legacy whitespace → keep-current", "   "],
    ["new union set:false → keep-current", { set: false }],
    ["malformed → keep-current", 42],
  ])("%s returns null (not a clear)", (_label, input) => {
    // The crucial distinction: on kx/hello, "not set" must NOT clear the
    // app-side label — it returns null so handleDaemonHello short-circuits.
    expect(decodeKxLabelOrKeep(input)).toBeNull();
  });
});

describe("cross-version interop (the whole point of option B)", () => {
  test("a v2 reader reads a legacy v1 string-shaped ControlRename label", () => {
    // Old daemon → new app: the wire still carries a plain string.
    expect(decodeWireLabel("Legacy Name")).toEqual({
      set: true,
      value: "Legacy Name",
    });
    expect(decodeWireLabel("")).toEqual({ set: false }); // legacy clear
  });

  test("a v2 reader reads a new union-shaped ControlRename label", () => {
    // New daemon → new app.
    expect(decodeWireLabel({ set: true, value: "New Name" })).toEqual({
      set: true,
      value: "New Name",
    });
    expect(decodeWireLabel({ set: false })).toEqual({ set: false }); // new clear
  });

  test("kx keep-current holds across both legacy and union absence", () => {
    // Old daemon hello with no label (null) and new daemon hello with
    // { set: false } must BOTH mean keep-current, never clear.
    expect(decodeKxLabelOrKeep(null)).toBeNull();
    expect(decodeKxLabelOrKeep({ set: false })).toBeNull();
  });
});
