export type Shell = "bash" | "zsh" | "fish";

function isPosixShell(base: string): base is "bash" | "zsh" | "fish" {
  return base === "bash" || base === "zsh" || base === "fish";
}

export function detectShell(
  env: Record<string, string | undefined>,
  _platform: NodeJS.Platform,
): Shell | null {
  const shellPath = env.SHELL;
  if (shellPath) {
    const base = shellPath.split("/").pop() ?? "";
    if (isPosixShell(base)) return base;
  }

  // Secondary signal when $SHELL is unset/odd — the shell itself sets these.
  if (env.ZSH_VERSION) return "zsh";
  if (env.BASH_VERSION) return "bash";
  if (env.FISH_VERSION) return "fish";

  return null;
}
