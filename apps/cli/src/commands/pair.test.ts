import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

describe("tp pair", () => {
  test("generates pairing data with QR code", () => {
    const result = capture(
      "bun run apps/cli/src/index.ts pair --relay ws://test.example --no-save",
    );
    expect(result).toContain("Generating pairing keys");
    expect(result).toContain("ws://test.example");
    expect(result).toContain('"relay":"ws://test.example"');
    expect(result).toContain('"v":1');
  });
});
