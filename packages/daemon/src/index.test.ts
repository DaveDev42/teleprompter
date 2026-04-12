import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

describe("daemon entry point", () => {
  test("does not accept --ws-port CLI flag", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).not.toContain('"ws-port"');
    expect(src).not.toContain("startWs");
  });
});
