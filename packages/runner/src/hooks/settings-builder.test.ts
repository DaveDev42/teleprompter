import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
});
