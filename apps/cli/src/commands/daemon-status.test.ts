import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

// End-to-end smoke — run the compiled subcommand and check the output shape.
// Service install/uninstall is platform-specific and heavy; we only verify the
// render path by running with no service installed (the default CI state) and
// asserting the banner + hint are present.
const TIMEOUT = 15000;

describe("tp daemon status", () => {
  test(
    "prints service banner and hint when nothing is installed",
    () => {
      const result = capture("bun run apps/cli/src/index.ts daemon status");
      expect(result).toContain("Daemon Service");
      expect(result).toContain("Service:");
      expect(result).toContain("Process:");
      expect(result).toContain("Socket:");
      expect(result).toContain("Binary:");
      expect(result).toContain("Config:");
      expect(result).toContain("Logs:");
      // CI has no daemon installed, so the install hint should appear.
      expect(result).toContain("tp daemon install");
    },
    TIMEOUT,
  );

  test(
    "daemon without subcommand lists status in usage",
    () => {
      // Exits 1 — capture() swallows the non-zero exit and returns stderr.
      const result = capture("bun run apps/cli/src/index.ts daemon");
      expect(result).toContain("status");
      expect(result).toContain("install");
      expect(result).toContain("uninstall");
    },
    TIMEOUT,
  );
});
