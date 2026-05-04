import { existsSync } from "fs";
import { join } from "path";

/**
 * Platform-appropriate config directory for tp state files.
 * `$XDG_CONFIG_HOME/teleprompter` or `$HOME/.config/teleprompter`.
 */
export function getConfigDir(): string {
  const base =
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/tmp", ".config");
  return join(base, "teleprompter");
}

/**
 * Resolve the `tp` binary path. Returns the first candidate that exists, or
 * falls back to `process.argv[0]` (the currently-executing interpreter) when
 * no installed binary is found — useful in dev mode where the CLI runs via
 * `bun run`.
 */
export function resolveTpBinary(): string {
  const candidates = [
    join(process.env.HOME ?? "", ".local", "bin", "tp"),
    "/usr/local/bin/tp",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return process.argv[0] ?? "tp";
}
