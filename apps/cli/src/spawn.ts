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

function isCompiled(): boolean {
  // In compiled mode, import.meta.url starts with file:///$bunfs/
  // (Bun's virtual filesystem for bundled modules)
  return import.meta.url.includes("$bunfs");
}
