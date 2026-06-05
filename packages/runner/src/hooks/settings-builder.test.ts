import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSettings } from "./settings-builder";

describe("buildSettings", () => {
  let tempDir: string;
  const hookSocket = "/tmp/test-hook.sock";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tp-settings-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("generates settings with TP hooks for all events", () => {
    const result = JSON.parse(buildSettings(hookSocket));
    expect(result.hooks).toBeDefined();
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  test("merges existing project hooks", () => {
    // Create existing settings
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "echo stopped", timeout: 5 }],
            },
          ],
        },
        someOtherField: "preserved",
      }),
    );

    const result = JSON.parse(buildSettings(hookSocket, tempDir));

    // Stop should have 2 entries: existing + TP
    expect(result.hooks.Stop).toHaveLength(2);
    expect(result.hooks.Stop[0].hooks[0].command).toBe("echo stopped");
    expect(result.hooks.Stop[1].hooks[0].command).toContain(hookSocket);

    // Events without existing hooks should have 1 entry (TP only)
    expect(result.hooks.SessionStart).toHaveLength(1);

    // Non-hooks fields should be preserved
    expect(result.someOtherField).toBe("preserved");
  });

  test("handles missing settings file gracefully", () => {
    const result = JSON.parse(buildSettings(hookSocket, tempDir));
    expect(result.hooks.Stop).toHaveLength(1);
  });

  test("handles malformed settings file gracefully", () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), "not json{{{");

    const result = JSON.parse(buildSettings(hookSocket, tempDir));
    expect(result.hooks.Stop).toHaveLength(1);
  });

  test("works without cwd parameter (backward compatible)", () => {
    const result = JSON.parse(buildSettings(hookSocket));
    expect(result.hooks.Stop).toHaveLength(1);
  });

  test("does not spread a string when existingHooks[event] is a string (idx 10)", () => {
    // If the settings file has a string instead of an array for a hook event,
    // buildSettings must NOT spread that string char-by-char. The result must
    // be an array with exactly the TP hook entry (length 1).
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: "some-bad-string-not-an-array",
        },
      }),
    );

    const result = JSON.parse(buildSettings(hookSocket, tempDir));
    // Must be exactly 1 entry (TP hook), not 26 characters from the string.
    expect(result.hooks.Stop).toHaveLength(1);
    expect(result.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  test("handles non-object hooks field gracefully", () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ hooks: 42 }),
    );

    const result = JSON.parse(buildSettings(hookSocket, tempDir));
    expect(result.hooks.Stop).toHaveLength(1);
  });

  test("preserves unknown hook event keys (future Claude Code events)", () => {
    // A hook event key that is NOT in HOOK_EVENTS (simulating a newer Claude Code
    // event or a custom hook) must survive the settings round-trip unchanged.
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          // A known event with an existing entry.
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "echo stopped", timeout: 5 }],
            },
          ],
          // An unknown event key (not in HOOK_EVENTS) — must be preserved.
          FutureEvent: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "echo future", timeout: 5 }],
            },
          ],
          // A non-array value under an unknown key — must be silently skipped.
          BadKey: "not-an-array",
        },
      }),
    );

    const result = JSON.parse(buildSettings(hookSocket, tempDir));

    // Known event: existing entry + TP hook.
    expect(result.hooks.Stop).toHaveLength(2);

    // Unknown array key must be preserved verbatim.
    expect(result.hooks.FutureEvent).toHaveLength(1);
    expect(result.hooks.FutureEvent[0].hooks[0].command).toBe("echo future");

    // Non-array junk under unknown key must be dropped.
    expect(result.hooks.BadKey).toBeUndefined();
  });
});
