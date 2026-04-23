import { describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
      expect(result).toContain("session");
      expect(result).toContain("status");
      expect(result).toContain("logs");
      expect(result).toContain("doctor");
      expect(result).toContain("upgrade");
      expect(result).toContain("completions");
      expect(result).toContain("version");
      // session subcommands
      expect(result).toContain("list delete prune");
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

  test(
    "fish completions include session prune subcommand and flags",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions fish");
      expect(result).toContain(
        "__fish_seen_subcommand_from session' -a 'prune'",
      );
      expect(result).toContain("-l older-than");
      expect(result).toContain("-l dry-run");
    },
    TIMEOUT,
  );

  test(
    "zsh completions include session subcommands",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions zsh");
      expect(result).toContain("session subcommand");
      expect(result).toContain("'prune'");
    },
    TIMEOUT,
  );

  test(
    "powershell completions include Register-ArgumentCompleter and all subcommands",
    () => {
      const result = capture(
        "bun run apps/cli/src/index.ts completions powershell",
      );
      expect(result).toContain("Register-ArgumentCompleter");
      expect(result).toContain("-CommandName tp");
      // tp subcommands
      expect(result).toContain("'daemon'");
      expect(result).toContain("'run'");
      expect(result).toContain("'relay'");
      expect(result).toContain("'pair'");
      expect(result).toContain("'status'");
      expect(result).toContain("'logs'");
      expect(result).toContain("'doctor'");
      expect(result).toContain("'upgrade'");
      expect(result).toContain("'completions'");
      expect(result).toContain("'version'");
      // daemon subcommands
      expect(result).toContain("'start'");
      expect(result).toContain("'install'");
      expect(result).toContain("'uninstall'");
      // pair subcommands
      expect(result).toContain("'new'");
      expect(result).toContain("'delete'");
      // session subcommands
      expect(result).toContain("'session'");
      expect(result).toContain("'prune'");
    },
    TIMEOUT,
  );

  test(
    "pwsh is accepted as an alias for powershell",
    () => {
      const result = capture("bun run apps/cli/src/index.ts completions pwsh");
      expect(result).toContain("Register-ArgumentCompleter");
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "completions install writes to a tmp HOME (bash)",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        const result = capture(
          `bun run apps/cli/src/index.ts completions install bash`,
          { HOME: tmpHome, SHELL: "/bin/bash" },
        );
        expect(result).toContain("tp completions installed for bash");
        const bashrc = readFileSync(join(tmpHome, ".bashrc"), "utf-8");
        expect(bashrc).toContain('eval "$(tp completions bash)"');
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "completions install without shell arg auto-detects from $SHELL",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        capture(`bun run apps/cli/src/index.ts completions install`, {
          HOME: tmpHome,
          SHELL: "/bin/zsh",
        });
        expect(existsSync(join(tmpHome, ".zshrc"))).toBe(true);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "completions install prints error when shell cannot be detected",
    () => {
      const result = capture(
        `bun run apps/cli/src/index.ts completions install`,
        { HOME: "/tmp", SHELL: "/bin/sh" },
      );
      expect(result).toContain("Could not detect shell");
    },
    TIMEOUT,
  );

  test(
    "completions install --help prints usage, exits 0, does not install",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        const output = execSync(
          "bun run apps/cli/src/index.ts completions install --help",
          {
            env: { ...process.env, HOME: tmpHome, SHELL: "/bin/bash" },
            stdio: "pipe",
          },
        ).toString();
        expect(output).toContain("Usage: tp completions install");
        expect(existsSync(join(tmpHome, ".bashrc"))).toBe(false);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "completions install --profile-dir without value errors",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        let exitCode = 0;
        try {
          execSync(
            "bun run apps/cli/src/index.ts completions install powershell --profile-dir",
            {
              env: { ...process.env, HOME: tmpHome },
              stdio: "pipe",
            },
          );
        } catch (e: unknown) {
          exitCode = (e as { status: number }).status;
        }
        expect(exitCode).toBe(1);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "completions install --profile-dir --help errors (allowlist collision)",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        let exitCode = 0;
        try {
          execSync(
            "bun run apps/cli/src/index.ts completions install powershell --profile-dir --help",
            {
              env: { ...process.env, HOME: tmpHome },
              stdio: "pipe",
            },
          );
        } catch (e: unknown) {
          exitCode = (e as { status: number }).status;
        }
        expect(exitCode).toBe(1);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "completions install rejects unknown flags",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      try {
        const result = capture(
          `bun run apps/cli/src/index.ts completions install --oops`,
          { HOME: tmpHome, SHELL: "/bin/bash" },
        );
        expect(result).toContain("Unknown flag: --oops");
        expect(existsSync(join(tmpHome, ".bashrc"))).toBe(false);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "completions install --profile-dir overrides PowerShell profile location",
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "tp-ci-"));
      const customProfile = join(tmpHome, "custom-ps");
      try {
        capture(
          `bun run apps/cli/src/index.ts completions install powershell --profile-dir "${customProfile}"`,
          { HOME: tmpHome },
        );
        expect(existsSync(join(customProfile, "tp-completions.ps1"))).toBe(
          true,
        );
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === "win32")(
    "completions install exits non-zero when shell cannot be detected",
    () => {
      let exitCode = 0;
      try {
        execSync("bun run apps/cli/src/index.ts completions install", {
          env: { ...process.env, HOME: "/tmp", SHELL: "/bin/sh" },
          stdio: "pipe",
        });
      } catch (e: unknown) {
        exitCode = (e as { status: number }).status;
      }
      expect(exitCode).toBe(1);
    },
    TIMEOUT,
  );
});
