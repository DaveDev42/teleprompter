//! User-configurable claude launch command (`config.json` `claudeCommand`).
//!
//! Lets an operator point `tp-runner` (and the `tp` passthrough preflight) at
//! a wrapper binary (e.g. `csm run --profile foo --`) instead of the literal
//! `claude` binary, without a code change or a new CLI flag.
//!
//! # Why this lives in `tp-proto` (not `tp-cli`)
//!
//! Both `tp-cli` (the passthrough preflight + `tp doctor`) and `tp-runner`
//! (the actual spawn site) need the SAME resolution — a drift here would mean
//! `tp doctor` reports a command that `tp-runner` doesn't actually spawn.
//! `tp-runner` cannot depend on `tp-cli` (wrong direction — `tp-cli` locates
//! and spawns `tp-runner`, not the reverse), and both already depend on
//! `tp-proto`. This is the same shared-resolver rationale as
//! [`crate::locate::locate_tp_runner`] (see that module's doc comment).
//!
//! `config_file_path` necessarily duplicates the directory-resolution
//! algorithm in `tp-cli/src/config_dir.rs` (byte-identical: `$XDG_CONFIG_HOME`
//! else `$HOME/.config` else `/tmp/.config`, joined with `teleprompter`) —
//! `tp-proto` cannot import from `tp-cli` for the same dependency-direction
//! reason above. This is the same documented duplication precedent as
//! `tp-cli/src/store.rs` mirroring `tp-daemon/src/store/config.rs`.
//!
//! # Schema
//!
//! ```json
//! { "claudeCommand": ["/opt/homebrew/bin/csm", "run", "--profile", "work", "--"] }
//! ```
//!
//! The first token is the binary (absolute path or a bare `PATH` name); the
//! rest are prefix args placed before the `--settings <json>` tp injects and
//! the caller's own claude args — so a trailing `--` in the configured
//! command routes everything after it into a wrapper's passthrough section.
//!
//! # Precedence (first match wins)
//!
//! 1. `TP_RUNNER_CLAUDE_BIN` env override — the existing test/debug seam.
//!    Single binary, no prefix args (byte-identical to its pre-config
//!    semantics); the config file is not even read.
//! 2. `config.json`'s `claudeCommand`, if the file exists.
//! 3. Default: `["claude"]`.
//!
//! # Error semantics (fail closed for explicit config)
//!
//! - Config file missing → default (most operators have none).
//! - Config file present but malformed JSON → hard error, message includes
//!   the config path.
//! - `claudeCommand` present but not an array of strings, or an empty array,
//!   or the first token is empty → hard error, message includes the path.
//! - `claudeCommand` key absent (file has other keys, or is `{}`) → default.
//!
//! A hard error never silently falls back to `"claude"` — a broken wrapper
//! config should fail loud at this well-labeled boundary, not deep inside a
//! PTY spawn or (worse) silently launch the wrong binary.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Where a resolved claude command came from — used by callers (the `tp
/// doctor` check, the passthrough preflight) that need to explain *why* a
/// particular binary was chosen, or decide whether it is safe to probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeCommandSource {
    /// No env override, no `claudeCommand` in config (or no config file) —
    /// the literal `["claude"]`.
    Default,
    /// `TP_RUNNER_CLAUDE_BIN` env var.
    EnvOverride,
    /// `claudeCommand` array from `config.json`.
    Config,
}

/// Resolve `$XDG_CONFIG_HOME/teleprompter/config.json` (or
/// `$HOME/.config/teleprompter/config.json`, falling back to
/// `/tmp/.config/teleprompter/config.json` when `$HOME` is unset).
///
/// See the module doc for why this duplicates (rather than imports)
/// `tp-cli`'s `config_dir()` algorithm.
#[must_use]
pub fn config_file_path() -> PathBuf {
    let base = match std::env::var("XDG_CONFIG_HOME") {
        Ok(v) => PathBuf::from(v),
        Err(_) => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".config")
        }
    };
    base.join("teleprompter").join("config.json")
}

/// Resolve the claude launch command tokens: `[binary, prefix_args...]`.
///
/// `config_path` is read here (not pre-read into a string by the caller) so
/// real call sites don't need their own file-IO/error-formatting
/// boilerplate; tests pass a tempdir path — no process-global env mutation
/// needed for the config-file half of resolution (only `env_override` reads
/// an env var, and that is passed in explicitly by the caller).
///
/// See the module doc for the full precedence + error-semantics contract.
///
/// # Errors
/// Returns `Err(String)` (always containing `config_path`'s display form)
/// when the file exists but is malformed JSON, or its `claudeCommand` value
/// is present but not a non-empty array of non-empty strings.
pub fn resolve_claude_command(
    env_override: Option<String>,
    config_path: &Path,
) -> Result<(Vec<String>, ClaudeCommandSource), String> {
    if let Some(bin) = env_override {
        return Ok((vec![bin], ClaudeCommandSource::EnvOverride));
    }

    let contents = match std::fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok((default_command(), ClaudeCommandSource::Default));
        }
        Err(e) => return Err(format!("failed to read {}: {e}", config_path.display())),
    };

    let value: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("malformed JSON in {}: {e}", config_path.display()))?;

    let Some(obj) = value.as_object() else {
        return Err(format!(
            "{} must contain a JSON object",
            config_path.display()
        ));
    };

    let Some(raw) = obj.get("claudeCommand") else {
        return Ok((default_command(), ClaudeCommandSource::Default));
    };

    let Some(arr) = raw.as_array() else {
        return Err(format!(
            "{}: \"claudeCommand\" must be an array of strings",
            config_path.display()
        ));
    };

    if arr.is_empty() {
        return Err(format!(
            "{}: \"claudeCommand\" must not be empty",
            config_path.display()
        ));
    }

    let mut tokens = Vec::with_capacity(arr.len());
    for (i, v) in arr.iter().enumerate() {
        let Some(s) = v.as_str() else {
            return Err(format!(
                "{}: \"claudeCommand\"[{i}] must be a string",
                config_path.display()
            ));
        };
        tokens.push(s.to_string());
    }

    if tokens[0].is_empty() {
        return Err(format!(
            "{}: \"claudeCommand\"[0] (the binary) must not be empty",
            config_path.display()
        ));
    }

    Ok((tokens, ClaudeCommandSource::Config))
}

fn default_command() -> Vec<String> {
    vec!["claude".to_string()]
}

/// Whether `bin` (typically the first token of a resolved claude command)
/// resolves to an executable, WITHOUT ever spawning it — safe to call on an
/// arbitrary configured wrapper (unlike a `--version` probe, which could
/// launch a full interactive session if the wrapper doesn't understand that
/// flag).
///
/// - A path containing a separator (`/`) is checked directly: must exist and
///   (on Unix) have at least one exec bit set.
/// - A bare name is searched against `$PATH`, mirroring shell `command -v`
///   semantics (`std::env::split_paths`).
#[must_use]
pub fn command_resolves_to_executable(bin: &str) -> bool {
    if bin.contains('/') {
        return is_executable_file(Path::new(bin));
    }
    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path_var).any(|dir| is_executable_file(&dir.join(bin)))
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_config(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("config.json");
        std::fs::write(&p, body).unwrap();
        p
    }

    // ── resolve_claude_command ───────────────────────────────────────────────

    #[test]
    fn no_config_file_defaults_to_claude() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("config.json"); // never written
        let (tokens, source) = resolve_claude_command(None, &missing).unwrap();
        assert_eq!(tokens, vec!["claude".to_string()]);
        assert_eq!(source, ClaudeCommandSource::Default);
    }

    #[test]
    fn env_override_wins_over_config_and_skips_file_read() {
        let dir = tempfile::tempdir().unwrap();
        // A config file exists AND is malformed — env override must still win
        // (and must not even attempt to parse it).
        let path = write_config(dir.path(), "{ not json");
        let (tokens, source) = resolve_claude_command(Some("/opt/csm".to_string()), &path).unwrap();
        assert_eq!(tokens, vec!["/opt/csm".to_string()]);
        assert_eq!(source, ClaudeCommandSource::EnvOverride);
    }

    #[test]
    fn valid_config_is_parsed_with_prefix_args() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            r#"{"claudeCommand":["/opt/homebrew/bin/csm","run","--profile","work","--"]}"#,
        );
        let (tokens, source) = resolve_claude_command(None, &path).unwrap();
        assert_eq!(
            tokens,
            vec![
                "/opt/homebrew/bin/csm".to_string(),
                "run".to_string(),
                "--profile".to_string(),
                "work".to_string(),
                "--".to_string(),
            ]
        );
        assert_eq!(source, ClaudeCommandSource::Config);
    }

    #[test]
    fn malformed_json_errors_and_mentions_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "{ this is not json");
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn empty_array_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"claudeCommand":[]}"#);
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains("claudeCommand"), "{err}");
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn non_string_entry_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"claudeCommand":["claude", 5]}"#);
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn non_array_claude_command_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"claudeCommand":"claude"}"#);
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn empty_first_token_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"claudeCommand":[""]}"#);
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    #[test]
    fn missing_key_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"{"otherKey":true}"#);
        let (tokens, source) = resolve_claude_command(None, &path).unwrap();
        assert_eq!(tokens, vec!["claude".to_string()]);
        assert_eq!(source, ClaudeCommandSource::Default);
    }

    #[test]
    fn non_object_root_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), r#"["not","an","object"]"#);
        let err = resolve_claude_command(None, &path).unwrap_err();
        assert!(err.contains(&path.display().to_string()), "{err}");
    }

    // ── config_file_path ─────────────────────────────────────────────────────

    #[test]
    fn config_file_path_ends_with_teleprompter_config_json() {
        let p = config_file_path();
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("config.json"));
        assert_eq!(
            p.parent()
                .and_then(|d| d.file_name())
                .and_then(|s| s.to_str()),
            Some("teleprompter")
        );
    }

    // ── command_resolves_to_executable ───────────────────────────────────────

    #[test]
    fn path_with_separator_checks_file_directly() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("mybin");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(command_resolves_to_executable(bin.to_str().unwrap()));
    }

    #[test]
    fn path_with_separator_missing_file_is_false() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("does-not-exist");
        assert!(!command_resolves_to_executable(bin.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn path_with_separator_non_executable_is_false() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("not-exec");
        std::fs::write(&bin, "not a script").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!command_resolves_to_executable(bin.to_str().unwrap()));
    }

    #[test]
    fn bare_name_on_real_path_resolves_true() {
        // `sh` is POSIX-guaranteed to be on `$PATH` in any environment this
        // workspace builds in — a plain existence+PATH-search check, not an
        // exec, and (unlike setting `$PATH` to a fake tempdir) doesn't mutate
        // process-global env that other tests in this file read concurrently.
        assert!(command_resolves_to_executable("sh"));
    }

    #[test]
    fn bare_name_not_on_path_is_false() {
        assert!(!command_resolves_to_executable(
            "__tp_user_config_nonexistent_binary__"
        ));
    }
}
