import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export type InstallShell = "bash" | "zsh" | "fish" | "powershell";

export type InstallOptions = {
  shell: InstallShell;
  home?: string;
  force?: boolean;
  dryRun?: boolean;
  legacyPowerShell?: boolean;
};

export type InstallResult =
  | { status: "installed"; file: string }
  | { status: "already-installed"; file: string }
  | { status: "dry-run"; plan: string };

export type UninstallResult =
  | { status: "uninstalled"; file: string }
  | { status: "not-installed" };

const MARKER_START =
  "# >>> tp completions (managed by `tp completions install`) >>>";
const MARKER_END = "# <<< tp completions <<<";

function rcFilePath(shell: "bash" | "zsh", home: string): string {
  return join(home, shell === "bash" ? ".bashrc" : ".zshrc");
}

function markerBlock(line: string): string {
  return `\n${MARKER_START}\n${line}\n${MARKER_END}\n`;
}

function containsMarker(contents: string): boolean {
  return contents.includes(MARKER_START);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkerBlock(contents: string): string {
  const pattern = new RegExp(
    `\\n?${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`,
    "g",
  );
  return contents.replace(pattern, "");
}

export function installCompletion(opts: InstallOptions): InstallResult {
  const home = opts.home ?? homedir();

  if (opts.shell === "bash" || opts.shell === "zsh") {
    return installRcLine(opts.shell, home, opts);
  }

  throw new Error(`Unsupported shell: ${opts.shell}`);
}

function installRcLine(
  shell: "bash" | "zsh",
  home: string,
  opts: InstallOptions,
): InstallResult {
  const file = rcFilePath(shell, home);
  const line = `eval "$(tp completions ${shell})"`;
  const block = markerBlock(line);

  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";

  if (opts.dryRun) {
    return {
      status: "dry-run",
      plan: `Would append tp completions block to ${file}`,
    };
  }

  if (containsMarker(existing) && !opts.force) {
    return { status: "already-installed", file };
  }

  const base = containsMarker(existing) ? stripMarkerBlock(existing) : existing;
  const next =
    (base.endsWith("\n") || base === "" ? base : `${base}\n`) + block;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next, { mode: 0o644 });
  return { status: "installed", file };
}

export function uninstallCompletion(opts: InstallOptions): UninstallResult {
  const home = opts.home ?? homedir();

  if (opts.shell === "bash" || opts.shell === "zsh") {
    const file = rcFilePath(opts.shell, home);
    if (!existsSync(file)) return { status: "not-installed" };
    const existing = readFileSync(file, "utf-8");
    if (!containsMarker(existing)) return { status: "not-installed" };
    writeFileSync(file, stripMarkerBlock(existing), { mode: 0o644 });
    return { status: "uninstalled", file };
  }

  throw new Error(`Unsupported shell: ${opts.shell}`);
}
