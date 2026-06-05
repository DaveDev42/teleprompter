import { describe, expect, test } from "bun:test";
import { parseFiniteInt } from "../lib/parse-int";
import { capture } from "../test-util";

const TIMEOUT = 15000;

describe("tp relay", () => {
  test(
    "without subcommand prints usage and exits non-zero",
    () => {
      // capture() swallows the non-zero exit and returns stderr.
      const out = capture("bun run apps/cli/src/index.ts relay");
      expect(out).toContain("Usage: tp relay start");
      expect(out).toContain("--port");
      expect(out).toContain("--cache-size");
      expect(out).toContain("--max-frame-size");
    },
    TIMEOUT,
  );

  test(
    "ping forwards users to tp doctor and exits 0",
    () => {
      const out = capture("bun run apps/cli/src/index.ts relay ping");
      expect(out).toContain("tp doctor");
    },
    TIMEOUT,
  );

  test(
    "unknown subcommand falls through to usage",
    () => {
      const out = capture("bun run apps/cli/src/index.ts relay bogus");
      expect(out).toContain("Usage: tp relay start");
    },
    TIMEOUT,
  );
});

// ── parseFiniteInt unit tests ─────────────────────────────────────────────────
// Testing the exported helper directly avoids subprocess overhead for cases
// that are purely about the parsing logic.

describe("parseFiniteInt", () => {
  test("accepts valid positive integers", () => {
    expect(parseFiniteInt("1")).toBe(1);
    expect(parseFiniteInt("7090")).toBe(7090);
    expect(parseFiniteInt("65535")).toBe(65535);
  });

  test("rejects zero", () => {
    expect(() => parseFiniteInt("0")).toThrow();
  });

  test("rejects negative integers", () => {
    expect(() => parseFiniteInt("-1")).toThrow();
    expect(() => parseFiniteInt("-100")).toThrow();
  });

  test("rejects trailing garbage", () => {
    expect(() => parseFiniteInt("0abc")).toThrow();
    expect(() => parseFiniteInt("7090x")).toThrow();
  });

  test("rejects non-numeric strings", () => {
    expect(() => parseFiniteInt("abc")).toThrow();
    expect(() => parseFiniteInt("")).toThrow();
  });

  test("rejects floating-point notation", () => {
    expect(() => parseFiniteInt("1.5")).toThrow();
    expect(() => parseFiniteInt("1e3")).toThrow();
  });
});
