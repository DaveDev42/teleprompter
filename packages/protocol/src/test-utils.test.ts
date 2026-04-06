import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rmRetry } from "./test-utils";

describe("rmRetry", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tp-rm-retry-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("removes a directory", async () => {
    writeFileSync(join(testDir, "file.txt"), "hello");
    await rmRetry(testDir);
    expect(existsSync(testDir)).toBe(false);
  });

  test("succeeds on non-existent directory", async () => {
    const nonExistent = join(tmpdir(), `tp-rm-retry-nonexistent-${Date.now()}`);
    await rmRetry(nonExistent);
  });
});
