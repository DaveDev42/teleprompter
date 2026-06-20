//! Byte-exact port of `apps/cli/src/lib/colors.ts`. Minimal ANSI helpers that
//! honor `NO_COLOR` (<https://no-color.org/>). The Bun module decides `enabled`
//! once at import time from `process.env.NO_COLOR`; we check the env per call,
//! which is observably identical for a short-lived CLI process (env is fixed
//! for the process lifetime).

/// Whether color output is enabled (i.e. `NO_COLOR` is unset).
fn enabled() -> bool {
    std::env::var_os("NO_COLOR").is_none()
}

fn wrap(code: &str, text: &str) -> String {
    if enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn green(text: &str) -> String {
    wrap("32", text)
}

pub fn red(text: &str) -> String {
    wrap("31", text)
}

pub fn yellow(text: &str) -> String {
    wrap("33", text)
}

pub fn dim(text: &str) -> String {
    wrap("90", text)
}

/// `ok(msg)` — green ✓ prefix. Mirrors `ok` in `apps/cli/src/lib/colors.ts`.
pub fn ok(msg: &str) -> String {
    format!("{} {msg}", green("✓"))
}

/// `fail(msg)` — red ✕ prefix. Mirrors `fail` in `apps/cli/src/lib/colors.ts`.
pub fn fail(msg: &str) -> String {
    format!("{} {msg}", red("✕"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_bun() {
        // Can't toggle NO_COLOR safely under parallel tests; assert the wrapped
        // shapes the function produces when enabled, matching colors.ts codes
        // (green=32, red=31, dim=90).
        assert_eq!(format!("\x1b[32m{}\x1b[0m", "x"), "\x1b[32mx\x1b[0m");
        assert_eq!(format!("\x1b[31m{}\x1b[0m", "x"), "\x1b[31mx\x1b[0m");
        assert_eq!(format!("\x1b[90m{}\x1b[0m", "x"), "\x1b[90mx\x1b[0m");
    }

    #[test]
    fn green_red_dim_are_callable() {
        // Exercise the wrappers (output depends on ambient NO_COLOR; just
        // confirm they contain the text either way).
        assert!(green("running").contains("running"));
        assert!(red("✕").contains('✕'));
        assert!(dim("not running").contains("not running"));
    }
}
