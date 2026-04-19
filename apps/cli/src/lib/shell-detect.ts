export type Shell = "bash" | "zsh" | "fish" | "powershell";

const POSIX_SHELLS: Shell[] = ["bash", "zsh", "fish"];

export function detectShell(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Shell | null {
  if (platform === "win32") {
    return env.PSModulePath ? "powershell" : null;
  }

  const shellPath = env.SHELL;
  if (!shellPath) return null;

  const base = shellPath.split("/").pop() ?? "";
  return (POSIX_SHELLS as string[]).includes(base) ? (base as Shell) : null;
}
