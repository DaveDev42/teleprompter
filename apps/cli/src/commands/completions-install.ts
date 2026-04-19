import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
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
  /**
   * Override the PowerShell profile directory. If unset, derived from
   * `home`. On Windows with OneDrive redirection the correct path is
   * `%OneDrive%\Documents\PowerShell` — callers that have access to
   * `$PROFILE` (e.g. install.ps1) should pass it in.
   */
  powerShellProfileDir?: string;
};

export type InstallResult =
  | { status: "installed"; file: string }
  | { status: "already-installed"; file: string }
  | { status: "dry-run"; plan: string };

export type UninstallResult =
  | { status: "uninstalled"; file: string }
  | { status: "not-installed" }
  | { status: "dry-run"; plan: string };

function preservedMode(file: string): number {
  if (!existsSync(file)) return 0o644;
  // File exists but stat fails — surface the error instead of silently using 0644.
  return statSync(file).mode & 0o777;
}

function atomicWrite(file: string, contents: string, mode?: number): void {
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${file}.tp-tmp-${suffix}`;
  let fd: number | null = null;
  try {
    // Exclusive create (O_CREAT|O_EXCL) defeats symlink pre-creation attacks.
    fd = openSync(tmp, "wx", mode ?? 0o644);
    writeSync(fd, contents);
    if (mode !== undefined) fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

export const MARKER_START =
  "# >>> tp completions (managed by `tp completions install`) >>>";
export const MARKER_END = "# <<< tp completions <<<";

function powershellDir(home: string, legacy: boolean, override?: string): string {
  if (override) return override;
  return join(home, "Documents", legacy ? "WindowsPowerShell" : "PowerShell");
}

export function powershellScriptPath(home: string, legacy: boolean, override?: string): string {
  return join(powershellDir(home, legacy, override), "tp-completions.ps1");
}

export function powershellProfilePath(home: string, legacy: boolean, override?: string): string {
  return join(powershellDir(home, legacy, override), "Profile.ps1");
}

export function rcFilePath(shell: "bash" | "zsh", home: string): string {
  return join(home, shell === "bash" ? ".bashrc" : ".zshrc");
}

export function fishFilePath(home: string): string {
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
    const psDir = opts.powerShellProfileDir;
    const scriptFile = powershellScriptPath(home, legacy, psDir);
    const profileFile = powershellProfilePath(home, legacy, psDir);
    const dotSource = `. "${scriptFile}"`;

    // NOTE: concurrent external edits to Profile.ps1 between this read and the
    // atomic write below are not preserved. Real-world risk is low (rc files
    // are rarely edited during install), but worth noting.
    const existingProfile = existsSync(profileFile)
      ? readFileSync(profileFile, "utf-8")
      : "";
    const scriptExists = existsSync(scriptFile);
    const profileHasMarker = containsMarker(existingProfile);
    const isFullyInstalled = scriptExists && profileHasMarker;

    if (opts.dryRun) {
      let action: string;
      if (isFullyInstalled && !opts.force) {
        action = `Would skip (already installed)`;
      } else if (isFullyInstalled && opts.force) {
        action = `Would rewrite tp completions in ${scriptFile} and ${profileFile}`;
      } else {
        action = `Would write ${scriptFile} and append dot-source to ${profileFile}`;
      }
      return { status: "dry-run", plan: action };
    }

    if (isFullyInstalled && !opts.force) {
      return { status: "already-installed", file: scriptFile };
    }

    mkdirSync(powershellDir(home, legacy, psDir), { recursive: true });
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

  const _exhaustive: never = opts.shell;
  throw new Error(`Unsupported shell: ${String(_exhaustive)}`);
}

function installRcLine(
  shell: "bash" | "zsh",
  home: string,
  opts: InstallOptions,
): InstallResult {
  const file = rcFilePath(shell, home);
  const line = `eval "$(tp completions ${shell})"`;
  const block = markerBlock(line);

  // NOTE: concurrent external edits to the rc file between this read and
  // the atomic write below are not preserved. Real-world risk is low (rc
  // files are rarely edited during install).
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
    if (opts.dryRun) {
      return {
        status: "dry-run",
        plan: `Would remove tp completions block from ${file}`,
      };
    }
    atomicWrite(file, stripMarkerBlock(existing), preservedMode(file));
    return { status: "uninstalled", file };
  }
  if (opts.shell === "fish") {
    const file = fishFilePath(home);
    if (!existsSync(file)) return { status: "not-installed" };
    if (opts.dryRun) {
      return { status: "dry-run", plan: `Would remove ${file}` };
    }
    rmSync(file);
    return { status: "uninstalled", file };
  }

  if (opts.shell === "powershell") {
    const legacy = !!opts.legacyPowerShell;
    const psDir = opts.powerShellProfileDir;
    const scriptFile = powershellScriptPath(home, legacy, psDir);
    const profileFile = powershellProfilePath(home, legacy, psDir);

    const scriptExists = existsSync(scriptFile);
    const profileHasMarker =
      existsSync(profileFile) &&
      containsMarker(readFileSync(profileFile, "utf-8"));

    if (!scriptExists && !profileHasMarker) {
      return { status: "not-installed" };
    }

    if (opts.dryRun) {
      const parts: string[] = [];
      if (scriptExists) parts.push(`Would remove ${scriptFile}`);
      if (profileHasMarker) parts.push(`Would remove tp completions block from ${profileFile}`);
      return { status: "dry-run", plan: parts.join("; ") };
    }

    if (scriptExists) rmSync(scriptFile);
    if (profileHasMarker) {
      const next = stripMarkerBlock(readFileSync(profileFile, "utf-8"));
      atomicWrite(profileFile, next, preservedMode(profileFile));
    }
    return { status: "uninstalled", file: scriptFile };
  }

  const _exhaustive: never = opts.shell;
  throw new Error(`Unsupported shell: ${String(_exhaustive)}`);
}
