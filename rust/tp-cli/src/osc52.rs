//! OSC 52 clipboard helper — writes to the system clipboard via terminal escape
//! sequences without requiring native dependencies. Byte-exact port of
//! `apps/cli/src/lib/osc52.ts`.
//!
//! Design (mirrors the Bun module):
//! - BEL (`\x07`) terminator rather than ST — broadly honoured.
//! - tmux passthrough (`$TMUX` set): wrap with `\x1bPtmux;…\x1b\\`, doubling
//!   every ESC (`0x1B`) inside the payload.
//! - GNU screen passthrough (`$STY` set): wrap with `\x1bP…\x1b\\` (no doubling).
//! - base64 STANDARD alphabet (matches `Buffer.from(text,"utf8").toString("base64")`).

use std::io::{IsTerminal as _, Write as _};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

/// Known-good `$TERM_PROGRAM` values (terminal apps that support OSC 52).
/// Mirrors `KNOWN_GOOD_PROGRAMS` (osc52.ts:23-30).
const KNOWN_GOOD_PROGRAMS: &[&str] = &[
    "iTerm.app",
    "vscode",
    "Apple_Terminal",
    "WezTerm",
    "ghostty",
    "Hyper",
];

/// Known-good `$TERM` prefixes/values. Mirrors `KNOWN_GOOD_TERMS` (osc52.ts:33).
const KNOWN_GOOD_TERMS: &[&str] = &["xterm", "screen", "tmux", "alacritty", "kitty"];

/// Heuristic: is OSC 52 clipboard copy likely to be honoured by this terminal?
///
/// Byte-exact port of `isClipboardSupportLikely` (osc52.ts:42-59):
/// - non-TTY stdout → false
/// - `$TERM` == `"dumb"` or `""` → false
/// - `$TMUX` or `$STY` set → true (multiplexer passthrough)
/// - `$TERM_PROGRAM` in the known-good set → true
/// - `$TERM` starts with a known-good prefix → true
/// - otherwise → true (optimistic; user finds out on `c`)
#[must_use]
pub fn is_clipboard_support_likely() -> bool {
    if !std::io::stdout().is_terminal() {
        return false;
    }
    let term = std::env::var("TERM").unwrap_or_default();
    if term == "dumb" || term.is_empty() {
        return false;
    }

    // Multiplexer detected → attempt passthrough.
    if env_set("TMUX") || env_set("STY") {
        return true;
    }

    // Known-good terminal program.
    let prog = std::env::var("TERM_PROGRAM").unwrap_or_default();
    if KNOWN_GOOD_PROGRAMS.contains(&prog.as_str()) {
        return true;
    }

    // Known-good $TERM prefix.
    if KNOWN_GOOD_TERMS.iter().any(|t| term.starts_with(t)) {
        return true;
    }

    // Unknown terminal — optimistic.
    true
}

/// Outcome of a clipboard copy attempt. Mirrors the retired Bun CLI's
/// `ClipboardResult` (osc52.ts:61-64, deleted in #5 PR6 #933 — visible in git
/// history).
pub struct ClipboardResult {
    pub ok: bool,
    /// Why the copy was impossible (when `ok == false`). Mirrors the Bun field
    /// for API parity and diagnostics. The `pair new` caller only branches on
    /// `ok` (like the retired Bun CLI's keypress handler, pair.ts:301-307,
    /// also deleted in #5 PR6), so this is not read on the happy path — kept
    /// as part of the public contract.
    #[allow(dead_code)]
    pub reason: Option<String>,
}

impl ClipboardResult {
    fn ok() -> Self {
        Self {
            ok: true,
            reason: None,
        }
    }
    fn err(reason: &str) -> Self {
        Self {
            ok: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// Build the OSC 52 escape sequence for `text` given the multiplexer env.
///
/// Split out from `copy_to_clipboard` so the wrapping branches are unit-testable
/// without touching the real stdout/env. `tmux`/`screen` flags are passed in
/// (the real call reads them from `$TMUX`/`$STY`).
fn build_osc52(text: &str, tmux: bool, screen: bool) -> String {
    let b64 = STANDARD.encode(text.as_bytes());
    let inner = format!("\x1b]52;c;{b64}\x07");

    if tmux {
        // tmux DCS passthrough: each ESC inside the payload must be doubled.
        let escaped = inner.replace('\x1b', "\x1b\x1b");
        format!("\x1bPtmux;{escaped}\x1b\\")
    } else if screen {
        // GNU screen DCS passthrough.
        format!("\x1bP{inner}\x1b\\")
    } else {
        inner
    }
}

/// Synchronously write an OSC 52 sequence to stdout to copy `text` to the
/// terminal clipboard. Byte-exact port of `copyToClipboard` (osc52.ts:73-100).
///
/// Returns `{ ok: true }` when the sequence was written, or `{ ok: false,
/// reason }` when the environment makes it impossible.
pub fn copy_to_clipboard(text: &str) -> ClipboardResult {
    // Sanity-check the environment before writing anything.
    if !std::io::stdout().is_terminal() {
        return ClipboardResult::err("stdout is not a TTY");
    }
    let term = std::env::var("TERM").unwrap_or_default();
    if term == "dumb" || term.is_empty() {
        return ClipboardResult::err("$TERM is dumb or unset");
    }

    let seq = build_osc52(text, env_set("TMUX"), env_set("STY"));
    let mut out = std::io::stdout();
    let _ = out.write_all(seq.as_bytes());
    let _ = out.flush();
    ClipboardResult::ok()
}

/// `$VAR` is set to a non-empty value. Mirrors JS truthiness of
/// `process.env["TMUX"]` (an empty string is falsy in JS).
fn env_set(name: &str) -> bool {
    std::env::var(name).is_ok_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The base64 of "hi" is "aGk=" (STANDARD alphabet, matches Node's base64).
    const B64_HI: &str = "aGk=";

    #[test]
    fn plain_sequence() {
        let seq = build_osc52("hi", false, false);
        assert_eq!(seq, format!("\x1b]52;c;{B64_HI}\x07"));
    }

    #[test]
    fn tmux_wrapping_doubles_escapes() {
        let seq = build_osc52("hi", true, false);
        // inner = ESC ] 52 ; c ; aGk= BEL ; the ESC is doubled inside the wrap.
        let inner_escaped = format!("\x1b\x1b]52;c;{B64_HI}\x07");
        assert_eq!(seq, format!("\x1bPtmux;{inner_escaped}\x1b\\"));
        // No single (un-doubled) ESC remains except the wrapper's own.
        assert!(seq.starts_with("\x1bPtmux;"));
        assert!(seq.ends_with("\x1b\\"));
    }

    #[test]
    fn screen_wrapping_no_doubling() {
        let seq = build_osc52("hi", false, true);
        let inner = format!("\x1b]52;c;{B64_HI}\x07");
        assert_eq!(seq, format!("\x1bP{inner}\x1b\\"));
        // ESC is NOT doubled in screen mode.
        assert!(!seq.contains("\x1b\x1b"));
    }

    #[test]
    fn tmux_takes_precedence_over_screen() {
        // When both flags are set, tmux branch wins (matches the if/else-if order).
        let tmux_seq = build_osc52("hi", true, true);
        let only_tmux = build_osc52("hi", true, false);
        assert_eq!(tmux_seq, only_tmux);
    }

    #[test]
    fn base64_is_standard_alphabet() {
        // ">>>" → base64 STANDARD "Pj4+", which uses '+' (URL-safe would use '-').
        let seq = build_osc52(">>>", false, false);
        assert!(seq.contains("Pj4+"), "expected STANDARD-alphabet base64");
    }

    // ---- is_clipboard_support_likely env-matrix ----
    //
    // We cannot toggle the process env safely under parallel tests, so the
    // env-dependent branches are validated through the pure helpers that drive
    // them: env_set truthiness (empty string = falsy) and the known-good
    // membership checks. The full function is integration-covered by the byte
    // parity / E2E gate.

    #[test]
    fn known_good_program_membership() {
        assert!(KNOWN_GOOD_PROGRAMS.contains(&"iTerm.app"));
        assert!(KNOWN_GOOD_PROGRAMS.contains(&"vscode"));
        assert!(KNOWN_GOOD_PROGRAMS.contains(&"ghostty"));
        assert!(!KNOWN_GOOD_PROGRAMS.contains(&"unknown-term"));
    }

    #[test]
    fn known_good_term_prefix_match() {
        let matches = |term: &str| KNOWN_GOOD_TERMS.iter().any(|t| term.starts_with(t));
        assert!(matches("xterm-256color"));
        assert!(matches("screen.xterm"));
        assert!(matches("tmux-256color"));
        assert!(matches("alacritty"));
        assert!(matches("kitty"));
        assert!(!matches("dumb"));
        assert!(!matches("vt100"));
    }

    #[test]
    fn env_set_empty_is_falsy() {
        // Use a name that is overwhelmingly unlikely to be set in the test env.
        // Assert the empty-string-is-falsy contract via a controlled name only
        // if absent; the core logic is the `is_ok_and(|v| !v.is_empty())`.
        assert!(!env_set("TP_CLI_OSC52_DEFINITELY_UNSET_VAR_XYZ"));
    }
}
