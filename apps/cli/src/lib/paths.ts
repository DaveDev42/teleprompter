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
 *
 * Order matters for `tp daemon install`: launchd / systemd records the absolute
 * path of whichever binary we hand back, so we must point to the *currently
 * running* interpreter first. Otherwise a brew user with both
 * `/opt/homebrew/bin/tp` (the freshly-installed 0.1.x) and `~/.local/bin/tp`
 * (a stale local build from a previous install.sh run) ends up registering the
 * stale one — exactly the bug observed during 2026-05-11 QA.
 */
export function resolveTpBinary(): string {
  // Prefer the binary that is actually running this process. `argv[0]` is the
  // resolved real path (Bun does not symlink-redirect it), so this picks brew,
  // ~/.local, or the dev `bun run` entry without guessing.
  const self = process.argv[0];
  if (self && existsSync(self) && /(?:^|\/)tp$/.test(self)) return self;

  // Fallbacks for the install-flow where argv[0] points at `bun` (dev mode):
  // walk the well-known install destinations in install-time order.
  const candidates = [
    "/opt/homebrew/bin/tp",
    join(process.env.HOME ?? "", ".local", "bin", "tp"),
    "/usr/local/bin/tp",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return self ?? "tp";
}
