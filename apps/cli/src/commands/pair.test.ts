import { describe, test, expect } from "bun:test";
import { $ } from "bun";

describe("tp pair", () => {
  test("generates pairing data with QR code", async () => {
    const result = await $`bun run apps/cli/src/index.ts pair --relay ws://test.example --no-save`
      .text()
      .catch((e) => e.stdout?.toString() ?? "");
    expect(result).toContain("Generating pairing data");
    expect(result).toContain("ws://test.example");
    expect(result).toContain('"relay":"ws://test.example"');
    expect(result).toContain('"v":1');
  });
});
