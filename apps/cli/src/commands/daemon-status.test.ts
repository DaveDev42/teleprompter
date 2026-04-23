import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

// End-to-end smoke — run the compiled subcommand and check the output shape.
// Service install/uninstall is platform-specific and heavy; we verify the
// render path in both states. The `tp daemon install` hint is only expected
// when the service is not installed; a developer machine with an installed
// daemon should still pass.
const TIMEOUT = 15000;

describe("tp daemon status", () => {
  test(
    "prints service banner with all fields (install hint only when not installed)",
    () => {
      const result = capture("bun run apps/cli/src/index.ts daemon status");
      expect(result).toContain("Daemon Service");
      expect(result).toContain("Service:");
      expect(result).toContain("Process:");
      expect(result).toContain("Socket:");
      expect(result).toContain("Binary:");
      expect(result).toContain("Config:");
      expect(result).toContain("Logs:");
      // Service-not-registered banner + install hint only appear when the
      // service is not installed. A developer machine that already has
      // `tp daemon install` run against it reaches the `installed` branch
      // instead, so the hint is absent — still a valid render.
      if (result.includes("Service is not registered.")) {
        expect(result).toContain("tp daemon install");
      }
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
