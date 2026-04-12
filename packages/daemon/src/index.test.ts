import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("daemon entry point", () => {
  test("does not accept --ws-port CLI flag", () => {
    const src = readFileSync(
      new URL("./index.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).not.toContain('"ws-port"');
    expect(src).not.toContain("startWs");
  });
});
