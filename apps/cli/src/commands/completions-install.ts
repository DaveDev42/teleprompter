import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { renderCompletion } from "./completions";

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

function powershellDir(home: string, legacy: boolean): string {
  return join(home, "Documents", legacy ? "WindowsPowerShell" : "PowerShell");
}

function powershellScriptPath(home: string, legacy: boolean): string {
  return join(powershellDir(home, legacy), "tp-completions.ps1");
}

function powershellProfilePath(home: string, legacy: boolean): string {
  return join(powershellDir(home, legacy), "Profile.ps1");
}

function rcFilePath(shell: "bash" | "zsh", home: string): string {
  return join(home, shell === "bash" ? ".bashrc" : ".zshrc");
}

function fishFilePath(home: string): string {
  return join(home, ".config", "fish", "completions", "tp.fish");
}

function installManagedFile(
  file: string,
  contents: string,
  opts: InstallOptions,
): InstallResult {
  if (opts.dryRun) {
    return { status: "dry-run", plan: `Would write ${file}` };
  }
  if (existsSync(file) && !opts.force) {
    return { status: "already-installed", file };
  }
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, `${contents}\n`, 0o644);
  return { status: "installed", file };
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
  if (opts.shell === "fish") {
    return installManagedFile(
      fishFilePath(home),
      renderCompletion("fish"),
      opts,
    );
  }

  if (opts.shell === "powershell") {
    const legacy = !!opts.legacyPowerShell;
    const scriptFile = powershellScriptPath(home, legacy);
    const profileFile = powershellProfilePath(home, legacy);
    const dotSource = `. "${scriptFile}"`;

    if (opts.dryRun) {
      return {
        status: "dry-run",
        plan: `Would write ${scriptFile} and append dot-source to ${profileFile}`,
      };
    }

    const existingProfile = existsSync(profileFile)
      ? readFileSync(profileFile, "utf-8")
      : "";

    if (
      existsSync(scriptFile) &&
      containsMarker(existingProfile) &&
      !opts.force
    ) {
      return { status: "already-installed", file: scriptFile };
    }

    mkdirSync(powershellDir(home, legacy), { recursive: true });
    atomicWrite(scriptFile, `${renderCompletion("powershell")}\n`, 0o644);

    const baseProfile = containsMarker(existingProfile)
      ? stripMarkerBlock(existingProfile)
      : existingProfile;
    const nextProfile =
      (baseProfile.endsWith("\n") || baseProfile === ""
        ? baseProfile
        : `${baseProfile}\n`) + markerBlock(dotSource);
    atomicWrite(profileFile, nextProfile, preservedMode(profileFile));

    return { status: "installed", file: scriptFile };
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
  if (opts.shell === "fish") {
    const file = fishFilePath(home);
    if (!existsSync(file)) return { status: "not-installed" };
    rmSync(file);
    return { status: "uninstalled", file };
  }

  if (opts.shell === "powershell") {
    const legacy = !!opts.legacyPowerShell;
    const scriptFile = powershellScriptPath(home, legacy);
    const profileFile = powershellProfilePath(home, legacy);

    const scriptExists = existsSync(scriptFile);
    const profileHasMarker =
      existsSync(profileFile) &&
      containsMarker(readFileSync(profileFile, "utf-8"));

    if (!scriptExists && !profileHasMarker) {
      return { status: "not-installed" };
    }

    if (scriptExists) rmSync(scriptFile);
    if (profileHasMarker) {
      const next = stripMarkerBlock(readFileSync(profileFile, "utf-8"));
      atomicWrite(profileFile, next, preservedMode(profileFile));
    }
    return { status: "uninstalled", file: scriptFile };
  }

  throw new Error(`Unsupported shell: ${opts.shell}`);
}
