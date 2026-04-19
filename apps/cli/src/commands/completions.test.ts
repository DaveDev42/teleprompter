import { describe, expect, test } from "bun:test";
import { capture } from "../test-util";

// Windows can exceed the 5s default when bun startup imports heavy deps.
const TIMEOUT = 15000;

describe("tp completions", () => {
  test(
    "bash completions include all subcommands",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions bash");
      // Legacy WS flags must not appear (relay-only architecture)
      expect(result).not.toContain("--ws-port");
      expect(result).not.toContain("--web-dir");
      // tp subcommands
      expect(result).toContain("run");
      expect(result).toContain("daemon");
      expect(result).toContain("relay");
      expect(result).toContain("pair");
      expect(result).toContain("status");
      expect(result).toContain("logs");
      expect(result).toContain("doctor");
      expect(result).toContain("upgrade");
      expect(result).toContain("completions");
      expect(result).toContain("version");
      // claude utility subcommands
      expect(result).toContain("auth");
      expect(result).toContain("mcp");
      expect(result).toContain("install");
      expect(result).toContain("update");
      expect(result).toContain("agents");
      expect(result).toContain("auto-mode");
      expect(result).toContain("plugin");
      expect(result).toContain("setup-token");
    },
    TIMEOUT,
  );

  test(
    "zsh completions include run subcommand",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions zsh");
      expect(result).toContain("'run:run command'");
    },
    TIMEOUT,
  );

  test(
    "fish completions include run subcommand",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions fish");
      expect(result).toContain("-a 'run'");
    },
    TIMEOUT,
  );

  test(
    "bash completions include daemon subcommands including status",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions bash");
      expect(result).toContain("start status install uninstall");
    },
    TIMEOUT,
  );

  test(
    "fish completions include daemon status subcommand",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions fish");
      expect(result).toContain(
        "__fish_seen_subcommand_from daemon' -a 'status'",
      );
    },
    TIMEOUT,
  );
});
