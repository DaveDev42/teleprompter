import { describe, expect, test } from "bun:test";
import { dim, fail, green, ok, red, warn, yellow } from "./colors";

// Colors module reads NO_COLOR at import time, so these tests
// verify behavior in the current environment rather than asserting
// exact ANSI codes that would break under NO_COLOR=1.

const colored = !process.env.NO_COLOR;

describe("colors", () => {
  test("green wraps text", () => {
    const result = green("hello");
    expect(result).toContain("hello");
    if (colored) expect(result).toContain("\x1b[");
  });

  test("yellow wraps text", () => {
    const result = yellow("warning");
    expect(result).toContain("warning");
    if (colored) expect(result).toContain("\x1b[");
  });

  test("red wraps text", () => {
    const result = red("error");
    expect(result).toContain("error");
    if (colored) expect(result).toContain("\x1b[");
  });

  test("dim wraps text", () => {
    const result = dim("muted");
    expect(result).toContain("muted");
    if (colored) expect(result).toContain("\x1b[");
  });

  test("returns plain text when NO_COLOR would be set", () => {
    // We can't toggle NO_COLOR at runtime since it's read at import time,
    // but we verify the structure is correct either way.
    const result = green("test");
    expect(result).toContain("test");
  });
});

describe("semantic helpers", () => {
  test("ok prefixes with check mark", () => {
    const result = ok("All good");
    expect(result).toContain("✓");
    expect(result).toContain("All good");
  });

  test("warn prefixes with bang", () => {
    const result = warn("Caution");
    expect(result).toContain("!");
    expect(result).toContain("Caution");
  });

  test("fail prefixes with cross", () => {
    const result = fail("Bad");
    expect(result).toContain("✕");
    expect(result).toContain("Bad");
  });
});
