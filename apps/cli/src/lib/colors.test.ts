import { describe, expect, test } from "bun:test";
import { dim, fail, green, ok, red, warn, yellow } from "./colors";

describe("colors", () => {
  test("green wraps text with ANSI green", () => {
    expect(green("hello")).toBe("\x1b[32mhello\x1b[0m");
  });

  test("yellow wraps text with ANSI yellow", () => {
    expect(yellow("warning")).toBe("\x1b[33mwarning\x1b[0m");
  });

  test("red wraps text with ANSI red", () => {
    expect(red("error")).toBe("\x1b[31merror\x1b[0m");
  });

  test("dim wraps text with ANSI gray", () => {
    expect(dim("muted")).toBe("\x1b[90mmuted\x1b[0m");
  });
});

describe("semantic helpers", () => {
  test("ok prefixes with green check", () => {
    const result = ok("All good");
    expect(result).toContain("✓");
    expect(result).toContain("All good");
  });

  test("warn prefixes with yellow bang", () => {
    const result = warn("Caution");
    expect(result).toContain("!");
    expect(result).toContain("Caution");
  });

  test("fail prefixes with red cross", () => {
    const result = fail("Bad");
    expect(result).toContain("✕");
    expect(result).toContain("Bad");
  });
});
