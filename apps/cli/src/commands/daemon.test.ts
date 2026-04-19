import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("daemon.ts imports", () => {
  test("does not import loadPairingData", () => {
    const src = readFileSync("apps/cli/src/commands/daemon.ts", "utf8");
    expect(src).not.toMatch(/loadPairingData/);
    expect(src).not.toMatch(/pairing\.json/);
  });
});
