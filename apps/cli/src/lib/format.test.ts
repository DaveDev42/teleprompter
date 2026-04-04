import { describe, expect, test } from "bun:test";
import { errorWithHints } from "./format";

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
