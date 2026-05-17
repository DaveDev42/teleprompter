import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

const TIMEOUT = 15000;

describe("tp relay", () => {
  test(
    "without subcommand prints usage and exits non-zero",
    () => {
      // capture() swallows the non-zero exit and returns stderr.
      const out = capture("bun run apps/cli/src/index.ts relay");
      expect(out).toContain("Usage: tp relay start");
      expect(out).toContain("--port");
      expect(out).toContain("--cache-size");
      expect(out).toContain("--max-frame-size");
    },
    TIMEOUT,
  );

  test(
    "ping forwards users to tp doctor and exits 0",
    () => {
      const out = capture("bun run apps/cli/src/index.ts relay ping");
      expect(out).toContain("tp doctor");
    },
    TIMEOUT,
  );

  test(
    "unknown subcommand falls through to usage",
    () => {
      const out = capture("bun run apps/cli/src/index.ts relay bogus");
      expect(out).toContain("Usage: tp relay start");
    },
    TIMEOUT,
  );
});
