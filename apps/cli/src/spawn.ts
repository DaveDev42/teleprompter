import { resolveRunnerBinOverride } from "./lib/runner-bin";

/**
 * Resolves the command to spawn a Runner process.
 *
 * In compiled mode (bun build --compile), the binary itself is used:
 *   ["/path/to/tp", "run", ...]
 *
 * In dev mode (bun run), the CLI entry point is used via bun:
 *   ["bun", "run", "/path/to/apps/cli/src/index.ts", "run", ...]
 */
export function resolveRunnerCommand(): string[] {
  if (isCompiled()) {
    return [process.execPath, "run"];
  }

  // Dev mode: resolve the CLI entry relative to this file
  const cliEntry = new URL("./index.ts", import.meta.url).pathname;
  return ["bun", "run", cliEntry, "run"];
}

/**
 * Resolves the runner spawn command, honoring the opt-in `TP_RUNNER_BIN`
 * dual-run seam (ADR-0003 Stage 4, increment 3). When `TP_RUNNER_BIN` is set
 * (and valid), the Rust `tp-runner` binary is spawned directly as `[<path>]` —
 * no `run` subcommand, since `main.rs`'s argv parser takes `--sid/--cwd/...`
 * directly, with no subcommand.
 *
 * Absent the opt-in this delegates to {@link resolveRunnerCommand} unchanged, so
 * the Bun runner stays the default and behavior is byte-identical to pre-inc3.
 * An invalid override throws (see {@link resolveRunnerBinOverride}) — it never
 * silently falls back to Bun.
 */
export function resolveRunnerCommandWithOverride(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const override = resolveRunnerBinOverride(env);
  if (override) return [override];
  return resolveRunnerCommand();
}

/**
 * Returns true when tp is running as a `bun build --compile` single-file
 * executable (as opposed to `bun run` against the source checkout).
 *
 * Detection keys off Bun's virtual-filesystem marker `$bunfs` in
 * `import.meta.url`, which is baked into the bundled module and is
 * independent of filesystem layout or binary naming. CI has a dedicated
 * smoke test in `.github/workflows/ci.yml` that guards regressions here.
 */
export function isCompiled(): boolean {
  return import.meta.url.includes("$bunfs");
}
