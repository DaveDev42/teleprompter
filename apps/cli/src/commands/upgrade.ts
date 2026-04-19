import { $ } from "bun";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { ok, warn } from "../lib/colors";
import { errorWithHints } from "../lib/format";
import { spinner } from "../lib/spinner";

const REPO = "DaveDev42/teleprompter";

/**
 * tp upgrade — upgrade tp binary and optionally claude code.
 *
 * With --claude flag, runs `claude update` directly and skips tp upgrade.
 */
export async function upgradeCommand(argv: string[] = []): Promise<void> {
  if (argv.includes("--claude")) {
    const proc = Bun.spawn(["claude", "update"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    process.exit(exitCode);
  }

  console.log("Teleprompter Upgrade\n");

  // 1. Check current version
  const currentVersion = getCurrentVersion();
  console.log(`Current: tp v${currentVersion}`);

  // 2. Check latest release
  const stop = spinner("Checking for updates...");
  const latest = await getLatestRelease();
  if (!latest) {
    stop();
    console.error(
      errorWithHints("Failed to check for updates.", [
        "Check your network connection",
        `Manual: gh release view --repo ${REPO}`,
      ]),
    );
    return;
  }
  stop();

  console.log(`Latest:  tp ${latest.tag}`);

  if (latest.tag === `v${currentVersion}`) {
    console.log(`\n${ok("tp is already up to date!")}`);
  } else {
    console.log(`\nUpgrading tp ${currentVersion} → ${latest.tag}...`);
    await upgradeTp(latest.tag);
  }

  // 3. Upgrade claude code
  const stopClaude = spinner("Checking Claude Code...");
  try {
    await $`claude update`.quiet();
    stopClaude(ok("Claude Code is up to date."));
  } catch {
    stopClaude(
      warn("Claude Code update skipped (run 'claude update' manually)."),
    );
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;

function getCachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  let base: string;
  if (xdg && xdg.length > 0) {
    base = xdg;
  } else if (process.platform === "win32") {
    base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  } else {
    base = join(homedir(), ".cache");
  }
  return join(base, "teleprompter", "upgrade-check.json");
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  /** true when the tag has a -prerelease suffix (e.g. `0.1.5-rc.1`). */
  prerelease: boolean;
};

/**
 * Parse a semver-ish tag ("v0.1.5" or "0.1.5-rc.1") into numeric parts.
 * Returns null for unparseable input.
 */
export function parseVersion(v: string): ParsedVersion | null {
  const trimmed = v.trim().replace(/^v/, "");
  const m = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] != null,
  };
}

/**
 * Returns true iff `a` < `b`. Unparseable input → false (treat as up-to-date).
 *
 * Numeric triple is compared in full. For same-numbered triples we apply only
 * the stable-vs-prerelease rule (`0.1.5-rc.1 < 0.1.5`); prereleases are not
 * compared to each other. The upgrade notice only nudges users toward stable
 * releases, so distinguishing rc.1 from rc.2 is intentionally out of scope.
 */
export function isOlderVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] < pb[k]) return true;
    if (pa[k] > pb[k]) return false;
  }
  return pa.prerelease && !pb.prerelease;
}

/**
 * Check if a newer version is available. Called on tp startup.
 * Returns the new version tag if available, null otherwise.
 *
 * - Suppressed entirely when `TP_NO_UPDATE_CHECK=1`.
 * - Rate-limited via `~/.cache/teleprompter/upgrade-check.json` — at most one
 *   network check per 24h.
 * - Only announces when the installed version is strictly older than latest
 *   (previous `!==` comparison also fired for dev/source builds whose
 *   package.json version equals latest).
 */
export async function checkForUpdates(
  opts: { cachePath?: string; now?: number } = {},
): Promise<string | null> {
  if (process.env.TP_NO_UPDATE_CHECK === "1") return null;

  const cachePath = opts.cachePath ?? getCachePath();
  const now = opts.now ?? Date.now();

  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as {
      version?: number;
      lastCheck?: number;
    };
    // Unknown/missing schema version → treat as cache miss so format migrations
    // don't get stuck reading old shapes. A fresh hit short-circuits *without*
    // rewriting the cache so the 24h window is fixed, not sliding.
    if (
      cached.version === CACHE_SCHEMA_VERSION &&
      typeof cached.lastCheck === "number" &&
      now - cached.lastCheck < UPDATE_CHECK_INTERVAL_MS
    ) {
      return null;
    }
  } catch {
    // No cache, unreadable, or malformed — fall through and re-check.
  }

  // Record the attempt *before* the network call so transient GitHub failures
  // still rate-limit subsequent invocations to the 24h window.
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ version: CACHE_SCHEMA_VERSION, lastCheck: now }),
    );
  } catch {
    // cache is best-effort
  }

  try {
    const current = getCurrentVersion();
    const latest = await getLatestRelease();

    if (latest && isOlderVersion(current, latest.tag)) {
      return latest.tag;
    }
  } catch {
    // Silently fail — don't block startup
  }
  return null;
}

function getCurrentVersion(): string {
  try {
    const pkg = require("../../package.json");
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

async function getLatestRelease(): Promise<{
  tag: string;
  url: string;
} | null> {
  try {
    // Try gh CLI first (works with private repos)
    const result = await $`gh release view --repo ${REPO} --json tagName,url`
      .text()
      .catch(() => "");
    if (result) {
      const data = JSON.parse(result);
      return { tag: data.tagName, url: data.url };
    }
  } catch {}

  try {
    // Fallback to public API
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name: string; html_url: string };
    return { tag: data.tag_name, url: data.html_url };
  } catch {
    return null;
  }
}

/** Build the asset name for the current platform. */
export function getAssetName(): string {
  let os: string;
  if (process.platform === "darwin") os = "darwin";
  else if (process.platform === "win32") os = "windows";
  else os = "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const suffix = process.platform === "win32" ? ".exe" : "";
  return `tp-${os}_${arch}${suffix}`;
}

/** Resolve the path to the currently running tp binary. */
export async function resolveCurrentBinaryPath(): Promise<string> {
  if (process.execPath && !process.execPath.includes("bun")) {
    return process.execPath;
  }
  const cmd = process.platform === "win32" ? "where" : "which";
  const found = (await $`${cmd} tp`.text().catch(() => "")).trim();
  return found ? found.split(/\r?\n/)[0] : "";
}

/**
 * Download checksums.txt from a release and return map of filename→sha256.
 * Returns null if checksums.txt is unavailable (older releases).
 */
export async function downloadChecksums(
  tag: string,
): Promise<Map<string, string> | null> {
  const url = `https://github.com/${REPO}/releases/download/${tag}/checksums.txt`;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseChecksums(text);
  } catch {
    return null;
  }
}

/** Parse checksums.txt (sha256sum format: "hash  filename\n") into a Map. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.trim().split(/\r?\n/)) {
    // sha256sum format: "<hash>  <filename>" (two spaces)
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    if (match) {
      map.set(match[2], match[1]);
    }
  }
  return map;
}

/** Compute SHA-256 hex digest of a file. */
export async function computeFileHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await file.arrayBuffer());
  return hasher.digest("hex");
}

/** Back up existing binary to .bak in the same directory. */
export function backupBinary(binaryPath: string): string {
  const bakPath = `${binaryPath}.bak`;
  if (!existsSync(binaryPath)) {
    throw new Error(`Binary not found at ${binaryPath}`);
  }
  copyFileSync(binaryPath, bakPath);
  return bakPath;
}

/** Restore binary from .bak backup. Throws if restore fails so caller can
 * avoid reporting a successful rollback when the backup is still in place. */
export function restoreBinary(binaryPath: string, bakPath: string): void {
  try {
    renameSync(bakPath, binaryPath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      copyFileSync(bakPath, binaryPath);
      unlinkSync(bakPath);
      return;
    }
    console.error(
      `Failed to restore backup: ${err.message}. Manual restore: move ${bakPath} to ${binaryPath}`,
    );
    throw err;
  }
}

/** Clean up .bak backup after successful upgrade. */
export function cleanupBackup(bakPath: string): void {
  try {
    unlinkSync(bakPath);
  } catch {
    // Ignore — non-critical
  }
}

export type VerificationResult =
  | { ok: true; version: string }
  | { ok: false; reason: string };

/**
 * Run `<binary> version` and confirm it produced a plausible tp version banner.
 * Fails loudly on signal kills (SIGKILL/SIGTERM — common when macOS Gatekeeper
 * rejects unsigned downloads) instead of silently returning empty output.
 */
export async function verifyNewBinary(
  binaryPath: string,
): Promise<VerificationResult> {
  const proc = Bun.spawn([binaryPath, "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const signal = proc.signalCode;

  if (exitCode !== 0) {
    if (signal) {
      return {
        ok: false,
        reason:
          `binary killed by signal ${signal} (exit ${exitCode}). ` +
          `On macOS this usually means the download was rejected by Gatekeeper ` +
          `because the binary is unsigned. Re-run with a signed release.`,
      };
    }
    const err = stderr.trim() || stdout.trim() || "no output";
    return {
      ok: false,
      reason: `exit ${exitCode}: ${err}`,
    };
  }

  const out = stdout.trim();
  if (!out) {
    return { ok: false, reason: "no output on stdout" };
  }
  if (!/^tp v\d/.test(out)) {
    return { ok: false, reason: `unexpected output: ${out}` };
  }
  return { ok: true, version: out };
}

/** Restart daemon service after binary upgrade. */
export async function restartDaemon(): Promise<void> {
  if (process.platform === "darwin") {
    const { isServiceInstalled, getServiceLabel } = await import(
      "../lib/service-darwin"
    );
    if (isServiceInstalled()) {
      const uid = process.getuid?.() ?? 501;
      const label = getServiceLabel();
      const result = Bun.spawnSync([
        "launchctl",
        "kickstart",
        "-k",
        `gui/${uid}/${label}`,
      ]);
      if (result.exitCode === 0) {
        console.log(ok("Daemon restarted via launchd."));
      } else {
        console.log(
          warn(
            `Daemon restart failed (launchctl exit ${result.exitCode}). Restart manually: tp daemon start`,
          ),
        );
      }
      return;
    }
  } else if (process.platform === "win32") {
    const { isServiceInstalled, getTaskName } = await import(
      "../lib/service-windows"
    );
    if (isServiceInstalled()) {
      const name = getTaskName();
      // /End may fail if task isn't running — that's OK
      Bun.spawnSync(["schtasks", "/End", "/TN", name]);
      const runResult = Bun.spawnSync(["schtasks", "/Run", "/TN", name]);
      // schtasks /Run returns 1 when the task is already running (SCHED_E_TASK_ATTEMPTED_TO_RUN_WITHOUT_INSTANCES).
      // Treat exit 0 and 1 both as success for the purposes of restart messaging.
      if (runResult.exitCode === 0 || runResult.exitCode === 1) {
        console.log(ok(`Daemon restarted via Task Scheduler (${name}).`));
      } else {
        console.log(
          warn(
            `Daemon restart failed (schtasks exit ${runResult.exitCode}). Restart manually: tp daemon start`,
          ),
        );
      }
      return;
    }
  } else {
    // Linux
    const { isServiceInstalled, getServiceName } = await import(
      "../lib/service-linux"
    );
    if (isServiceInstalled()) {
      const name = getServiceName();
      const result = Bun.spawnSync(["systemctl", "--user", "restart", name]);
      if (result.exitCode === 0) {
        console.log(ok("Daemon restarted via systemd."));
      } else {
        console.log(
          warn(
            `Daemon restart failed (systemctl exit ${result.exitCode}). Restart manually: tp daemon start`,
          ),
        );
      }
      return;
    }
  }

  // No service installed — check for running daemon process
  if (process.platform === "win32") {
    // pgrep is not available on Windows; skip process check
    return;
  }
  try {
    const pidResult = await $`pgrep -x "tp"`.text().catch(() => "");
    if (pidResult.trim()) {
      console.log(
        warn(
          "Daemon is running but not managed by a system service. Restart it manually: tp daemon start",
        ),
      );
    }
  } catch {
    // No daemon running — nothing to do
  }
}

async function upgradeTp(tag: string): Promise<void> {
  const asset = getAssetName();
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  const stop = spinner(`Downloading tp ${tag}...`);
  let tmpPath = "";
  let bakPath = "";
  let targetPath = "";

  try {
    // Download binary to temp
    const tmpName =
      process.platform === "win32"
        ? `tp-upgrade-${Date.now()}.exe`
        : `tp-upgrade-${Date.now()}`;
    tmpPath = join(tmpdir(), tmpName);
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    await Bun.write(tmpPath, res);
    if (process.platform !== "win32") {
      await $`chmod +x ${tmpPath}`.quiet();
    }
    stop(ok(`Downloaded tp ${tag}`));

    // Verify checksum
    const stopCheck = spinner("Verifying checksum...");
    const checksums = await downloadChecksums(tag);
    if (checksums) {
      const expectedHash = checksums.get(asset);
      if (!expectedHash) {
        stopCheck();
        throw new Error(`Asset ${asset} not found in checksums.txt`);
      }
      const actualHash = await computeFileHash(tmpPath);
      if (actualHash !== expectedHash) {
        stopCheck();
        // Delete the corrupted download
        try {
          unlinkSync(tmpPath);
        } catch {}
        tmpPath = ""; // Already cleaned up
        throw new Error(
          `Checksum mismatch!\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`,
        );
      }
      stopCheck(ok("Checksum verified (SHA-256)."));
    } else {
      stopCheck(
        warn("Checksum verification skipped (checksums.txt not available)."),
      );
    }

    // Resolve target path
    const currentPath = await resolveCurrentBinaryPath();
    if (currentPath) {
      targetPath = currentPath;
    } else if (process.platform === "win32") {
      const base =
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
      targetPath = join(base, "Programs", "teleprompter", "tp.exe");
      mkdirSync(dirname(targetPath), { recursive: true });
    } else {
      targetPath = join(homedir(), ".local", "bin", "tp");
      mkdirSync(dirname(targetPath), { recursive: true });
    }

    // Back up existing binary
    if (existsSync(targetPath)) {
      bakPath = backupBinary(targetPath);
    }

    // Replace binary
    try {
      renameSync(tmpPath, targetPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EXDEV") {
        copyFileSync(tmpPath, targetPath);
        unlinkSync(tmpPath);
      } else {
        throw e;
      }
    }
    tmpPath = ""; // Cleared — no longer need to clean up tmp
    console.log(`Updated tp at ${targetPath}`);

    // Verify the new binary runs
    const verification = await verifyNewBinary(targetPath);
    if (!verification.ok) {
      throw new Error(
        `New binary verification failed — ${verification.reason}`,
      );
    }
    console.log(ok(`Verified: ${verification.version}`));

    // Clean up backup
    if (bakPath) {
      cleanupBackup(bakPath);
    }

    // Restart daemon if running as a service
    await restartDaemon();
  } catch (err) {
    stop();

    // Clean up downloaded temp file if it still exists
    if (tmpPath && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }

    // Rollback: restore from backup
    if (bakPath && existsSync(bakPath) && targetPath) {
      try {
        restoreBinary(targetPath, bakPath);
        console.log(ok(`Rolled back to previous binary at ${targetPath}`));
      } catch {
        // restoreBinary already logged the failure; don't claim success.
      }
    }

    const manualHint =
      process.platform === "win32"
        ? `Manual: irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex`
        : `Manual: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash`;
    console.error(
      errorWithHints(
        `Upgrade failed: ${err instanceof Error ? err.message : err}`,
        [manualHint],
      ),
    );
  }
}
