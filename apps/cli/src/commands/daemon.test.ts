import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("daemon.ts imports", () => {
  test("does not import loadPairingData", () => {
    const src = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
    expect(src).not.toMatch(/loadPairingData/);
    expect(src).not.toMatch(/pairing\.json/);
  });
});
