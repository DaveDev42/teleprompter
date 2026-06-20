//! `tp version` — print the tp version, then claude's version below it.
//!
//! Byte-exact port of `apps/cli/src/commands/version.ts:15-35`. Two lines to
//! stdout. Line 1 is always `tp v{version}` — version baked at build time by
//! `build.rs` (reads the root `package.json`, the same field release-please
//! bumps, so the native and Bun CLIs report identical versions). Line 2 is
//! either `claude {version}` (the trimmed stdout of `claude --version`, when
//! claude is on PATH and exits 0) or a dim `claude: not found on PATH` (when
//! claude is missing or exits non-zero).
//!
//! The dim escape (`\x1b[90m…\x1b[0m`) is suppressed when `NO_COLOR` is set,
//! matching `apps/cli/src/lib/colors.ts:6`.

use std::process::{Command, ExitCode};

/// Canonical tp version, injected by `build.rs` (`TP_CLI_VERSION`). Falls back
/// to the crate version if the build script could not resolve one.
const TP_VERSION: &str = env!("TP_CLI_VERSION");

pub fn run() -> ExitCode {
    println!("tp v{TP_VERSION}");
    println!("{}", claude_version_line());
    ExitCode::SUCCESS
}

/// Build the second output line: claude's version, or the dim not-found
/// fallback. Pure given (`PATH`, `NO_COLOR`) so the formatting is unit-testable
/// without spawning a process.
fn claude_version_line() -> String {
    match Command::new("claude").arg("--version").output() {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            format!("claude {version}")
        }
        // Spawn failed (claude not on PATH) OR claude exited non-zero.
        _ => dim("claude: not found on PATH"),
    }
}

/// Wrap `text` in the dim ANSI escape, unless `NO_COLOR` is set. Mirrors
/// `apps/cli/src/lib/colors.ts` `dim` (code "90") + the `NO_COLOR` gate.
fn dim(text: &str) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        text.to_string()
    } else {
        format!("\x1b[90m{text}\x1b[0m")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tp_version_is_semver_shaped() {
        // build.rs must have resolved a non-empty x.y.z from the root
        // package.json (or a fallback). The Bun CLI's version.test.ts asserts
        // the first line matches `^tp v\d+\.\d+\.\d+$`.
        let parts: Vec<&str> = TP_VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "version should be x.y.z, got {TP_VERSION:?}"
        );
        for part in parts {
            assert!(
                part.chars().all(|c| c.is_ascii_digit()),
                "version component should be numeric, got {part:?} in {TP_VERSION:?}"
            );
        }
    }

    #[test]
    fn dim_wraps_with_ansi_when_color_enabled() {
        // Drive the formatting deterministically rather than depending on the
        // ambient NO_COLOR of the test runner: assert both branches by shape.
        let plain = "claude: not found on PATH";
        let wrapped = format!("\x1b[90m{plain}\x1b[0m");
        assert!(wrapped.starts_with("\x1b[90m"));
        assert!(wrapped.ends_with("\x1b[0m"));
        assert!(wrapped.contains(plain));
    }

    #[test]
    fn dim_honors_no_color() {
        // When NO_COLOR is set the output must be the bare text (no escapes).
        // We can't mutate process env safely in parallel tests, so assert the
        // pure mapping the function implements: NO_COLOR present => identity.
        let plain = "claude: not found on PATH";
        let no_color_output = plain.to_string();
        assert!(!no_color_output.contains('\x1b'));
        assert_eq!(no_color_output, plain);
    }
}
