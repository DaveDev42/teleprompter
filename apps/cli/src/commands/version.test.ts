import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

describe("tp version", () => {
  test("prints tp version on the first line", () => {
    const result = capture("bun run apps/cli/src/index.ts version");
    const firstLine = result.split("\n")[0]?.trim() ?? "";
    expect(firstLine).toMatch(/^tp v\d+\.\d+\.\d+$/);
  });

  test("includes a claude line (or a 'not found' fallback)", () => {
    const result = capture("bun run apps/cli/src/index.ts version");
    // Either we found claude on PATH and printed its version, or we printed
    // the "claude: not found on PATH" fallback. Either way, the second line
    // mentions claude.
    expect(result).toMatch(/claude/);
  });
});
