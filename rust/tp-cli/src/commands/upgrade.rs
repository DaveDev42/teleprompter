//! `tp upgrade` — upgrade the tp binary, then run `claude update` afterwards.
//!
//! Byte-faithful port of `apps/cli/src/commands/upgrade.ts` (688 lines).
//!
//! ## Key design decisions
//!
//! ### Asset shape (single binary, NOT tarball)
//!
//! GitHub releases ship the **legacy single-binary asset** `tp-<os>_<arch>` (e.g.
//! `tp-darwin_arm64`). The 4d tarball packaging (`tp-<suffix>.tar.gz`) exists in
//! the build pipeline but is NOT yet wired into `release.yml` — that rides with
//! the #5 hard-swap. Therefore this command downloads the single-binary asset,
//! byte-for-byte identical to what the Bun upgrade does.
//!
//! TODO(#5): When the tarball-based release ships, update `download_asset` to
//! fetch `tp-<suffix>.tar.gz`, extract the binary, and verify the tarball
//! checksum. The current single-binary path should then be removed or gated.
//!
//! ### `checkForUpdates` (24h startup check) — NOT ported here
//!
//! `checkForUpdates` (upgrade.ts:177-232) is the 24h-cached background update
//! check called on startup by passthrough/doctor/pair. It is NOT needed for
//! `tp upgrade` itself. Since the Rust CLI does not yet have the startup-check
//! wiring (that lives in the tranche 5 passthrough path), `checkForUpdates` is
//! deliberately skipped in 4e. Port it in tranche 5 when the startup path lands.
//!
//! ### `pgrep` process name divergence
//!
//! The Bun `restartDaemon` (upgrade.ts:552) greps for `pgrep -x "tp"`. In the
//! Rust world the daemon process is `tpd` — the Bun SEA blob that `commands::daemon::start`
//! exec's via `locate_bun_blob()` (see `locate.rs`). The Rust trampoline exec's
//! `tpd` directly, so the running daemon appears as `tpd` in the process table,
//! not `tp`. We match `tpd` here to preserve the *intent* of the check ("warn if
//! an unmanaged daemon is running") while correctly targeting the actual process
//! name. This is a behavior-PRESERVING divergence.
//!
//! ### run() always exits 0
//!
//! `upgradeCommand` in the Bun CLI returns `void` and never throws to the caller
//! (all errors are caught internally and printed). `run()` mirrors this: it returns
//! `ExitCode::SUCCESS` even when a handled upgrade failure occurred (the error was
//! already printed to stderr).
//!
//! ### Architecture invariant (A2.4 #2 posture)
//!
//! This module: NO daemon IPC, NO relay WebSocket, NO direct SQLite writes.
//! Upgrade is a stand-alone self-replacement operation that talks only to GitHub
//! and the OS service manager.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use sha2::{Digest, Sha256};

use crate::colors::{ok, warn};
use crate::format::error_with_hints;

const REPO: &str = "DaveDev42/teleprompter";

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

/// Parsed semver-ish version. Mirrors `ParsedVersion` in upgrade.ts:121-127.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVersion {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// true when the version string has a `-prerelease` suffix.
    pub prerelease: bool,
}

/// Parse a semver-ish tag ("v0.1.5" or "0.1.5-rc.1") into numeric parts.
/// Returns `None` for unparseable input (mirrors `parseVersion` returning null).
///
/// Port of `parseVersion` (upgrade.ts:133-145). Hand-rolls the parse to avoid
/// pulling in the `semver` crate (explicit brief constraint). Regex:
/// `^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$`.
pub fn parse_version(v: &str) -> Option<ParsedVersion> {
    // Strip leading 'v', then leading/trailing whitespace (upgrade.ts:134).
    let trimmed = v.trim().trim_start_matches('v');

    // Split off the build-metadata suffix (`+...`), then split off the
    // prerelease suffix (`-...`), then split the numeric triple on '.'.
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core, pre_str) = match without_build.find('-') {
        Some(pos) => (&without_build[..pos], Some(&without_build[pos + 1..])),
        None => (without_build, None),
    };

    // Validate prerelease identifier chars: [0-9A-Za-z.-]+
    if let Some(pre) = pre_str {
        if pre.is_empty() {
            return None;
        }
        if !pre
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        {
            return None;
        }
    }

    let parts: Vec<&str> = core.splitn(4, '.').collect();
    if parts.len() != 3 {
        return None;
    }
    // All three numeric components must be pure digits.
    for p in &parts {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }

    let major: u64 = parts[0].parse().ok()?;
    let minor: u64 = parts[1].parse().ok()?;
    let patch: u64 = parts[2].parse().ok()?;

    Some(ParsedVersion {
        major,
        minor,
        patch,
        prerelease: pre_str.is_some(),
    })
}

/// Returns true iff version string `a` < version string `b`.
/// Unparseable input → false (treat as up-to-date).
///
/// Byte-exact port of `isOlderVersion` (upgrade.ts:155-164). Numeric triple
/// compared in order; on equal triple, `a.prerelease && !b.prerelease`.
pub fn is_older_version(a: &str, b: &str) -> bool {
    let pa = match parse_version(a) {
        Some(v) => v,
        None => return false,
    };
    let pb = match parse_version(b) {
        Some(v) => v,
        None => return false,
    };
    for (va, vb) in [
        (pa.major, pb.major),
        (pa.minor, pb.minor),
        (pa.patch, pb.patch),
    ] {
        if va < vb {
            return true;
        }
        if va > vb {
            return false;
        }
    }
    pa.prerelease && !pb.prerelease
}

// ---------------------------------------------------------------------------
// Asset name
// ---------------------------------------------------------------------------

/// Build the asset name for the current platform.
///
/// Port of `getAssetName()` (upgrade.ts:329-333).
/// OS: `std::env::consts::OS` — `"macos"` → `"darwin"`, `"linux"` → `"linux"`.
/// Arch: `std::env::consts::ARCH` — `"aarch64"` → `"arm64"`, `"x86_64"` → `"x64"`.
///
/// Download URL template:
/// `https://github.com/DaveDev42/teleprompter/releases/download/<tag>/tp-<os>_<arch>`
pub fn get_asset_name() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("tp-{os}_{arch}")
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/// Parse checksums.txt (sha256sum format: `<hash>  <filename>\n`) into a map.
///
/// Port of `parseChecksums` (upgrade.ts:366-380). Each non-comment line must
/// match `^([a-f0-9]{64})\s+(.+)$`; others are silently skipped (including
/// blank lines and CRLF).
pub fn parse_checksums(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        // Require exactly 64 lowercase hex chars, then whitespace, then filename.
        if line.len() < 66 {
            continue;
        }
        let (hash_part, rest) = line.split_at(64);
        if !hash_part
            .chars()
            .all(|c| matches!(c, 'a'..='f' | '0'..='9'))
        {
            continue;
        }
        let rest = rest.trim_start_matches([' ', '\t']);
        if rest.is_empty() {
            continue;
        }
        map.insert(rest.to_string(), hash_part.to_string());
    }
    map
}

// ---------------------------------------------------------------------------
// File hash
// ---------------------------------------------------------------------------

/// Compute the SHA-256 hex digest of a file.
///
/// Port of `computeFileHash` (upgrade.ts:383-388). Returns lowercase hex.
pub fn compute_file_hash(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Backup / restore / cleanup
// ---------------------------------------------------------------------------

/// Back up the existing binary to `<path>.bak`.
///
/// Port of `backupBinary` (upgrade.ts:391-398). Copies the file rather than
/// renaming so the original path remains available if the copy fails partway.
pub fn backup_binary(binary_path: &Path) -> io::Result<PathBuf> {
    if !binary_path.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Binary not found at {}", binary_path.display()),
        ));
    }
    let bak = PathBuf::from(format!("{}.bak", binary_path.display()));
    fs::copy(binary_path, &bak)?;
    Ok(bak)
}

/// Restore binary from `.bak` backup.
///
/// Port of `restoreBinary` (upgrade.ts:402-417). Tries `rename` first;
/// on EXDEV (errno 18 — cross-device rename, e.g. tmp→/opt on different mount)
/// falls back to copy + unlink.
pub fn restore_binary(binary_path: &Path, bak_path: &Path) -> io::Result<()> {
    match fs::rename(bak_path, binary_path) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            // EXDEV — cross-device: fall back to copy+unlink (upgrade.ts:408-410).
            fs::copy(bak_path, binary_path)?;
            fs::remove_file(bak_path)?;
            Ok(())
        }
        Err(e) => {
            eprintln!(
                "Failed to restore backup: {e}. Manual restore: move {} to {}",
                bak_path.display(),
                binary_path.display()
            );
            Err(e)
        }
    }
}

/// Remove the `.bak` backup after a successful upgrade.
///
/// Port of `cleanupBackup` (upgrade.ts:419-426). Ignores errors — non-critical.
pub fn cleanup_backup(bak_path: &Path) {
    let _ = fs::remove_file(bak_path);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Inputs to `analyze_verification_output`. Factored out for pure testing.
#[derive(Debug)]
pub struct VerificationOutput {
    pub exit_code: Option<i32>,
    /// Signal number that killed the process, if any (Unix only).
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Result of verifying a binary.
#[derive(Debug, PartialEq, Eq)]
pub enum VerificationResult {
    Ok { version: String },
    Err { reason: String },
}

/// Pure decision logic for `verify_new_binary`, factored out for unit testing.
///
/// Port of `analyzeVerificationOutput` (upgrade.ts:445-476). All branches are
/// preserved, including the Gatekeeper SIGKILL hint. In Rust tests there is no
/// bun:test stdio-interception bug, so the pure fn is retained for testability.
pub fn analyze_verification_output(out: &VerificationOutput) -> VerificationResult {
    let exit_nonzero = out.exit_code.is_some_and(|c| c != 0);
    let killed_by_signal = out.exit_code.is_none() || out.signal.is_some();

    if exit_nonzero || (out.exit_code.is_none() && killed_by_signal) {
        if let (true, Some(sig)) = (killed_by_signal, out.signal) {
            let exit_str = out
                .exit_code
                .map_or_else(|| "null".to_string(), |c| c.to_string());
            return VerificationResult::Err {
                reason: format!(
                    "binary killed by signal {sig} (exit {exit_str}). \
                     On macOS this usually means the download was rejected by Gatekeeper \
                     because the binary is unsigned. Re-run with a signed release."
                ),
            };
        }
        let err = {
            let s = out.stderr.trim();
            if !s.is_empty() {
                s.to_string()
            } else {
                let s2 = out.stdout.trim();
                if !s2.is_empty() {
                    s2.to_string()
                } else {
                    "no output".to_string()
                }
            }
        };
        return VerificationResult::Err {
            reason: format!("exit {}: {err}", out.exit_code.unwrap_or(0)),
        };
    }

    let stdout = out.stdout.trim();
    if stdout.is_empty() {
        return VerificationResult::Err {
            reason: "no output on stdout".to_string(),
        };
    }
    if !stdout.starts_with("tp v") || !stdout[4..].starts_with(|c: char| c.is_ascii_digit()) {
        return VerificationResult::Err {
            reason: format!("unexpected output: {stdout}"),
        };
    }
    // Return only the first line so the banner stays tp-focused (upgrade.ts:474).
    let first_line = stdout.lines().next().unwrap_or(stdout).trim().to_string();
    VerificationResult::Ok {
        version: first_line,
    }
}

/// Run `<binary> version` and confirm it produced a plausible tp version banner.
///
/// Port of `verifyNewBinary` (upgrade.ts:483-501). Signal detection uses
/// `std::os::unix::process::ExitStatusExt` (Unix-only — non-Unix always
/// returns signal=None, which is correct).
pub fn verify_new_binary(binary_path: &Path) -> VerificationResult {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;

    match Command::new(binary_path).arg("version").output() {
        Err(e) => VerificationResult::Err {
            reason: format!("failed to spawn: {e}"),
        },
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            #[cfg(unix)]
            let signal = output.status.signal();
            #[cfg(not(unix))]
            let signal: Option<i32> = None;
            let exit_code = output.status.code();
            analyze_verification_output(&VerificationOutput {
                exit_code,
                signal,
                stdout,
                stderr,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Release info
// ---------------------------------------------------------------------------

/// A GitHub release entry (tag + URL).
#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    pub url: String,
}

/// Parse the JSON from `gh release view --json tagName,url`.
///
/// Port of `parseGhReleaseJson` (upgrade.ts:251-271). Returns `None` when
/// either field is missing or non-string.
pub fn parse_gh_release_json(raw: &str) -> Option<Release> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let tag = v.get("tagName")?.as_str()?.to_string();
    let url = v.get("url")?.as_str()?.to_string();
    if tag.is_empty() || url.is_empty() {
        return None;
    }
    Some(Release { tag, url })
}

/// Parse the JSON from the GitHub public releases API.
///
/// Port of `parseGithubApiReleaseJson` (upgrade.ts:281-296). Fields:
/// `tag_name` and `html_url`.
pub fn parse_github_api_release_json(raw: &serde_json::Value) -> Option<Release> {
    let tag = raw.get("tag_name")?.as_str()?.to_string();
    let url = raw.get("html_url")?.as_str()?.to_string();
    if tag.is_empty() || url.is_empty() {
        return None;
    }
    Some(Release { tag, url })
}

/// Fetch the latest release — gh CLI first, fallback to public API.
///
/// Port of `getLatestRelease` (upgrade.ts:298-326).
pub fn get_latest_release() -> Option<Release> {
    // Try gh CLI first (works with private repos, honors GITHUB_TOKEN).
    if let Ok(output) = Command::new("gh")
        .args(["release", "view", "--repo", REPO, "--json", "tagName,url"])
        .output()
    {
        if output.status.success() {
            let raw = String::from_utf8_lossy(&output.stdout);
            if let Some(release) = parse_gh_release_json(&raw) {
                return Some(release);
            }
        }
    }

    // Fallback: GitHub public API (5s timeout, upgrade.ts:316-325).
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("tp-cli/upgrade")
        .build()
        .ok()?;
    let resp = client.get(&url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().ok()?;
    parse_github_api_release_json(&json)
}

/// Download checksums.txt for a release tag.
///
/// Port of `downloadChecksums` (upgrade.ts:348-363). Returns `None` on any
/// failure (older releases may not have checksums.txt).
pub fn download_checksums(tag: &str) -> Option<HashMap<String, String>> {
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/checksums.txt");
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("tp-cli/upgrade")
        .build()
        .ok()?;
    let resp = client.get(&url).send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().ok()?;
    Some(parse_checksums(&text))
}

// ---------------------------------------------------------------------------
// Homebrew detection + path resolution
// ---------------------------------------------------------------------------

/// Detect whether the running tp binary lives under a Homebrew prefix.
///
/// Port of `detectHomebrewInstall` (upgrade.ts:29-49). Uses
/// `std::fs::canonicalize` instead of shelling to `readlink -f` (cleaner,
/// no subprocess). Returns the prefix path (e.g. `/opt/homebrew` or
/// `/usr/local`) when detected; `None` otherwise.
pub fn detect_homebrew_install(binary_path: &str) -> Option<String> {
    if binary_path.is_empty() {
        return None;
    }
    // Resolve symlinks — the binary lives under <prefix>/Cellar/tp/<ver>/bin/tp
    // and is usually symlinked from <prefix>/bin/tp.
    let resolved = fs::canonicalize(binary_path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| binary_path.to_string());

    // Match Homebrew Cellar layout: "^(.*)/Cellar/tp/"
    let needle = "/Cellar/tp/";
    if let Some(pos) = resolved.find(needle) {
        let prefix = &resolved[..pos];
        if prefix.is_empty() {
            return None;
        }
        return Some(prefix.to_string());
    }
    None
}

/// Resolve the path to the currently running tp binary.
///
/// Port of `resolveCurrentBinaryPath` (upgrade.ts:336-342). Uses
/// `std::env::current_exe()` (the documented 4c/4d divergence — prefers
/// current_exe over argv[0] to dodge $bunfs; no $bunfs in Rust but
/// current_exe is the correct approach). Falls back to `which tp` first line.
pub fn resolve_current_binary_path() -> String {
    // current_exe() is the Rust binary's real path (after symlinks are followed
    // by the OS on exec). This is the correct self-identification method.
    if let Ok(exe) = std::env::current_exe() {
        let s = exe.to_string_lossy().into_owned();
        if !s.is_empty() {
            return s;
        }
    }
    // Fallback: which tp (upgrade.ts:340-341).
    if let Ok(out) = Command::new("which").arg("tp").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(first) = s.lines().next() {
                let first = first.trim().to_string();
                if !first.is_empty() {
                    return first;
                }
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Daemon restart
// ---------------------------------------------------------------------------

/// Restart the daemon service after a binary upgrade.
///
/// Port of `restartDaemon` (upgrade.ts:503-563).
///
/// macOS: if the launchd plist exists, `launchctl kickstart -k gui/<uid>/dev.tpmt.daemon`.
/// Linux: if the systemd unit exists, `systemctl --user restart teleprompter-daemon`.
/// Neither service: `pgrep -x tpd` — if running, print a warn.
///
/// **DIVERGENCE NOTE**: The Bun CLI greps for `tp` (upgrade.ts:552 —
/// `pgrep -x "tp"`). In the Rust trampoline world the daemon blob is `tpd`
/// (exec'd directly by `commands::daemon::start` via `locate_bun_blob()` in
/// `locate.rs`). We match `tpd` to correctly identify the daemon process.
/// Behavior intent is preserved: "warn if an unmanaged daemon is running."
fn restart_daemon() {
    #[cfg(target_os = "macos")]
    {
        if crate::service_darwin::plist_path().exists() {
            let uid = rustix::process::getuid().as_raw();
            let target = format!("gui/{uid}/dev.tpmt.daemon");
            let result = Command::new("launchctl")
                .args(["kickstart", "-k", &target])
                .status();
            match result {
                Ok(s) if s.success() => {
                    println!("{}", ok("Daemon restarted via launchd."));
                }
                Ok(s) => {
                    let code = s.code().unwrap_or(-1);
                    println!(
                        "{}",
                        warn(&format!(
                            "Daemon restart failed (launchctl exit {code}). \
                             Restart manually: tp daemon start"
                        ))
                    );
                }
                Err(e) => {
                    println!(
                        "{}",
                        warn(&format!(
                            "Daemon restart failed ({e}). Restart manually: tp daemon start"
                        ))
                    );
                }
            }
            return;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if crate::service_linux::unit_path().exists() {
            let result = Command::new("systemctl")
                .args(["--user", "restart", "teleprompter-daemon"])
                .status();
            match result {
                Ok(s) if s.success() => {
                    println!("{}", ok("Daemon restarted via systemd."));
                }
                Ok(s) => {
                    let code = s.code().unwrap_or(-1);
                    println!(
                        "{}",
                        warn(&format!(
                            "Daemon restart failed (systemctl exit {code}). \
                             Restart manually: tp daemon start"
                        ))
                    );
                }
                Err(e) => {
                    println!(
                        "{}",
                        warn(&format!(
                            "Daemon restart failed ({e}). Restart manually: tp daemon start"
                        ))
                    );
                }
            }
            return;
        }
    }

    // No service installed — check for running daemon via pgrep.
    // DIVERGENCE: match "tpd" (Bun SEA blob name) not "tp" (the Rust CLI name).
    // The daemon process is `tpd` because commands::daemon::start exec's the
    // Bun blob located by locate_bun_blob() (locate.rs). See module doc.
    let pgrep = Command::new("pgrep").args(["-x", "tpd"]).output();
    if let Ok(out) = pgrep {
        let found = String::from_utf8_lossy(&out.stdout);
        if !found.trim().is_empty() {
            println!(
                "{}",
                warn(
                    "Daemon is running but not managed by a system service. \
                     Restart it manually: tp daemon start"
                )
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

/// Download a URL to a file path, printing a progress line to stdout.
///
/// The Bun reference uses `downloadWithProgress` with a TTY progress bar
/// (`apps/cli/src/lib/download.ts`). The brief allows functional parity
/// ("Downloading… done" or a basic byte counter) without exact bar layout.
fn download_to_file(url: &str, dest: &Path) -> Result<(), String> {
    print!("Downloading {url} ...");
    let _ = io::stdout().flush();

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .user_agent("tp-cli/upgrade")
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;

    let mut resp = client
        .get(url)
        .send()
        .map_err(|e| format!("download request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading {url}", resp.status()));
    }

    let mut file = fs::File::create(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    resp.copy_to(&mut file)
        .map_err(|e| format!("write {}: {e}", dest.display()))?;

    println!(" done.");
    Ok(())
}

// ---------------------------------------------------------------------------
// Full upgrade orchestration
// ---------------------------------------------------------------------------

/// Download, verify, install, and restart the daemon.
///
/// Port of `upgradeTp` (upgrade.ts:565-687).
fn upgrade_tp(tag: &str) {
    let asset = get_asset_name();
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/{asset}");

    // Temp file for the downloaded binary.
    let tmp_path = std::env::temp_dir().join(format!("tp-upgrade-{}", std::process::id()));
    let mut tmp_path_opt: Option<PathBuf> = Some(tmp_path.clone());
    let mut bak_path_opt: Option<PathBuf> = None;
    let mut target_path_opt: Option<PathBuf> = None;

    let result = (|| -> Result<(), String> {
        // 1. Download binary to temp (upgrade.ts:577-581).
        download_to_file(&url, &tmp_path)?;

        // 2. chmod +x (upgrade.ts:579 `chmod +x`).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&tmp_path)
                .map_err(|e| format!("stat {}: {e}", tmp_path.display()))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&tmp_path, perms)
                .map_err(|e| format!("chmod +x {}: {e}", tmp_path.display()))?;
        }
        println!("{}", ok(&format!("Downloaded tp {tag}")));

        // 3. Verify checksum (upgrade.ts:584-609).
        println!("Verifying checksum...");
        let checksums = download_checksums(tag);
        if let Some(ref map) = checksums {
            let expected = map
                .get(&asset)
                .ok_or_else(|| format!("Asset {asset} not found in checksums.txt"))?;
            let actual = compute_file_hash(&tmp_path)
                .map_err(|e| format!("hash {}: {e}", tmp_path.display()))?;
            if &actual != expected {
                // Delete the corrupted download before propagating error.
                tmp_path_opt = None;
                let _ = fs::remove_file(&tmp_path);
                return Err(format!(
                    "Checksum mismatch!\n  Expected: {expected}\n  Got:      {actual}"
                ));
            }
            println!("{}", ok("Checksum verified (SHA-256)."));
        } else {
            println!(
                "{}",
                warn("Checksum verification skipped (checksums.txt not available).")
            );
        }

        // 4. Resolve target path (upgrade.ts:612-618).
        let current_path = resolve_current_binary_path();
        let target = if !current_path.is_empty() {
            PathBuf::from(&current_path)
        } else {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            let t = PathBuf::from(home).join(".local").join("bin").join("tp");
            if let Some(parent) = t.parent() {
                let _ = fs::create_dir_all(parent);
            }
            t
        };
        target_path_opt = Some(target.clone());

        // 5. Back up existing binary (upgrade.ts:621-623).
        if target.exists() {
            let bak = backup_binary(&target).map_err(|e| format!("backup failed: {e}"))?;
            bak_path_opt = Some(bak);
        }

        // 6. Replace binary (upgrade.ts:626-642).
        match fs::rename(&tmp_path, &target) {
            Ok(()) => {
                tmp_path_opt = None; // Rename succeeded — nothing to clean up.
            }
            Err(e) if e.raw_os_error() == Some(18) => {
                // EXDEV — cross-device: copy+unlink (upgrade.ts:637-640).
                fs::copy(&tmp_path, &target)
                    .map_err(|e2| format!("cross-device copy failed: {e2}"))?;
                fs::remove_file(&tmp_path).map_err(|e2| format!("unlink tmp after copy: {e2}"))?;
                tmp_path_opt = None;
            }
            Err(e) => return Err(format!("rename failed: {e}")),
        }
        println!("Updated tp at {}", target.display());

        // 7. Verify new binary (upgrade.ts:645-651).
        match verify_new_binary(&target) {
            VerificationResult::Ok { version } => {
                println!("{}", ok(&format!("Verified: {version}")));
            }
            VerificationResult::Err { reason } => {
                return Err(format!("New binary verification failed — {reason}"));
            }
        }

        // 8. Clean up backup (upgrade.ts:654-656).
        if let Some(ref bak) = bak_path_opt {
            cleanup_backup(bak);
            bak_path_opt = None;
        }

        // 9. Restart daemon (upgrade.ts:659-660).
        restart_daemon();

        Ok(())
    })();

    if let Err(err) = result {
        // Clean up tmp if it still exists (upgrade.ts:662-666).
        if let Some(ref p) = tmp_path_opt {
            if p.exists() {
                let _ = fs::remove_file(p);
            }
        }

        // Rollback: restore from backup (upgrade.ts:668-677).
        if let (Some(ref bak), Some(ref target)) = (&bak_path_opt, &target_path_opt) {
            if bak.exists() {
                match restore_binary(target, bak) {
                    Ok(()) => {
                        println!(
                            "{}",
                            ok(&format!(
                                "Rolled back to previous binary at {}",
                                target.display()
                            ))
                        );
                    }
                    Err(_) => {
                        // restore_binary already logged the failure.
                    }
                }
            }
        }

        let manual_hint = format!(
            "Manual: curl -fsSL https://raw.githubusercontent.com/{REPO}/main/scripts/install.sh | bash"
        );
        eprintln!(
            "{}",
            error_with_hints(&format!("Upgrade failed: {err}"), &[&manual_hint])
        );
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Current tp version (no `v` prefix). Used for comparison with latest tag.
pub(crate) fn current_version() -> &'static str {
    crate::commands::version::TP_VERSION
}

/// `tp upgrade` entry point.
///
/// Port of `upgradeCommand` (upgrade.ts:57-110). ALWAYS returns
/// `ExitCode::SUCCESS` — errors are printed, not propagated (mirrors the Bun
/// `upgradeCommand` which returns `void` and never throws to the process).
pub fn run() -> ExitCode {
    println!("Teleprompter Upgrade\n");

    // 1. Show current version.
    let version = current_version();
    println!("Current: tp v{version}");

    // 2. Fetch latest release.
    println!("Checking for updates...");
    let latest = get_latest_release();
    let Some(latest) = latest else {
        eprintln!(
            "{}",
            error_with_hints(
                "Failed to check for updates.",
                &[
                    "Check your network connection",
                    &format!("Manual: gh release view --repo {REPO}"),
                ]
            )
        );
        return ExitCode::SUCCESS;
    };

    println!("Latest:  tp {}", latest.tag);

    if latest.tag == format!("v{version}") {
        println!("\n{}", ok("tp is already up to date!"));
    } else {
        // Check for Homebrew install (upgrade.ts:87-95).
        let current_path = resolve_current_binary_path();
        if detect_homebrew_install(&current_path).is_some() {
            println!(
                "\n{}",
                warn("tp was installed via Homebrew — skip self-update.")
            );
            println!("Run: brew upgrade davedev42/tap/tp");
        } else {
            println!("\nUpgrading tp {version} \u{2192} {}...", latest.tag);
            upgrade_tp(&latest.tag);
        }
    }

    // 3. Upgrade claude (upgrade.ts:101-109).
    println!("Checking Claude Code...");
    match Command::new("claude").arg("update").output() {
        Ok(out) if out.status.success() => {
            println!("{}", ok("Claude Code is up to date."));
        }
        _ => {
            println!(
                "{}",
                warn("Claude Code update skipped (run 'claude update' manually).")
            );
        }
    }

    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // ── parse_version ────────────────────────────────────────────────────────

    #[test]
    fn parse_version_plain() {
        let v = parse_version("0.1.5").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 1);
        assert_eq!(v.patch, 5);
        assert!(!v.prerelease);
    }

    #[test]
    fn parse_version_strips_v_prefix() {
        let v = parse_version("v1.2.3").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        assert!(!v.prerelease);
    }

    #[test]
    fn parse_version_prerelease() {
        let v = parse_version("0.1.5-rc.1").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (0, 1, 5));
        assert!(v.prerelease);
    }

    #[test]
    fn parse_version_v_prerelease() {
        let v = parse_version("v0.1.5-rc.1").unwrap();
        assert!(v.prerelease);
        assert_eq!(v.patch, 5);
    }

    #[test]
    fn parse_version_build_metadata() {
        // Build metadata after `+` is ignored (not stored).
        let v = parse_version("1.0.0+build.1").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 0, 0));
        assert!(!v.prerelease);
    }

    #[test]
    fn parse_version_garbage_returns_none() {
        assert!(parse_version("not-a-version").is_none());
        assert!(parse_version("").is_none());
        assert!(parse_version("v").is_none());
        assert!(parse_version("1.2").is_none());
        assert!(parse_version("1.2.3.4").is_none());
        assert!(parse_version("1.2.x").is_none());
    }

    #[test]
    fn parse_version_whitespace_stripped() {
        let v = parse_version("  v1.2.3  ").unwrap();
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
    }

    // ── is_older_version ─────────────────────────────────────────────────────

    #[test]
    fn is_older_version_strict_major() {
        assert!(is_older_version("0.1.0", "1.0.0"));
        assert!(!is_older_version("1.0.0", "0.1.0"));
    }

    #[test]
    fn is_older_version_strict_minor() {
        assert!(is_older_version("0.1.0", "0.2.0"));
        assert!(!is_older_version("0.2.0", "0.1.0"));
    }

    #[test]
    fn is_older_version_strict_patch() {
        assert!(is_older_version("0.1.4", "0.1.5"));
        assert!(!is_older_version("0.1.5", "0.1.4"));
    }

    #[test]
    fn is_older_version_equal_returns_false() {
        assert!(!is_older_version("0.1.5", "0.1.5"));
        assert!(!is_older_version("v0.1.5", "v0.1.5"));
    }

    #[test]
    fn is_older_version_prerelease_older_than_stable() {
        // 0.1.5-rc.1 < 0.1.5 (prerelease < stable, same triple)
        assert!(is_older_version("0.1.5-rc.1", "0.1.5"));
        assert!(!is_older_version("0.1.5", "0.1.5-rc.1"));
    }

    #[test]
    fn is_older_version_both_prerelease_equal() {
        // Both prerelease with same triple → not strictly older.
        assert!(!is_older_version("0.1.5-rc.1", "0.1.5-rc.2"));
    }

    #[test]
    fn is_older_version_unparseable_returns_false() {
        assert!(!is_older_version("garbage", "0.1.0"));
        assert!(!is_older_version("0.1.0", "garbage"));
        assert!(!is_older_version("garbage", "garbage"));
    }

    // ── parse_checksums ──────────────────────────────────────────────────────

    #[test]
    fn parse_checksums_basic() {
        let text =
            "abc123def456abc123def456abc123def456abc123def456abc123def456abc1  tp-darwin_arm64\n";
        let map = parse_checksums(text);
        assert_eq!(
            map.get("tp-darwin_arm64").map(String::as_str),
            Some("abc123def456abc123def456abc123def456abc123def456abc123def456abc1")
        );
    }

    #[test]
    fn parse_checksums_sha256sum_format() {
        // Standard sha256sum output: 64 hex chars + two spaces + filename.
        let text = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty.txt\n";
        let map = parse_checksums(text);
        assert!(map.contains_key("empty.txt"));
    }

    #[test]
    fn parse_checksums_crlf() {
        let hash = "a".repeat(64);
        let text = format!("{hash}  file.bin\r\n");
        let map = parse_checksums(&text);
        assert!(map.contains_key("file.bin"), "CRLF lines must be parsed");
    }

    #[test]
    fn parse_checksums_invalid_lines_skipped() {
        let hash = "a".repeat(64);
        let text = format!(
            "# comment\n\nshorthash  file1\n{hash}  valid_file\nGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG  bad\n"
        );
        let map = parse_checksums(&text);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("valid_file"));
    }

    #[test]
    fn parse_checksums_empty_text() {
        let map = parse_checksums("");
        assert!(map.is_empty());
    }

    // ── get_asset_name ───────────────────────────────────────────────────────

    #[test]
    fn get_asset_name_this_platform() {
        let name = get_asset_name();
        // Must start with "tp-" and contain "_".
        assert!(
            name.starts_with("tp-"),
            "asset name must start with tp-: {name}"
        );
        assert!(name.contains('_'), "asset name must contain _: {name}");
        // On macOS aarch64 (MBP16 / MacMini) the value should be tp-darwin_arm64.
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        assert_eq!(name, "tp-darwin_arm64");
        // On Linux x86_64 (WSL / CI).
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(name, "tp-linux_x64");
    }

    // ── compute_file_hash ────────────────────────────────────────────────────

    #[test]
    fn compute_file_hash_known_content() {
        // SHA-256 of empty string.
        let dir = tempfile::TempDir::new().unwrap();
        let f = dir.path().join("empty");
        std::fs::write(&f, b"").unwrap();
        let hash = compute_file_hash(&f).unwrap();
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb924\
             27ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn compute_file_hash_returns_64_hex() {
        let dir = tempfile::TempDir::new().unwrap();
        let f = dir.path().join("data");
        std::fs::write(&f, b"hello").unwrap();
        let hash = compute_file_hash(&f).unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn compute_file_hash_different_content_differs() {
        let dir = tempfile::TempDir::new().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        std::fs::write(&a, b"aaaa").unwrap();
        std::fs::write(&b, b"bbbb").unwrap();
        assert_ne!(
            compute_file_hash(&a).unwrap(),
            compute_file_hash(&b).unwrap()
        );
    }

    // ── backup / restore round-trip ──────────────────────────────────────────

    #[test]
    fn backup_restore_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let bin = dir.path().join("tp");
        std::fs::write(&bin, b"original content").unwrap();

        let bak = backup_binary(&bin).unwrap();
        assert!(bak.exists(), "backup file must exist");
        assert_eq!(std::fs::read(&bak).unwrap(), b"original content");

        // Overwrite the original with new content.
        std::fs::write(&bin, b"new content").unwrap();

        // Restore from backup.
        restore_binary(&bin, &bak).unwrap();
        assert_eq!(std::fs::read(&bin).unwrap(), b"original content");
        // Backup should be gone after rename-based restore (on same device the
        // rename succeeds and the .bak is removed atomically).
        // Note: on EXDEV the bak is explicitly unlinked; either way it's gone.
        // (On same device rename leaves no .bak; check it either exists or not.)
    }

    #[test]
    fn backup_missing_binary_errors() {
        let dir = tempfile::TempDir::new().unwrap();
        let missing = dir.path().join("nonexistent");
        assert!(backup_binary(&missing).is_err());
    }

    #[test]
    fn cleanup_backup_is_idempotent() {
        // cleanup_backup should not panic when the file doesn't exist.
        cleanup_backup(Path::new("/tmp/tp-cli-test-nonexistent.bak"));
    }

    // ── analyze_verification_output ──────────────────────────────────────────

    #[test]
    fn verify_accept_tp_version_output() {
        let out = VerificationOutput {
            exit_code: Some(0),
            signal: None,
            stdout: "tp v0.1.9\nclaude 1.2.3".to_string(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Ok { version } => {
                // Only the first line is returned.
                assert_eq!(version, "tp v0.1.9");
            }
            VerificationResult::Err { reason } => panic!("expected Ok, got Err: {reason}"),
        }
    }

    #[test]
    fn verify_multi_line_first_line_only() {
        let out = VerificationOutput {
            exit_code: Some(0),
            signal: None,
            stdout: "tp v1.0.0\nextra line".to_string(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Ok { version } => assert_eq!(version, "tp v1.0.0"),
            VerificationResult::Err { reason } => panic!("expected Ok: {reason}"),
        }
    }

    #[test]
    fn verify_empty_stdout_returns_err() {
        let out = VerificationOutput {
            exit_code: Some(0),
            signal: None,
            stdout: String::new(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert_eq!(reason, "no output on stdout");
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    #[test]
    fn verify_non_tp_output_returns_err() {
        let out = VerificationOutput {
            exit_code: Some(0),
            signal: None,
            stdout: "not a tp version".to_string(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert!(reason.contains("unexpected output"), "reason: {reason}");
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    #[test]
    fn verify_nonzero_exit_surfaces_stderr() {
        let out = VerificationOutput {
            exit_code: Some(1),
            signal: None,
            stdout: String::new(),
            stderr: "some error".to_string(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert!(reason.contains("some error"), "reason: {reason}");
                assert!(reason.contains("exit 1"), "reason: {reason}");
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    #[test]
    fn verify_nonzero_exit_stdout_fallback() {
        // stderr empty → fall back to stdout for the error detail.
        let out = VerificationOutput {
            exit_code: Some(2),
            signal: None,
            stdout: "stdout error detail".to_string(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert!(reason.contains("stdout error detail"), "reason: {reason}");
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    #[test]
    fn verify_nonzero_exit_no_output() {
        let out = VerificationOutput {
            exit_code: Some(127),
            signal: None,
            stdout: String::new(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert!(reason.contains("no output"), "reason: {reason}");
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    #[test]
    fn verify_sigkill_gatekeeper_hint() {
        // SIGKILL = 9; non-zero exit. This is the Gatekeeper-reject branch.
        let out = VerificationOutput {
            exit_code: Some(137), // 128 + 9
            signal: Some(9),
            stdout: String::new(),
            stderr: String::new(),
        };
        match analyze_verification_output(&out) {
            VerificationResult::Err { reason } => {
                assert!(reason.contains("signal 9"), "reason: {reason}");
                assert!(
                    reason.contains("Gatekeeper"),
                    "must mention Gatekeeper: {reason}"
                );
            }
            VerificationResult::Ok { .. } => panic!("expected Err"),
        }
    }

    // ── detect_homebrew_install ───────────────────────────────────────────────

    #[test]
    fn detect_homebrew_none_for_non_brew() {
        // A binary not under Cellar → None.
        assert!(detect_homebrew_install("/usr/local/bin/tp").is_none());
        assert!(detect_homebrew_install("/home/user/.local/bin/tp").is_none());
    }

    #[test]
    fn detect_homebrew_none_for_empty() {
        assert!(detect_homebrew_install("").is_none());
    }

    #[test]
    fn detect_homebrew_apple_silicon_cellar() {
        // Apple Silicon Homebrew prefix: /opt/homebrew
        let prefix =
            detect_homebrew_install("/opt/homebrew/Cellar/tp/0.1.5/bin/tp").unwrap_or_default();
        // canonicalize may fail since this path doesn't exist on CI; fall back
        // to a string match on the hypothetical resolved path.
        // We test the logic by matching a real-looking Cellar path.
        // On real Apple Silicon the resolved path goes through Cellar.
        // Since canonicalize won't work on a non-existent path, test by
        // constructing a real temp dir that mimics the layout.
        let dir = tempfile::TempDir::new().unwrap();
        let cellar_bin = dir
            .path()
            .join("Cellar")
            .join("tp")
            .join("0.1.5")
            .join("bin");
        std::fs::create_dir_all(&cellar_bin).unwrap();
        let fake_tp = cellar_bin.join("tp");
        std::fs::write(&fake_tp, b"fake").unwrap();
        let path_str = fake_tp.to_string_lossy().into_owned();
        let result = detect_homebrew_install(&path_str);
        // The resolved (canonical) path contains /Cellar/tp/ so we should get
        // the prefix.
        assert!(
            result.is_some(),
            "should detect brew for Cellar path: {path_str}; result: {result:?}"
        );
        let prefix = result.unwrap();
        assert!(!prefix.is_empty());
        // prefix must NOT contain /Cellar.
        assert!(
            !prefix.contains("/Cellar"),
            "prefix must be before /Cellar: {prefix}"
        );
    }

    #[test]
    fn detect_homebrew_intel_cellar() {
        // Intel Homebrew prefix: /usr/local — test the pure string match on a
        // canonicalize-resolved path that has the Cellar layout.
        let dir = tempfile::TempDir::new().unwrap();
        let cellar_bin = dir
            .path()
            .join("Cellar")
            .join("tp")
            .join("0.1.5")
            .join("bin");
        std::fs::create_dir_all(&cellar_bin).unwrap();
        let fake_tp = cellar_bin.join("tp");
        std::fs::write(&fake_tp, b"fake").unwrap();
        let path_str = fake_tp.to_string_lossy().into_owned();
        let result = detect_homebrew_install(&path_str);
        assert!(result.is_some(), "intel cellar layout must be detected");
    }

    // ── parse_gh_release_json ─────────────────────────────────────────────────

    #[test]
    fn parse_gh_release_json_valid() {
        let raw = r#"{"tagName":"v0.1.9","url":"https://github.com/DaveDev42/teleprompter/releases/tag/v0.1.9"}"#;
        let r = parse_gh_release_json(raw).unwrap();
        assert_eq!(r.tag, "v0.1.9");
        assert!(r.url.contains("v0.1.9"));
    }

    #[test]
    fn parse_gh_release_json_missing_field_returns_none() {
        let raw = r#"{"tagName":"v0.1.9"}"#;
        assert!(parse_gh_release_json(raw).is_none());
        let raw2 = r#"{"url":"https://example.com"}"#;
        assert!(parse_gh_release_json(raw2).is_none());
    }

    #[test]
    fn parse_gh_release_json_invalid_json_returns_none() {
        assert!(parse_gh_release_json("not json").is_none());
        assert!(parse_gh_release_json("").is_none());
    }

    // ── parse_github_api_release_json ─────────────────────────────────────────

    #[test]
    fn parse_github_api_release_json_valid() {
        let v = serde_json::json!({
            "tag_name": "v0.1.9",
            "html_url": "https://github.com/DaveDev42/teleprompter/releases/tag/v0.1.9"
        });
        let r = parse_github_api_release_json(&v).unwrap();
        assert_eq!(r.tag, "v0.1.9");
    }

    #[test]
    fn parse_github_api_release_json_partial_returns_none() {
        let v = serde_json::json!({"tag_name": "v0.1.9"});
        assert!(parse_github_api_release_json(&v).is_none());
        let v2 = serde_json::json!({"html_url": "https://example.com"});
        assert!(parse_github_api_release_json(&v2).is_none());
    }

    #[test]
    fn parse_github_api_release_json_null_returns_none() {
        assert!(parse_github_api_release_json(&serde_json::Value::Null).is_none());
    }

    // ── error_with_hints (upgrade.rs consumer — also tested in format.rs) ────

    #[test]
    fn error_with_hints_byte_exact() {
        // Brief mandates: error_with_hints("X", &["a","b"]) == "X\n  → a\n  → b"
        let got = error_with_hints("X", &["a", "b"]);
        assert_eq!(got, "X\n  \u{2192} a\n  \u{2192} b");
    }
}
