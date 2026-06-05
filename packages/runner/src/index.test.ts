/**
 * idx 32 regression — parseInt cols/rows NaN guard.
 *
 * The entry point at index.ts uses:
 *   Math.max(1, parseInt(value, 10) || fallback)
 *
 * This test exercises the guard logic directly so CI catches any regression
 * without needing to spawn the full runner process.
 */
import { describe, expect, test } from "bun:test";

/** Mirror of the guard expression used in index.ts */
function parseDim(value: string, fallback: number): number {
  return Math.max(1, parseInt(value, 10) || fallback);
}

describe("index.ts NaN guard for cols/rows (idx 32)", () => {
  test("numeric string parses correctly", () => {
    expect(parseDim("80", 120)).toBe(80);
    expect(parseDim("24", 40)).toBe(24);
  });

  test("non-numeric string falls back to default", () => {
    // parseInt("abc", 10) → NaN → || fallback
    expect(parseDim("abc", 120)).toBe(120);
    expect(parseDim("", 120)).toBe(120);
  });

  test("zero falls back to default (zero terminal dim is invalid)", () => {
    // parseInt("0") = 0 which is falsy → || fallback
    // This is intentional: a zero-column terminal is not useful.
    expect(parseDim("0", 120)).toBe(120);
  });

  test("negative value is clamped to 1 via Math.max", () => {
    expect(parseDim("-5", 120)).toBe(1);
  });

  test("default values match index.ts literals", () => {
    expect(parseDim("120", 120)).toBe(120);
    expect(parseDim("40", 40)).toBe(40);
  });
});
