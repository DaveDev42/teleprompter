import { $ } from "bun";
import { errorWithHints } from "../lib/format";
import { spinner } from "../lib/spinner";

const REPO = "DaveDev42/teleprompter";

/**
 * tp upgrade — upgrade tp binary and optionally claude code.
 */
export async function upgradeCommand(): Promise<void> {
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
    console.log("\n\x1b[32m✓\x1b[0m tp is already up to date!");
  } else {
    console.log(`\nUpgrading tp ${currentVersion} → ${latest.tag}...`);
    await upgradeTp(latest.tag);
  }

  // 3. Upgrade claude code
  const stopClaude = spinner("Checking Claude Code...");
  try {
    await $`claude update`.quiet();
    stopClaude("\x1b[32m✓\x1b[0m Claude Code is up to date.");
  } catch {
    stopClaude(
      "\x1b[33m!\x1b[0m Claude Code update skipped (run 'claude update' manually).",
    );
  }
}

/**
 * Check if a newer version is available. Called on tp startup.
 * Returns the new version tag if available, null otherwise.
 */
export async function checkForUpdates(): Promise<string | null> {
  try {
    const current = getCurrentVersion();
    const latest = await getLatestRelease();
    if (latest && latest.tag !== `v${current}`) {
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

async function upgradeTp(tag: string): Promise<void> {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const asset = `tp-${os}_${arch}`;
  const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  const stop = spinner(`Downloading tp ${tag}...`);
  try {
    // Download to temp
    const tmpPath = `/tmp/tp-upgrade-${Date.now()}`;
    await $`curl -fsSL ${url} -o ${tmpPath}`.quiet();
    await $`chmod +x ${tmpPath}`.quiet();
    stop(`\x1b[32m✓\x1b[0m Downloaded tp ${tag}`);

    // Find current binary location
    const currentPath = process.execPath.includes("bun")
      ? (await $`which tp`.text().catch(() => "")).trim()
      : process.execPath;

    if (currentPath && currentPath !== "") {
      await $`mv ${tmpPath} ${currentPath}`.quiet();
      console.log(`Updated tp at ${currentPath}`);
    } else {
      const installDir = `${process.env.HOME}/.local/bin`;
      await $`mkdir -p ${installDir}`.quiet();
      await $`mv ${tmpPath} ${installDir}/tp`.quiet();
      console.log(`Installed tp to ${installDir}/tp`);
    }

    // Verify
    const version = await $`${currentPath || "tp"} version`
      .text()
      .catch(() => "");
    console.log(`\x1b[32m✓\x1b[0m Verified: ${version.trim()}`);
  } catch (err) {
    stop();
    console.error(
      errorWithHints(
        `Upgrade failed: ${err instanceof Error ? err.message : err}`,
        [
          `Manual: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash`,
        ],
      ),
    );
  }
}
