export type Shell = "bash" | "zsh" | "fish" | "powershell";

const POSIX_SHELLS = new Set<string>(["bash", "zsh", "fish"]);

export function detectShell(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Shell | null {
  // On Windows, PSModulePath is set by both pwsh 7+ and legacy Windows
  // PowerShell 5.1. Both support Register-ArgumentCompleter, so we treat
  // them uniformly. Users on WinPS 5.1 pass --legacy-powershell to target
  // the Documents\WindowsPowerShell\ profile path.
  if (platform === "win32") {
    return env.PSModulePath ? "powershell" : null;
  }

  const shellPath = env.SHELL;
  if (!shellPath) return null;

  const base = shellPath.split("/").pop() ?? "";
  return POSIX_SHELLS.has(base) ? (base as Shell) : null;
}
