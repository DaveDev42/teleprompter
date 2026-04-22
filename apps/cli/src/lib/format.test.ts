import { describe, expect, test } from "bun:test";
import { errorWithHints, formatAge } from "./format";

describe("errorWithHints", () => {
  test("formats error with single hint", () => {
    const result = errorWithHints("Something failed.", ["Try: tp doctor"]);
    expect(result).toBe("Something failed.\n  → Try: tp doctor");
  });

  test("formats error with multiple hints", () => {
    const result = errorWithHints("Connection timed out.", [
      "Check daemon: tp status",
      "Start manually: tp daemon start",
      "Diagnose: tp doctor",
    ]);
    expect(result).toContain("Connection timed out.");
    expect(result).toContain("  → Check daemon: tp status");
    expect(result).toContain("  → Start manually: tp daemon start");
    expect(result).toContain("  → Diagnose: tp doctor");
  });

  test("formats error with no hints", () => {
    const result = errorWithHints("Just an error.", []);
    expect(result).toBe("Just an error.");
  });
});

describe("formatAge", () => {
  test("seconds", () => {
    expect(formatAge(0)).toBe("0s ago");
    expect(formatAge(1_000)).toBe("1s ago");
    expect(formatAge(59_000)).toBe("59s ago");
  });

  test("minutes", () => {
    expect(formatAge(60_000)).toBe("1m ago");
    expect(formatAge(59 * 60_000)).toBe("59m ago");
  });

  test("hours", () => {
    expect(formatAge(60 * 60_000)).toBe("1h ago");
    expect(formatAge(23 * 60 * 60_000)).toBe("23h ago");
  });

  test("days (<7)", () => {
    expect(formatAge(24 * 60 * 60_000)).toBe("1d ago");
    expect(formatAge(6 * 24 * 60 * 60_000)).toBe("6d ago");
  });

  test("ISO date for ≥7d", () => {
    const result = formatAge(7 * 24 * 60 * 60_000);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
