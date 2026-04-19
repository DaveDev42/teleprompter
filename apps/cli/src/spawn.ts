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
