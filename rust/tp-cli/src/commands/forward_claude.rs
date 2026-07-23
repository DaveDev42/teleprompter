//! Native `claude` forwarding for util subcommands + `tp -- <args>` (task #17
//! PR-6) — the de-trampolined daemon-bypass path.
//!
//! Replaces the Bun `forwardToClaudeCommand` (`apps/cli/src/commands/
//! forward-claude.ts`) for two `decide_route` arms that previously execed the
//! Bun blob:
//!
//! - **Claude utility subcommands** — `auth`, `mcp`, `install`, `update`,
//!   `agents`, `auto-mode`, `plugin`, `plugins`, `setup-token`. These just hand
//!   off to `claude <subcommand> …` with no daemon/runner involved.
//! - **`tp -- <args>`** — an explicit direct-forward to `claude`, daemon-bypass.
//!
//! Neither needs the daemon, the session-db, or the blob — they exec `claude`
//! directly. This removed the last two blob dependencies that are pure
//! claude-forwards. (The then-remaining blob routes, `run`/`relay`, were
//! de-trampolined by #8 and #25, and the blob itself + its `Route::Forward`
//! path were deleted in #5 PR6.)
//!
//! # argv shape
//!
//! The handler receives `args[1..]` (everything after the `tp` binary name):
//! - util subcommand: `tp auth login` → `["auth", "login"]` — the whole slice
//!   goes to `claude` verbatim (the subcommand name IS a `claude` subcommand).
//!   Mirror of the Bun `forwardToClaudeCommand(process.argv.slice(2))` call.
//! - `--`: `tp -- -p hello` → `["--", "-p", "hello"]` — the leading `--` is
//!   stripped and only `["-p", "hello"]` goes to `claude`. Mirror of the Bun
//!   `forwardToClaudeCommand(process.argv.slice(3))` call.
//!
//! # exec-replace
//!
//! Like the other exec routes (`relay::exec_relay`, `run::exec_runner`), this
//! uses `exec()` to replace
//! the process image with `claude`, inheriting stdio, the TTY, and signals — so
//! the exit code propagates naturally and there is no wait/relay layer. On any
//! error before/at exec (claude missing, exec syscall failure) it prints a
//! friendly message and returns `ExitCode::FAILURE`.

use std::process::ExitCode;

use crate::format::error_with_hints;

/// Forward to `claude`, replacing the process image. `args_after_tp` is
/// `std::env::args()[1..]` — the caller passes the full post-binary argv and
/// this strips a leading `--` (the `tp -- <args>` daemon-bypass form).
///
/// Returns `ExitCode::FAILURE` only on a setup error (claude missing) or an exec
/// syscall failure; on success `exec()` never returns.
pub fn run(args_after_tp: &[String]) -> ExitCode {
    // Strip a leading `--` (the explicit `tp -- <claude args>` form). For util
    // subcommands the slice has no leading `--`, so the whole thing forwards.
    let claude_args: &[String] = match args_after_tp.first() {
        Some(first) if first == "--" => &args_after_tp[1..],
        _ => args_after_tp,
    };

    // Preflight: `claude --version` must succeed (PATH probe). Byte-exact message
    // parity with the Bun `forwardToClaudeCommand` not-found path.
    if !claude_available() {
        eprintln!(
            "{}",
            error_with_hints(
                "Claude Code CLI not found.",
                &[
                    "Install: https://docs.anthropic.com/en/docs/claude-code",
                    "Or: npm install -g @anthropic-ai/claude-code",
                ],
            )
        );
        return ExitCode::FAILURE;
    }

    exec_claude(claude_args)
}

/// Whether `claude --version` runs successfully (PATH probe). Mirrors the
/// retired Bun CLI's `Bun.spawnSync(["claude","--version"])` preflight
/// (forward-claude.ts:18-26, deleted in #5 PR6 #933 — visible in git history).
fn claude_available() -> bool {
    std::process::Command::new("claude")
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Exec `claude <args>`, replacing the process image (inherits stdio + TTY +
/// signals). Returns only on an exec syscall error.
#[cfg(unix)]
fn exec_claude(claude_args: &[String]) -> ExitCode {
    use std::os::unix::process::CommandExt;

    // exec() replaces the process image — `claude` inherits our stdio and TTY,
    // and its exit code becomes ours. Returns only if the exec syscall fails
    // (e.g. EACCES, ENOEXEC) — a not-found is already handled by the preflight.
    let err = std::process::Command::new("claude")
        .args(claude_args)
        .exec();
    eprintln!("tp: failed to exec claude: {err}");
    ExitCode::FAILURE
}

/// Stub for non-Unix targets (tp is POSIX-only).
#[cfg(not(unix))]
fn exec_claude(_claude_args: &[String]) -> ExitCode {
    eprintln!("tp: claude forwarding is only supported on POSIX platforms");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The leading-`--` strip: `tp -- -p x` forwards only `["-p", "x"]` to
    /// claude, mirroring the retired Bun CLI's `slice(3)`. A util subcommand
    /// slice (no leading `--`) forwards verbatim, mirroring `slice(2)`.
    fn strip_leading_dashdash(args: &[String]) -> &[String] {
        match args.first() {
            Some(first) if first == "--" => &args[1..],
            _ => args,
        }
    }

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn dashdash_is_stripped() {
        let args = v(&["--", "-p", "hello"]);
        assert_eq!(strip_leading_dashdash(&args), &["-p", "hello"]);
    }

    #[test]
    fn util_subcommand_forwards_verbatim() {
        let args = v(&["auth", "login"]);
        assert_eq!(strip_leading_dashdash(&args), &["auth", "login"]);
    }

    #[test]
    fn only_leading_dashdash_stripped_not_inner() {
        // `tp -- claude -- x` → strip the FIRST `--`, keep the inner one.
        let args = v(&["--", "claude", "--", "x"]);
        assert_eq!(strip_leading_dashdash(&args), &["claude", "--", "x"]);
    }

    #[test]
    fn bare_dashdash_forwards_empty() {
        // `tp --` → claude with no extra args (launches interactive claude).
        let args = v(&["--"]);
        assert_eq!(strip_leading_dashdash(&args), &[] as &[String]);
    }

    #[test]
    fn empty_slice_is_noop() {
        let args: Vec<String> = Vec::new();
        assert_eq!(strip_leading_dashdash(&args), &[] as &[String]);
    }
}
