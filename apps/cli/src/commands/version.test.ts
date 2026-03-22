import { describe, test, expect } from "bun:test";
import { $ } from "bun";

describe("tp version", () => {
  test("prints version string", async () => {
    const result = await $`bun run apps/cli/src/index.ts version`.text();
    expect(result.trim()).toMatch(/^tp v\d+\.\d+\.\d+$/);
  });
});
