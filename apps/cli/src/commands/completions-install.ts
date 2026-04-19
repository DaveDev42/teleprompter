import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
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

function preservedMode(file: string): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return 0o644;
  }
}

function atomicWrite(file: string, contents: string, mode?: number): void {
  const tmp = `${file}.tp-tmp-${process.pid}`;
  writeFileSync(tmp, contents, mode !== undefined ? { mode } : {});
  // `renameSync` is atomic on the same filesystem.
  renameSync(tmp, file);
}

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
  const hasMarker = containsMarker(existing);

  if (opts.dryRun) {
    const action =
      hasMarker && !opts.force
        ? "Would skip (already installed)"
        : hasMarker && opts.force
          ? "Would rewrite tp completions block in"
          : "Would append tp completions block to";
    return { status: "dry-run", plan: `${action} ${file}` };
  }

  if (hasMarker && !opts.force) {
    return { status: "already-installed", file };
  }

  const base = hasMarker ? stripMarkerBlock(existing) : existing;
  const next =
    (base.endsWith("\n") || base === "" ? base : `${base}\n`) + block;

  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, next, preservedMode(file));
  return { status: "installed", file };
}

export function uninstallCompletion(opts: InstallOptions): UninstallResult {
  const home = opts.home ?? homedir();

  if (opts.shell === "bash" || opts.shell === "zsh") {
    const file = rcFilePath(opts.shell, home);
    if (!existsSync(file)) return { status: "not-installed" };
    const existing = readFileSync(file, "utf-8");
    if (!containsMarker(existing)) return { status: "not-installed" };
    atomicWrite(file, stripMarkerBlock(existing), preservedMode(file));
    return { status: "uninstalled", file };
  }

  throw new Error(`Unsupported shell: ${opts.shell}`);
}
