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
 * Resolve the `tp` binary path. Used by `tp daemon install` to write the
 * absolute path into the launchd plist / systemd unit, so picking the wrong
 * candidate leaves the service pointing at a stale or unrelated binary.
 *
 * Resolution order:
 *   1. `argv[0]` if it really points at an on-disk file named `tp`. Bun
 *      single-file executables sometimes report a synthetic in-memory path
 *      (`/$bunfs/root/tp`) here, so we gate on `existsSync` — synthetic paths
 *      fail and we fall through to step 2.
 *   2. First `tp` reachable via `$PATH` (walked manually — `/usr/bin/which`
 *      ignores explicit env on macOS and shell builtins inherit rc-mutated
 *      PATH, neither of which is reliable from a non-interactive child).
 *      Honoring PATH order is the closest signal to "the binary the user
 *      means when they type `tp`": a dev build at `/usr/local/bin/tp` that
 *      the user promoted ahead of `/opt/homebrew/bin/tp` wins here.
 *   3. A fixed list of well-known install destinations. Order is dev-friendly:
 *      `/usr/local/bin/tp` (locally built, manually installed) before
 *      `/opt/homebrew/bin/tp` (Homebrew tap) before `~/.local/bin/tp`
 *      (curl-pipe-sh installer). The list only matters when both `argv[0]`
 *      and `which` fail, which is rare.
 *   4. `argv[0]` as last resort, then the literal string `"tp"`.
 */
export function resolveTpBinary(): string {
  const self = process.argv[0];
  if (self && existsSync(self) && /(?:^|\/)tp$/.test(self)) return self;

  // Walk $PATH manually instead of shelling out to `which` / `command -v`:
  // - macOS `/usr/bin/which` ignores explicit env and reads the user's
  //   default PATH from /etc/paths, so test-time PATH scoping fails.
  // - Shell builtins (`command -v`) run inside the user's interactive shell
  //   (`bun`'s execSync uses /bin/sh, but the shell's rc may reset PATH).
  // A direct $PATH walk honors process.env.PATH faithfully and has no
  // external dependency.
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry) continue;
    const candidate = join(entry, "tp");
    if (existsSync(candidate)) return candidate;
  }

  const candidates = [
    "/usr/local/bin/tp",
    "/opt/homebrew/bin/tp",
    join(process.env.HOME ?? "", ".local", "bin", "tp"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return self ?? "tp";
}
