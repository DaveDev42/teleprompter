import { existsSync } from "fs";
import { join } from "path";

/**
 * Platform-appropriate config directory for tp state files.
 * Windows: `%APPDATA%\teleprompter` (with `%USERPROFILE%\AppData\Roaming` fallback).
 * Unix: `$XDG_CONFIG_HOME/teleprompter` or `$HOME/.config/teleprompter`.
 */
export function getConfigDir(): string {
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ??
        join(
          process.env.USERPROFILE ?? "C:\\Users\\Default",
          "AppData",
          "Roaming",
        ))
      : (process.env.XDG_CONFIG_HOME ??
        join(process.env.HOME ?? "/tmp", ".config"));
  return join(base, "teleprompter");
}

/**
 * Resolve the `tp` binary path. Returns the first candidate that exists, or
 * falls back to `process.argv[0]` (the currently-executing interpreter) when
 * no installed binary is found — useful in dev mode where the CLI runs via
 * `bun run`.
 *
 * Candidates are platform-specific: `.local/bin/tp` on Unix, `tp.exe` under
 * `%LOCALAPPDATA%\Programs\teleprompter` or `%USERPROFILE%\.local\bin` on
 * Windows.
 */
export function resolveTpBinary(): string {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.LOCALAPPDATA ?? "",
            "Programs",
            "teleprompter",
            "tp.exe",
          ),
          join(process.env.USERPROFILE ?? "", ".local", "bin", "tp.exe"),
        ]
      : [
          join(process.env.HOME ?? "", ".local", "bin", "tp"),
          "/usr/local/bin/tp",
        ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return process.argv[0] ?? "tp";
}
