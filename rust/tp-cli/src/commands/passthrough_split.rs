//! `--tp-*` argument splitter for native passthrough (task #17 PR-2).
//!
//! Byte-exact Rust port of `apps/cli/src/args.ts` `splitArgs`: separates the
//! `--tp-sid` / `--tp-cwd` flags (consumed by `tp`) from everything else (passed
//! verbatim to `claude`, in original order). The native passthrough handler
//! (PR-4) uses [`TpArgs::sid`] / [`TpArgs::cwd`] to seed the session id / cwd and
//! forwards `claude_args` to the in-process runner.
//!
//! Value-guard parity with the TS source: a `--tp-sid` / `--tp-cwd` whose value
//! is missing, another `--tp-*` flag, the bare `--` separator, or any
//! `-`-prefixed token is a **usage error** — a real sid/cwd never starts with
//! `-`, and `tp --tp-sid -- -p hello` must not silently bind `sid = "--"`.

// The splitter lands ahead of its only caller: the native passthrough handler
// wired by task #17 PR-4 (`Route::Passthrough` → in-process `runner::run`). Until
// then these items are exercised only by the unit tests below, so suppress the
// unused warnings (mirrors the `locate_tp_daemon()` flip-prep A1 precedent). The
// `#[allow]` is removed when PR-4 adds the first real caller.
#![allow(dead_code)]

/// Flags consumed by `tp` itself (each takes a value).
const TP_VALUE_FLAGS: &[&str] = &["--tp-sid", "--tp-cwd"];

/// Parsed `--tp-*` values.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TpArgs {
    pub sid: Option<String>,
    pub cwd: Option<String>,
}

/// The split of an argv into `tp`-consumed flags and claude-forwarded args.
#[derive(Debug, PartialEq, Eq)]
pub struct SplitResult {
    pub tp_args: TpArgs,
    pub claude_args: Vec<String>,
}

/// Error describing an invalid `--tp-*` value, carrying the offending flag so the
/// caller can render the same usage message the Bun CLI printed (flag-specific
/// example). Mirrors the `console.error` block in `args.ts:50-55`.
#[derive(Debug, PartialEq, Eq)]
pub struct SplitError {
    /// The `--tp-*` flag whose value was missing or flag-like.
    pub flag: String,
}

impl SplitError {
    /// The three-line usage message the Bun CLI printed before `process.exit(1)`
    /// (`args.ts:50-54`), reproduced verbatim so the native path is
    /// indistinguishable to the user.
    #[must_use]
    pub fn usage_message(&self) -> String {
        let example = if self.flag == "--tp-sid" {
            "my-session"
        } else {
            "/path/to/project"
        };
        format!(
            "Error: {flag} requires a value.\n\n\
             Usage: tp {flag} <value> [claude args...]\n\
             Example: tp {flag} {example} -p \"hello\"",
            flag = self.flag,
        )
    }
}

/// Split `argv` (the args after the binary name) into `tp`-consumed `--tp-*`
/// flags and the remaining claude args. Rust port of `splitArgs` in
/// `apps/cli/src/args.ts:28-73`.
///
/// # Errors
///
/// Returns [`SplitError`] when a `--tp-sid` / `--tp-cwd` is followed by no value,
/// another `--tp-*` flag, `--`, or any `-`-prefixed token (the TS
/// `process.exit(1)` usage-error path).
pub fn split_args(argv: &[String]) -> Result<SplitResult, SplitError> {
    let mut tp_args = TpArgs::default();
    let mut claude_args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];

        if TP_VALUE_FLAGS.contains(&arg.as_str()) {
            let value = argv.get(i + 1);
            // A missing value, or any flag-like value, is a usage error. Beyond
            // the recognized --tp-* flags, also reject the bare `--` separator
            // and any `-`-prefixed token — see module doc / args.ts:38-43.
            let invalid = match value {
                None => true,
                Some(v) => {
                    TP_VALUE_FLAGS.contains(&v.as_str()) || v == "--" || v.starts_with('-')
                }
            };
            if invalid {
                return Err(SplitError { flag: arg.clone() });
            }
            // Safe: `value` is Some (None → invalid above).
            let value = value.expect("value present when not invalid").clone();
            match arg.as_str() {
                "--tp-sid" => tp_args.sid = Some(value),
                "--tp-cwd" => tp_args.cwd = Some(value),
                _ => unreachable!("TP_VALUE_FLAGS membership checked above"),
            }
            i += 2;
        } else {
            claude_args.push(arg.clone());
            i += 1;
        }
    }

    Ok(SplitResult {
        tp_args,
        claude_args,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(args: &[&str]) -> Result<SplitResult, SplitError> {
        split_args(&args.iter().map(|s| (*s).to_string()).collect::<Vec<_>>())
    }

    fn claude(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn splits_tp_flags_from_claude_args() {
        // Mirrors the args.ts docstring example.
        let r = split(&["--tp-sid", "my-session", "-p", "hello", "--model", "opus"]).unwrap();
        assert_eq!(r.tp_args.sid.as_deref(), Some("my-session"));
        assert_eq!(r.tp_args.cwd, None);
        assert_eq!(r.claude_args, claude(&["-p", "hello", "--model", "opus"]));
    }

    #[test]
    fn parses_both_tp_flags() {
        let r = split(&["--tp-sid", "s1", "--tp-cwd", "/work", "-p", "hi"]).unwrap();
        assert_eq!(r.tp_args.sid.as_deref(), Some("s1"));
        assert_eq!(r.tp_args.cwd.as_deref(), Some("/work"));
        assert_eq!(r.claude_args, claude(&["-p", "hi"]));
    }

    #[test]
    fn no_tp_flags_forwards_everything_in_order() {
        let r = split(&["-p", "hello", "--model", "opus"]).unwrap();
        assert_eq!(r.tp_args, TpArgs::default());
        assert_eq!(r.claude_args, claude(&["-p", "hello", "--model", "opus"]));
    }

    #[test]
    fn empty_argv_is_empty_split() {
        let r = split(&[]).unwrap();
        assert_eq!(r.tp_args, TpArgs::default());
        assert!(r.claude_args.is_empty());
    }

    #[test]
    fn tp_flag_interleaved_preserves_claude_order() {
        // A --tp-* flag in the middle is consumed; surrounding claude args keep
        // their relative order.
        let r = split(&["-p", "hi", "--tp-cwd", "/x", "--model", "opus"]).unwrap();
        assert_eq!(r.tp_args.cwd.as_deref(), Some("/x"));
        assert_eq!(r.claude_args, claude(&["-p", "hi", "--model", "opus"]));
    }

    // ── value-guard: usage errors ────────────────────────────────────────────

    #[test]
    fn missing_value_at_end_errors() {
        let e = split(&["--tp-sid"]).unwrap_err();
        assert_eq!(e.flag, "--tp-sid");
    }

    #[test]
    fn value_is_another_tp_flag_errors() {
        // `tp --tp-sid --tp-cwd /x` — sid value must not be another --tp-* flag.
        let e = split(&["--tp-sid", "--tp-cwd", "/x"]).unwrap_err();
        assert_eq!(e.flag, "--tp-sid");
    }

    #[test]
    fn value_is_double_dash_errors() {
        // `tp --tp-sid -- -p hello` must not bind sid = "--".
        let e = split(&["--tp-sid", "--", "-p", "hello"]).unwrap_err();
        assert_eq!(e.flag, "--tp-sid");
    }

    #[test]
    fn value_is_dash_prefixed_errors() {
        let e = split(&["--tp-cwd", "-p"]).unwrap_err();
        assert_eq!(e.flag, "--tp-cwd");
    }

    #[test]
    fn usage_message_is_flag_specific() {
        let sid_msg = SplitError {
            flag: "--tp-sid".to_string(),
        }
        .usage_message();
        assert!(sid_msg.contains("--tp-sid requires a value"));
        assert!(sid_msg.contains("my-session"));

        let cwd_msg = SplitError {
            flag: "--tp-cwd".to_string(),
        }
        .usage_message();
        assert!(cwd_msg.contains("--tp-cwd requires a value"));
        assert!(cwd_msg.contains("/path/to/project"));
    }
}
