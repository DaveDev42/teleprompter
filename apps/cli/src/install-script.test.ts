import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { readFileSync } from "fs";

describe.skipIf(process.platform === "win32")(
  "install.sh completion opt-out",
  () => {
    test("script is valid bash", () => {
      // Throws on syntax errors
      execSync("bash -n scripts/install.sh", { stdio: "pipe" });
    });

    test("opt-out knobs and TTY gate present", () => {
      const script = readFileSync("scripts/install.sh", "utf-8");
      expect(script).toContain("NO_COMPLETIONS");
      expect(script).toContain("TP_AUTO_COMPLETIONS");
      expect(script).toMatch(/\[\s*!\s*-t\s+0\s*\]/);
      expect(script).toContain("--no-completions");
    });

    test("PATH gate present", () => {
      const script = readFileSync("scripts/install.sh", "utf-8");
      expect(script).toContain("ON_PATH");
      expect(script).toContain("not on PATH");
    });
  },
);
