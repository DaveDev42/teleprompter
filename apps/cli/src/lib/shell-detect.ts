export type Shell = "bash" | "zsh" | "fish" | "powershell";

const POSIX_SHELLS: ReadonlySet<Shell> = new Set<Shell>(["bash", "zsh", "fish"]);

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
  if (shellPath) {
    const base = shellPath.split("/").pop() ?? "";
    if ((POSIX_SHELLS as ReadonlySet<string>).has(base)) return base as Shell;
  }

  // Secondary signal when $SHELL is unset/odd — the shell itself sets these.
  if (env.ZSH_VERSION) return "zsh";
  if (env.BASH_VERSION) return "bash";
  if (env.FISH_VERSION) return "fish";

  return null;
}
