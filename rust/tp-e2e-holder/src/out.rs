//! Output contract — greppable stdout lines vs stderr diagnostics.
//!
//! The harness (`scripts/ios.sh start_real_daemon_relay`) redirects the holder
//! with `>"$rp_out" 2>>"$rp_out"` — stdout truncates while stderr appends, two
//! fds with independent offsets on ONE file. An interleaved stderr write races
//! the stdout contract lines and can clobber them (empirically observed with
//! the Bun holder). So EVERY line the harness greps goes to STDOUT via a single
//! `write_all` + flush, and stderr carries only human diagnostics.

use std::io::Write as _;

/// Emit one greppable contract line on stdout (single write + flush so the
/// line can never be torn by the two-fd redirect).
pub fn contract(line: &str) {
    let mut out = std::io::stdout().lock();
    let framed = format!("{line}\n");
    let _ = out.write_all(framed.as_bytes());
    let _ = out.flush();
}

/// Stderr diagnostic, prefixed like the Bun holder's `log()` helper.
pub fn log(msg: &str) {
    eprintln!("[tp-e2e-holder] {msg}");
}

/// Fatal: log and exit(1). The harness's REAL_PAIR_URL poll detects the early
/// exit via the vanished background pid.
pub fn die(msg: &str) -> ! {
    eprintln!("[tp-e2e-holder] FATAL: {msg}");
    std::process::exit(1);
}
