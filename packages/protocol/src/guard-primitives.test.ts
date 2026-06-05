import { describe, expect, test } from "bun:test";
import {
  isNonNegativeInt,
  isNumber,
  isObject,
  isOptionalNumber,
  isOptionalString,
  isPositiveInt,
  isString,
  isStringArray,
} from "./guard-primitives";

describe("isObject", () => {
  test("accepts plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  test("rejects non-objects", () => {
    expect(isObject(null)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject("string")).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2])).toBe(false);
  });
});

describe("isString", () => {
  test("accepts strings", () => {
    expect(isString("")).toBe(true);
    expect(isString("hello")).toBe(true);
  });

  test("rejects non-strings", () => {
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString(42)).toBe(false);
    expect(isString(true)).toBe(false);
    expect(isString({})).toBe(false);
  });
});

describe("isNumber", () => {
  test("accepts finite numbers", () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(1)).toBe(true);
    expect(isNumber(-1)).toBe(true);
    expect(isNumber(1.5)).toBe(true);
    expect(isNumber(-3.14)).toBe(true);
  });

  test("rejects NaN", () => {
    expect(isNumber(Number.NaN)).toBe(false);
  });

  test("rejects Infinity", () => {
    expect(isNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isNumber(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  test("rejects non-numbers", () => {
    expect(isNumber("3")).toBe(false);
    expect(isNumber(null)).toBe(false);
    expect(isNumber(undefined)).toBe(false);
    expect(isNumber(true)).toBe(false);
    expect(isNumber({})).toBe(false);
  });
});

describe("isOptionalString", () => {
  test("accepts strings and undefined", () => {
    expect(isOptionalString(undefined)).toBe(true);
    expect(isOptionalString("")).toBe(true);
    expect(isOptionalString("hello")).toBe(true);
  });

  test("rejects null and non-strings", () => {
    expect(isOptionalString(null)).toBe(false);
    expect(isOptionalString(42)).toBe(false);
    expect(isOptionalString(true)).toBe(false);
  });
});

describe("isOptionalNumber", () => {
  test("accepts finite numbers and undefined", () => {
    expect(isOptionalNumber(undefined)).toBe(true);
    expect(isOptionalNumber(0)).toBe(true);
    expect(isOptionalNumber(-1)).toBe(true);
    expect(isOptionalNumber(1.5)).toBe(true);
  });

  test("rejects NaN, Infinity, and non-numbers", () => {
    expect(isOptionalNumber(Number.NaN)).toBe(false);
    expect(isOptionalNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isOptionalNumber("3")).toBe(false);
    expect(isOptionalNumber(null)).toBe(false);
  });
});

describe("isNonNegativeInt", () => {
  test("accepts 0 and positive integers", () => {
    expect(isNonNegativeInt(0)).toBe(true);
    expect(isNonNegativeInt(1)).toBe(true);
    expect(isNonNegativeInt(100)).toBe(true);
    expect(isNonNegativeInt(999999)).toBe(true);
  });

  test("rejects -1 (negative integer)", () => {
    expect(isNonNegativeInt(-1)).toBe(false);
  });

  test("rejects 1.5 (non-integer)", () => {
    expect(isNonNegativeInt(1.5)).toBe(false);
  });

  test("rejects NaN", () => {
    expect(isNonNegativeInt(Number.NaN)).toBe(false);
  });

  test("rejects Infinity", () => {
    expect(isNonNegativeInt(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("rejects string '3'", () => {
    expect(isNonNegativeInt("3")).toBe(false);
  });

  test("rejects null", () => {
    expect(isNonNegativeInt(null)).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isNonNegativeInt(undefined)).toBe(false);
  });
});

describe("isPositiveInt", () => {
  test("accepts positive integers", () => {
    expect(isPositiveInt(1)).toBe(true);
    expect(isPositiveInt(2)).toBe(true);
    expect(isPositiveInt(1234)).toBe(true);
  });

  test("rejects 0 (not positive)", () => {
    expect(isPositiveInt(0)).toBe(false);
  });

  test("rejects -1 (negative)", () => {
    expect(isPositiveInt(-1)).toBe(false);
  });

  test("rejects 1.5 (non-integer)", () => {
    expect(isPositiveInt(1.5)).toBe(false);
  });

  test("rejects NaN", () => {
    expect(isPositiveInt(Number.NaN)).toBe(false);
  });

  test("rejects Infinity", () => {
    expect(isPositiveInt(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("rejects string '3'", () => {
    expect(isPositiveInt("3")).toBe(false);
  });

  test("rejects null", () => {
    expect(isPositiveInt(null)).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isPositiveInt(undefined)).toBe(false);
  });
});

describe("isStringArray", () => {
  test("accepts empty array", () => {
    expect(isStringArray([])).toBe(true);
  });

  test("accepts string arrays", () => {
    expect(isStringArray(["a", "b", "c"])).toBe(true);
  });

  test("rejects arrays with non-string elements", () => {
    expect(isStringArray(["a", 42])).toBe(false);
    expect(isStringArray([null])).toBe(false);
  });

  test("rejects non-arrays", () => {
    expect(isStringArray("string")).toBe(false);
    expect(isStringArray(null)).toBe(false);
    expect(isStringArray({})).toBe(false);
  });
});
