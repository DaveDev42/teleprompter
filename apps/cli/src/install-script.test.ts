import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

describe("install.sh completion opt-out", () => {
  test("NO_COMPLETIONS=1 skips completion install", () => {
    // Static check of install.sh contents since full execution
    // requires network + real binary.
    const script = readFileSync("scripts/install.sh", "utf-8");
    expect(script).toContain("NO_COMPLETIONS");
    expect(script).toContain("TP_AUTO_COMPLETIONS");
    expect(script).toContain("-t 0");
  });
});
