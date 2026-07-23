//! `tp completions install` / `tp completions uninstall` — write or remove
//! shell completion hooks.
//!
//! Byte-exact port of:
//!   `apps/cli/src/commands/completions-install.ts` (logic)
//!   `apps/cli/src/commands/completions.ts:101-188`  (dispatch + messages)
//!   `apps/cli/src/lib/shell-detect.ts`              (shell auto-detect)
//!
//! Architecture note: this command is **pure local** — no daemon, no IPC, no
//! relay. It only reads/writes files in `$HOME`.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU32, Ordering};

use super::completions::generate_fish_pub;

// ──────────────────────────────────────────────────────────────────────────────
// Public constants (byte-exact matches for cross-tool idempotency)
// ──────────────────────────────────────────────────────────────────────────────

/// completions-install.ts:68-69
pub const MARKER_START: &str = "# >>> tp completions (managed by `tp completions install`) >>>";
/// completions-install.ts:70
pub const MARKER_END: &str = "# <<< tp completions <<<";

// ──────────────────────────────────────────────────────────────────────────────
// Result types (mirrors InstallResult / UninstallResult in the TS source)
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum InstallResult {
    Installed { file: PathBuf },
    AlreadyInstalled { file: PathBuf },
    DryRun { plan: String },
}

#[derive(Debug)]
pub enum UninstallResult {
    Uninstalled { file: PathBuf },
    NotInstalled,
    DryRun { plan: String },
}

// ──────────────────────────────────────────────────────────────────────────────
// Options
// ──────────────────────────────────────────────────────────────────────────────

pub struct InstallOpts<'a> {
    pub shell: &'a str, // "bash" | "zsh" | "fish"
    pub home: PathBuf,
    pub force: bool,
    pub dry_run: bool,
}

// ──────────────────────────────────────────────────────────────────────────────
// Shell auto-detect  (mirrors shell-detect.ts:7-23)
// ──────────────────────────────────────────────────────────────────────────────

/// Detect the current shell from environment variables.
///
/// Probe order matches `detectShell` in `shell-detect.ts` exactly:
/// 1. Basename of `$SHELL` if it is `bash`, `zsh`, or `fish`.
/// 2. `$ZSH_VERSION`  → `"zsh"`
/// 3. `$BASH_VERSION` → `"bash"`
/// 4. `$FISH_VERSION` → `"fish"`
/// 5. `null` (→ `None`)
pub fn detect_shell() -> Option<String> {
    // Probe 1 — $SHELL basename.
    if let Ok(shell_path) = std::env::var("SHELL") {
        let base = shell_path.split('/').next_back().unwrap_or("").to_owned();
        if matches!(base.as_str(), "bash" | "zsh" | "fish") {
            return Some(base);
        }
    }
    // Probe 2-4 — version vars set by the shell itself.
    if std::env::var("ZSH_VERSION").is_ok() {
        return Some("zsh".to_owned());
    }
    if std::env::var("BASH_VERSION").is_ok() {
        return Some("bash".to_owned());
    }
    if std::env::var("FISH_VERSION").is_ok() {
        return Some("fish".to_owned());
    }
    None
}

// ──────────────────────────────────────────────────────────────────────────────
// Path helpers (mirrors rcFilePath / fishFilePath in completions-install.ts)
// ──────────────────────────────────────────────────────────────────────────────

fn rc_file_path(shell: &str, home: &Path) -> PathBuf {
    match shell {
        "bash" => home.join(".bashrc"),
        "zsh" => home.join(".zshrc"),
        _ => unreachable!("rc_file_path called for non-rc shell"),
    }
}

fn fish_file_path(home: &Path) -> PathBuf {
    home.join(".config")
        .join("fish")
        .join("completions")
        .join("tp.fish")
}

// ──────────────────────────────────────────────────────────────────────────────
// Marker block helpers (mirrors markerBlock / containsMarker / stripMarkerBlock)
// ──────────────────────────────────────────────────────────────────────────────

/// completions-install.ts:96-98
fn marker_block(line: &str) -> String {
    format!("\n{MARKER_START}\n{line}\n{MARKER_END}\n")
}

/// completions-install.ts:100-102
fn contains_marker(contents: &str) -> bool {
    contents.contains(MARKER_START)
}

/// completions-install.ts:108-114
///
/// Removes EVERY occurrence of `\n?MARKER_START…MARKER_END\n?` from the string.
/// The TS regex is `\\n?MARKER_START[\\s\\S]*?MARKER_END\\n?` with the `g` flag
/// (`completions-install.ts:109-113`) — it strips ALL blocks, so a corrupted /
/// hand-edited file with duplicate blocks self-heals to zero blocks on
/// uninstall (and to a single block on `install --force`, which strips-all then
/// appends one). We match that global semantics by stripping the first block
/// repeatedly until none remain.
fn strip_marker_block(contents: &str) -> String {
    let mut out = contents.to_owned();
    while contains_marker(&out) {
        let stripped = strip_first_marker_block(&out);
        // Guard against a non-shrinking pass (a lone MARKER_START with no
        // matching MARKER_END): if nothing was removed, stop to avoid looping.
        if stripped.len() == out.len() {
            break;
        }
        out = stripped;
    }
    out
}

/// Strip the FIRST `\n?MARKER_START…MARKER_END\n?` occurrence. Returns the input
/// unchanged if there is no complete block. Helper for `strip_marker_block`.
fn strip_first_marker_block(contents: &str) -> String {
    // Find the MARKER_START, optionally preceded by a '\n'.
    let Some(start_idx) = contents.find(MARKER_START) else {
        return contents.to_owned();
    };

    // If there's a '\n' immediately before the marker, include it in the excised range.
    let excise_from = if start_idx > 0 && contents.as_bytes()[start_idx - 1] == b'\n' {
        start_idx - 1
    } else {
        start_idx
    };

    // Find the MARKER_END *after* the start.
    let after_start = start_idx + MARKER_START.len();
    let Some(end_rel) = contents[after_start..].find(MARKER_END) else {
        return contents.to_owned();
    };
    let end_idx = after_start + end_rel + MARKER_END.len();

    // Consume one trailing '\n' if present (the regex `\n?` after MARKER_END).
    let excise_to = if end_idx < contents.len() && contents.as_bytes()[end_idx] == b'\n' {
        end_idx + 1
    } else {
        end_idx
    };

    format!("{}{}", &contents[..excise_from], &contents[excise_to..])
}

// ──────────────────────────────────────────────────────────────────────────────
// Atomic write  (mirrors atomicWrite in completions-install.ts:43-66)
// ──────────────────────────────────────────────────────────────────────────────

/// Unique suffix counter for temp file names. Avoids a `rand`/`tempfile` dep in
/// production code: `<pid>-<counter>` is unique within a process invocation and
/// collisions across independent `tp` processes are prevented by the `create_new`
/// (`O_CREAT|O_EXCL`) open flag.
static ATOMIC_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Write `contents` to `path` atomically (temp-fsync-rename) with the given mode.
///
/// If `mode` is `None` the file is created with mode `0o644` (Bun's default
/// `openSync(tmp, "wx", …)` when no mode is supplied).
fn atomic_write(path: &Path, contents: &str, mode: Option<u32>) -> std::io::Result<()> {
    let mode = mode.unwrap_or(0o644);

    // Build a sibling temp path: `<path>.tp-tmp-<pid>-<counter>`
    let pid = std::process::id();
    let seq = ATOMIC_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = PathBuf::from(format!("{}.tp-tmp-{pid}-{seq}", path.display()));

    let result = (|| -> std::io::Result<()> {
        // O_CREAT | O_EXCL — creates_new prevents races (mirrors openSync "wx").
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;

        // Set permissions before writing the content (mirrors fchmodSync in TS).
        file.set_permissions(fs::Permissions::from_mode(mode))?;

        file.write_all(contents.as_bytes())?;
        file.sync_all()?; // fsyncSync
        drop(file);

        fs::rename(&tmp, path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode preservation (mirrors preservedMode in completions-install.ts:38-41)
// ──────────────────────────────────────────────────────────────────────────────

/// Return the existing file's POSIX permission bits, or `0o644` when the file
/// does not exist yet.
fn preserved_mode(path: &Path) -> u32 {
    match fs::metadata(path) {
        Ok(meta) => meta.permissions().mode() & 0o777,
        Err(_) => 0o644,
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core install / uninstall logic
// ──────────────────────────────────────────────────────────────────────────────

/// Port of `installCompletion` in `completions-install.ts:116-132`.
pub fn install_completion(opts: &InstallOpts<'_>) -> Result<InstallResult, std::io::Error> {
    match opts.shell {
        "bash" | "zsh" => install_rc_line(opts),
        "fish" => install_managed_file(opts),
        _ => unreachable!("install_completion called with unsupported shell"),
    }
}

/// Port of `uninstallCompletion` in `completions-install.ts:168-196`.
pub fn uninstall_completion(opts: &InstallOpts<'_>) -> Result<UninstallResult, std::io::Error> {
    match opts.shell {
        "bash" | "zsh" => {
            let file = rc_file_path(opts.shell, &opts.home);
            if !file.exists() {
                return Ok(UninstallResult::NotInstalled);
            }

            // dry_run: check without locking.
            if opts.dry_run {
                let existing = fs::read_to_string(&file)?;
                if !contains_marker(&existing) {
                    return Ok(UninstallResult::NotInstalled);
                }
                return Ok(UninstallResult::DryRun {
                    plan: format!("Would remove tp completions block from {}", file.display()),
                });
            }

            // Take exclusive advisory lock across the read → rename window.
            let _lock = lock_rc_file(&file)?;

            let existing = fs::read_to_string(&file)?;
            if !contains_marker(&existing) {
                return Ok(UninstallResult::NotInstalled);
            }
            let stripped = strip_marker_block(&existing);
            atomic_write(&file, &stripped, Some(preserved_mode(&file)))?;
            // _lock released here.
            Ok(UninstallResult::Uninstalled { file })
        }
        "fish" => {
            let file = fish_file_path(&opts.home);
            if !file.exists() {
                return Ok(UninstallResult::NotInstalled);
            }
            if opts.dry_run {
                return Ok(UninstallResult::DryRun {
                    plan: format!("Would remove {}", file.display()),
                });
            }
            fs::remove_file(&file)?;
            Ok(UninstallResult::Uninstalled { file })
        }
        _ => unreachable!("uninstall_completion called with unsupported shell"),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Advisory lock for rc-file read-modify-write
// ──────────────────────────────────────────────────────────────────────────────

/// RAII guard holding an exclusive advisory `flock(2)` on a sidecar lock file.
///
/// Serialises concurrent `tp completions install` / `uninstall` invocations
/// against the same rc file.  We lock a *sidecar* file (`<rc>.tp-lock`) rather
/// than the rc file itself because `atomic_write` replaces the rc file's inode
/// via `fs::rename` — flock is per-inode, so locking the rc file directly would
/// let a second process open the freshly-renamed inode and acquire an
/// independent lock with no conflict.  The sidecar has a stable inode (it is
/// never renamed) so it correctly serialises all concurrent writers.
///
/// **Scope of protection**: advisory flock only — this guards concurrent `tp`
/// invocations on the same machine, NOT arbitrary text editors (vim, nano, etc.)
/// which may not acquire an flock before modifying the file.  Users should not
/// edit their rc file at the same time as running `tp completions install`.
/// Uses the same `std::fs::File::lock()` API as `pair_lock.rs` — no extra crate.
struct RcFileLock(File);

impl Drop for RcFileLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Open (or create) the sidecar lock file `<rc_path>.tp-lock` and take a
/// blocking exclusive advisory lock.
///
/// The sidecar file is never renamed, so its inode is stable for the duration
/// of the lock.  Leaving an empty `.tp-lock` file behind is intentional and
/// harmless (the same approach `pair_lock.rs` takes with its lock file).
///
/// Returns the lock guard or an `io::Error` if the open/lock fails.
/// The lock is released when the guard is dropped (after `atomic_write` renames
/// the temp file into place).
fn lock_rc_file(rc_path: &Path) -> std::io::Result<RcFileLock> {
    // Build the sidecar path: <rc_path>.tp-lock
    // e.g. ~/.zshrc  →  ~/.zshrc.tp-lock
    let sidecar = PathBuf::from(format!("{}.tp-lock", rc_path.display()));
    // Open/create the sidecar.  We only hold the lock; we never write through
    // this fd.  The sidecar is never renamed, so its inode is stable.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&sidecar)?;
    // Blocking exclusive lock — waits for any concurrent `tp` writer to finish.
    // File::lock() returns Result<(), io::Error> (stabilized in Rust 1.89).
    file.lock()?;
    Ok(RcFileLock(file))
}

// ──────────────────────────────────────────────────────────────────────────────
// Install helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Port of `installRcLine` in `completions-install.ts:134-166`.
fn install_rc_line(opts: &InstallOpts<'_>) -> Result<InstallResult, std::io::Error> {
    let file = rc_file_path(opts.shell, &opts.home);
    let line = format!(r#"eval "$(tp completions {})""#, opts.shell);
    let block = marker_block(&line);

    // dry_run: read current state without locking (no mutation follows).
    if opts.dry_run {
        let existing = if file.exists() {
            fs::read_to_string(&file)?
        } else {
            String::new()
        };
        let has_marker = contains_marker(&existing);
        let action = if has_marker && !opts.force {
            "Would skip (already installed)"
        } else if has_marker {
            "Would rewrite tp completions block in"
        } else {
            "Would append tp completions block to"
        };
        return Ok(InstallResult::DryRun {
            plan: format!("{action} {}", file.display()),
        });
    }

    // Take an exclusive advisory lock across the read → rename window to prevent
    // a concurrent writer from being clobbered by our atomic_write rename.
    // CLAUDE.md: "avoid editing rc/Profile file during installation".
    let _lock = lock_rc_file(&file)?;

    let existing = if file.exists() {
        fs::read_to_string(&file)?
    } else {
        String::new()
    };
    let has_marker = contains_marker(&existing);

    if has_marker && !opts.force {
        return Ok(InstallResult::AlreadyInstalled { file });
    }

    let base = if has_marker {
        strip_marker_block(&existing)
    } else {
        existing
    };
    // completions-install.ts:162: base.endsWith("\n") || base === "" ? base : `${base}\n`
    let prefix = if base.is_empty() || base.ends_with('\n') {
        base
    } else {
        format!("{base}\n")
    };
    let next = format!("{prefix}{block}");

    atomic_write(&file, &next, Some(preserved_mode(&file)))?;
    // _lock is released here (after rename completed).
    Ok(InstallResult::Installed { file })
}

/// Port of `installManagedFile` in `completions-install.ts:80-94`.
fn install_managed_file(opts: &InstallOpts<'_>) -> Result<InstallResult, std::io::Error> {
    let file = fish_file_path(&opts.home);

    if opts.dry_run {
        return Ok(InstallResult::DryRun {
            plan: format!("Would write {}", file.display()),
        });
    }
    if file.exists() && !opts.force {
        return Ok(InstallResult::AlreadyInstalled { file });
    }

    // Ensure parent directory exists (mirrors mkdirSync recursive).
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }

    let contents = format!("{}\n", generate_fish_pub());
    atomic_write(&file, &contents, Some(0o644))?;
    Ok(InstallResult::Installed { file })
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI dispatch entry point
// ──────────────────────────────────────────────────────────────────────────────

const INSTALL_USAGE: &str = "Usage: tp completions install [shell] [flags]

Shells: bash, zsh, fish
Flags:
  --force                Overwrite existing installation
  --uninstall            Remove installed completions
  --dry-run              Show what would change without writing
  --help, -h             Show this help

Notes:
  Fish writes completion files to disk; rerun
  'tp completions install fish --force' after 'tp upgrade' to refresh.";

/// Dispatch `tp completions install [args…]` or `tp completions uninstall [args…]`.
///
/// `is_uninstall_subcommand`: `true` when the caller was `tp completions
/// uninstall …`. Intent is the LOGICAL-OR of that and a `--uninstall` flag in
/// `args`, mirroring the retired Bun CLI's reference behavior exactly (deleted
/// in #5 PR6 #933 — visible in git history): the `uninstall` subcommand was
/// dispatched as `runInstall(["--uninstall", …])` (completions.ts:102-104) and
/// `runInstall` derived intent purely from `argv.includes("--uninstall")`
/// (completions.ts:140). So `tp completions install <shell> --uninstall`
/// uninstalls — the advertised `--uninstall` flag works on the `install`
/// subcommand too, not just as a no-op on the allowlist.
/// `args`: the remaining args after `install`/`uninstall` (shell + flags).
pub fn run(is_uninstall_subcommand: bool, args: &[String]) -> ExitCode {
    // Help flag (mirrors completions.ts:132-135).
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{INSTALL_USAGE}");
        return ExitCode::SUCCESS;
    }

    let force = args.iter().any(|a| a == "--force");
    let dry_run = args.iter().any(|a| a == "--dry-run");
    // Intent = subcommand OR the `--uninstall` flag (completions.ts:140).
    let is_uninstall = is_uninstall_subcommand || args.iter().any(|a| a == "--uninstall");

    // Unknown flag check (mirrors completions.ts:143-148).
    const ALLOWLIST: &[&str] = &["--force", "--dry-run", "--uninstall", "--help", "-h"];
    for a in args {
        if a.starts_with('-') && a != "-" && !ALLOWLIST.contains(&a.as_str()) {
            eprintln!("Unknown flag: {a}");
            eprintln!("{INSTALL_USAGE}");
            return ExitCode::FAILURE;
        }
    }

    // Positional shell arg (first non-flag arg).
    let positional = args.iter().find(|a| !a.starts_with('-'));

    // Detect shell (mirrors completions.ts:154-165).
    let shell_owned: String;
    let shell: &str = match positional {
        Some(s) => s.as_str(),
        None => match detect_shell() {
            Some(s) => {
                shell_owned = s;
                &shell_owned
            }
            None => {
                let hint = match std::env::var("SHELL") {
                    Ok(v) => format!("Detected $SHELL={v} (unsupported)."),
                    Err(_) => {
                        "$SHELL is not set and no $ZSH_VERSION / $BASH_VERSION / $FISH_VERSION detected.".to_owned()
                    }
                };
                eprintln!(
                    "Could not detect shell. {hint} Run 'tp completions install <bash|zsh|fish>'."
                );
                return ExitCode::FAILURE;
            }
        },
    };

    // Validate shell name.
    if !matches!(shell, "bash" | "zsh" | "fish") {
        eprintln!("Unknown shell: {shell}");
        eprintln!("Supported: bash, zsh, fish");
        return ExitCode::FAILURE;
    }

    let home = match home_dir() {
        Some(h) => h,
        None => {
            eprintln!("tp completions install: cannot determine home directory ($HOME unset)");
            return ExitCode::FAILURE;
        }
    };

    let opts = InstallOpts {
        shell,
        home,
        force,
        dry_run,
    };

    if is_uninstall {
        match uninstall_completion(&opts) {
            Err(e) => {
                eprintln!("tp completions uninstall: {e}");
                ExitCode::FAILURE
            }
            Ok(UninstallResult::DryRun { plan }) => {
                println!("{plan}");
                ExitCode::SUCCESS
            }
            Ok(UninstallResult::Uninstalled { file }) => {
                eprintln!("tp completions removed for {shell} ({})", file.display());
                ExitCode::SUCCESS
            }
            Ok(UninstallResult::NotInstalled) => {
                eprintln!("tp completions not installed for {shell}");
                ExitCode::SUCCESS
            }
        }
    } else {
        match install_completion(&opts) {
            Err(e) => {
                eprintln!("tp completions install: {e}");
                ExitCode::FAILURE
            }
            Ok(InstallResult::DryRun { plan }) => {
                println!("{plan}");
                ExitCode::SUCCESS
            }
            Ok(InstallResult::AlreadyInstalled { file }) => {
                eprintln!(
                    "tp completions already installed for {shell} ({})",
                    file.display()
                );
                ExitCode::SUCCESS
            }
            Ok(InstallResult::Installed { file }) => {
                eprintln!("tp completions installed for {shell} ({})", file.display());
                eprintln!("Restart your shell or source your rc file to activate.");
                ExitCode::SUCCESS
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Home directory helper
// ──────────────────────────────────────────────────────────────────────────────

/// Return the user's home directory from `$HOME`. Equivalent to the POSIX
/// branch of Node's `os.homedir()` (which is what the Bun CLI uses; the
/// Win32 branch is unreachable — this CLI is POSIX-only).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests — port of the retired Bun CLI's completions-install.test.ts (219 lines
// → all branches covered; deleted in #5 PR6 #933 — visible in git history).
// The `completions-install.test.ts:*` line citations below are historical
// provenance for where each case came from, not a live reference.
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, metadata};
    use std::os::unix::fs::PermissionsExt as _;
    use tempfile::TempDir;

    fn temp_home() -> TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn opts_for<'a>(shell: &'a str, home: &TempDir, force: bool, dry_run: bool) -> InstallOpts<'a> {
        InstallOpts {
            shell,
            home: home.path().to_path_buf(),
            force,
            dry_run,
        }
    }

    // ── bash install ──────────────────────────────────────────────────────────

    /// completions-install.test.ts:26-34
    #[test]
    fn bash_writes_marker_block_when_file_missing() {
        let home = temp_home();
        let r = install_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r, InstallResult::Installed { .. }));

        let bashrc = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        assert!(bashrc.contains(MARKER_START));
        assert!(bashrc.contains(r#"eval "$(tp completions bash)""#));
        assert!(bashrc.contains(MARKER_END));
    }

    /// completions-install.test.ts:36-42
    #[test]
    fn bash_appends_block_preserving_existing_content() {
        let home = temp_home();
        fs::write(home.path().join(".bashrc"), "export EDITOR=vim\n").unwrap();
        install_completion(&opts_for("bash", &home, false, false)).unwrap();
        let bashrc = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        assert!(bashrc.starts_with("export EDITOR=vim\n"));
        assert!(bashrc.contains(MARKER_START));
    }

    /// completions-install.test.ts:44-51
    #[test]
    fn bash_is_idempotent() {
        let home = temp_home();
        install_completion(&opts_for("bash", &home, false, false)).unwrap();
        let before = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        let r = install_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r, InstallResult::AlreadyInstalled { .. }));
        let after = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        assert_eq!(after, before);
    }

    /// completions-install.test.ts:53-60
    #[test]
    fn bash_force_rewrites_no_duplicate() {
        let home = temp_home();
        install_completion(&opts_for("bash", &home, false, false)).unwrap();
        let r = install_completion(&opts_for("bash", &home, true, false)).unwrap();
        assert!(matches!(r, InstallResult::Installed { .. }));
        let bashrc = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        let count = bashrc.matches("# >>> tp completions").count();
        assert_eq!(count, 1);
    }

    /// completions-install.test.ts:62-67
    #[test]
    fn bash_dry_run_no_write() {
        let home = temp_home();
        let r = install_completion(&opts_for("bash", &home, false, true)).unwrap();
        assert!(matches!(r, InstallResult::DryRun { .. }));
        if let InstallResult::DryRun { plan } = r {
            assert!(plan.contains(".bashrc"));
        }
        assert!(!home.path().join(".bashrc").exists());
    }

    // ── bash uninstall ────────────────────────────────────────────────────────

    /// completions-install.test.ts:71-77
    #[test]
    fn bash_uninstall_removes_block_preserves_content() {
        let home = temp_home();
        fs::write(home.path().join(".bashrc"), "export EDITOR=vim\n").unwrap();
        install_completion(&opts_for("bash", &home, false, false)).unwrap();
        let r = uninstall_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r, UninstallResult::Uninstalled { .. }));
        let bashrc = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        assert_eq!(bashrc, "export EDITOR=vim\n");
    }

    /// completions-install.test.ts:79-83
    #[test]
    fn bash_uninstall_not_installed_when_nothing_exists() {
        let home = temp_home();
        let r = uninstall_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r, UninstallResult::NotInstalled));
    }

    /// completions-install.test.ts:79-83 (marker absent variant)
    #[test]
    fn bash_uninstall_not_installed_when_marker_absent() {
        let home = temp_home();
        fs::write(home.path().join(".bashrc"), "export FOO=bar\n").unwrap();
        let r = uninstall_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r, UninstallResult::NotInstalled));
    }

    // ── zsh install ───────────────────────────────────────────────────────────

    /// completions-install.test.ts:87-91
    #[test]
    fn zsh_writes_marker_block() {
        let home = temp_home();
        install_completion(&opts_for("zsh", &home, false, false)).unwrap();
        let zshrc = fs::read_to_string(home.path().join(".zshrc")).unwrap();
        assert!(zshrc.contains(r#"eval "$(tp completions zsh)""#));
    }

    // ── POSIX mode bits ───────────────────────────────────────────────────────

    /// completions-install.test.ts:95-102
    #[test]
    fn zsh_preserves_existing_mode() {
        let home = temp_home();
        let zshrc = home.path().join(".zshrc");
        fs::write(&zshrc, "# prior\n").unwrap();
        fs::set_permissions(&zshrc, fs::Permissions::from_mode(0o600)).unwrap();
        install_completion(&opts_for("zsh", &home, false, false)).unwrap();
        let mode = metadata(&zshrc).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    /// completions-install.test.ts:104-108
    #[test]
    fn new_bashrc_gets_mode_644() {
        let home = temp_home();
        install_completion(&opts_for("bash", &home, false, false)).unwrap();
        let mode = metadata(home.path().join(".bashrc"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o644);
    }

    // ── dry-run discrimination ────────────────────────────────────────────────

    /// completions-install.test.ts:111-128
    #[test]
    fn dry_run_distinguishes_fresh_already_force() {
        let home = temp_home();

        let fresh = install_completion(&opts_for("bash", &home, false, true)).unwrap();
        if let InstallResult::DryRun { plan } = fresh {
            assert!(plan.contains("Would append"));
        } else {
            panic!("expected DryRun");
        }

        install_completion(&opts_for("bash", &home, false, false)).unwrap();

        let skip = install_completion(&opts_for("bash", &home, false, true)).unwrap();
        if let InstallResult::DryRun { plan } = skip {
            assert!(plan.contains("Would skip"));
        } else {
            panic!("expected DryRun");
        }

        let rewrite = install_completion(&opts_for("bash", &home, true, true)).unwrap();
        if let InstallResult::DryRun { plan } = rewrite {
            assert!(plan.contains("Would rewrite"));
        } else {
            panic!("expected DryRun");
        }
    }

    // ── fish install ──────────────────────────────────────────────────────────

    /// completions-install.test.ts:131-138
    #[test]
    fn fish_creates_managed_file() {
        let home = temp_home();
        let r = install_completion(&opts_for("fish", &home, false, false)).unwrap();
        assert!(matches!(r, InstallResult::Installed { .. }));
        let file = home
            .path()
            .join(".config")
            .join("fish")
            .join("completions")
            .join("tp.fish");
        assert!(file.exists());
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("complete -c tp"));
    }

    /// completions-install.test.ts:140-143
    #[test]
    fn fish_is_idempotent() {
        let home = temp_home();
        install_completion(&opts_for("fish", &home, false, false)).unwrap();
        let r = install_completion(&opts_for("fish", &home, false, false)).unwrap();
        assert!(matches!(r, InstallResult::AlreadyInstalled { .. }));
    }

    /// completions-install.test.ts:145-155
    #[test]
    fn fish_force_rewrites_stale_file() {
        let home = temp_home();
        let file = home
            .path()
            .join(".config")
            .join("fish")
            .join("completions")
            .join("tp.fish");
        install_completion(&opts_for("fish", &home, false, false)).unwrap();
        fs::write(&file, "stale content\n").unwrap();
        let r = install_completion(&opts_for("fish", &home, true, false)).unwrap();
        assert!(matches!(r, InstallResult::Installed { .. }));
        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("complete -c tp"));
        assert!(!content.contains("stale content"));
    }

    /// completions-install.test.ts:157-163
    #[test]
    fn fish_dry_run_does_not_create_file() {
        let home = temp_home();
        let r = install_completion(&opts_for("fish", &home, false, true)).unwrap();
        assert!(matches!(r, InstallResult::DryRun { .. }));
        let file = home
            .path()
            .join(".config")
            .join("fish")
            .join("completions")
            .join("tp.fish");
        assert!(!file.exists());
    }

    // ── fish uninstall ────────────────────────────────────────────────────────

    /// completions-install.test.ts:167-174
    #[test]
    fn fish_uninstall_removes_managed_file() {
        let home = temp_home();
        install_completion(&opts_for("fish", &home, false, false)).unwrap();
        let r = uninstall_completion(&opts_for("fish", &home, false, false)).unwrap();
        assert!(matches!(r, UninstallResult::Uninstalled { .. }));
        let file = home
            .path()
            .join(".config")
            .join("fish")
            .join("completions")
            .join("tp.fish");
        assert!(!file.exists());
    }

    /// completions-install.test.ts:176-179
    #[test]
    fn fish_uninstall_not_installed_when_absent() {
        let home = temp_home();
        let r = uninstall_completion(&opts_for("fish", &home, false, false)).unwrap();
        assert!(matches!(r, UninstallResult::NotInstalled));
    }

    // ── full cycle ────────────────────────────────────────────────────────────

    /// completions-install.test.ts:183-202
    #[test]
    fn bash_full_cycle_install_force_uninstall_install() {
        let home = temp_home();
        let bashrc = home.path().join(".bashrc");

        let r1 = install_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r1, InstallResult::Installed { .. }));
        assert!(fs::read_to_string(&bashrc)
            .unwrap()
            .contains("tp completions bash"));

        let r2 = install_completion(&opts_for("bash", &home, true, false)).unwrap();
        assert!(matches!(r2, InstallResult::Installed { .. }));
        let after_force = fs::read_to_string(&bashrc).unwrap();
        assert!(after_force.contains("tp completions bash"));
        assert_eq!(after_force.matches("# >>> tp completions").count(), 1);

        let r3 = uninstall_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r3, UninstallResult::Uninstalled { .. }));
        assert!(!fs::read_to_string(&bashrc)
            .unwrap()
            .contains("# >>> tp completions"));

        let r4 = install_completion(&opts_for("bash", &home, false, false)).unwrap();
        assert!(matches!(r4, InstallResult::Installed { .. }));
        assert!(fs::read_to_string(&bashrc)
            .unwrap()
            .contains("tp completions bash"));
    }

    /// completions-install.test.ts:204-218
    #[test]
    fn fish_full_cycle_install_force_uninstall_install() {
        let home = temp_home();
        let file = home
            .path()
            .join(".config")
            .join("fish")
            .join("completions")
            .join("tp.fish");

        assert!(matches!(
            install_completion(&opts_for("fish", &home, false, false)).unwrap(),
            InstallResult::Installed { .. }
        ));
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("complete -c tp"));

        assert!(matches!(
            install_completion(&opts_for("fish", &home, true, false)).unwrap(),
            InstallResult::Installed { .. }
        ));
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("complete -c tp"));

        assert!(matches!(
            uninstall_completion(&opts_for("fish", &home, false, false)).unwrap(),
            UninstallResult::Uninstalled { .. }
        ));
        assert!(!file.exists());

        assert!(matches!(
            install_completion(&opts_for("fish", &home, false, false)).unwrap(),
            InstallResult::Installed { .. }
        ));
        assert!(fs::read_to_string(&file)
            .unwrap()
            .contains("complete -c tp"));
    }

    // ── strip_marker_block unit tests ─────────────────────────────────────────

    #[test]
    fn strip_marker_block_round_trips() {
        let original = "export FOO=bar\n";
        let block = marker_block(r#"eval "$(tp completions bash)""#);
        let combined = format!("{original}{block}");
        let stripped = strip_marker_block(&combined);
        assert_eq!(stripped, original);
    }

    #[test]
    fn strip_marker_block_no_marker_is_noop() {
        let s = "no markers here\n";
        assert_eq!(strip_marker_block(s), s);
    }

    /// Global-strip parity with the TS `g`-flag regex
    /// (`completions-install.test.ts` self-heal semantics): a file that somehow
    /// contains TWO marker blocks (corruption / hand-edit) is fully cleaned —
    /// both blocks removed, surrounding content preserved. The old single-pass
    /// strip left the second block behind (a stale completion hook).
    #[test]
    fn strip_marker_block_removes_all_duplicate_blocks() {
        let block = marker_block(r#"eval "$(tp completions bash)""#);
        // user content, block, more content, a duplicate block, trailing content
        let combined = format!("export A=1\n{block}export B=2\n{block}export C=3\n");
        let stripped = strip_marker_block(&combined);
        assert!(
            !contains_marker(&stripped),
            "all marker blocks must be removed"
        );
        assert_eq!(stripped, "export A=1\nexport B=2\nexport C=3\n");
    }

    /// `install --force` over a file with duplicate blocks self-heals to exactly
    /// ONE block (strip-all then append one), matching the Bun reference.
    #[test]
    fn install_force_self_heals_duplicate_blocks_to_single() {
        let home = temp_home();
        let block = marker_block(r#"eval "$(tp completions bash)""#);
        // Seed a corrupted .bashrc with two managed blocks.
        fs::write(
            home.path().join(".bashrc"),
            format!("export EDITOR=vim\n{block}{block}"),
        )
        .unwrap();
        install_completion(&opts_for("bash", &home, true, false)).unwrap();
        let bashrc = fs::read_to_string(home.path().join(".bashrc")).unwrap();
        let count = bashrc.matches(MARKER_START).count();
        assert_eq!(count, 1, "force install must collapse to a single block");
        assert!(bashrc.contains("export EDITOR=vim"));
    }
}
