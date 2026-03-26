import { describe, test, expect } from "bun:test";
import { capture } from "../test-util";

describe("tp version", () => {
  test("prints version string", () => {
    const result = capture("bun run apps/cli/src/index.ts version");
    expect(result.trim()).toMatch(/^tp v\d+\.\d+\.\d+$/);
  });
});
