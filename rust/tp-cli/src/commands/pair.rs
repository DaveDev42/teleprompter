//! `tp pair list`   — list registered pairings.
//! `tp pair delete`  — delete a pairing via daemon IPC.
//! `tp pair rename`  — rename a pairing via daemon IPC.
//!
//! Byte-exact port of `apps/cli/src/commands/pair.ts`:
//!   - `pairList`   (lines 406-451)
//!   - `pairDelete` (lines 453-564)
//!   - `pairRename` (lines 566-667)
//!
//! `pairList`: Reads the Store directly; empty store prints "No pairings
//! registered." + a hint. Otherwise a fixed-width LABEL/DAEMON ID/RELAY/CREATED
//! table (column widths = max(header, values); LABEL = decoded label or empty;
//! CREATED = `format_age` of `created_at`).
//!
//! `pairDelete`: 5-tier prefix match via `match_pairings`; non-TTY without
//! `--yes` refuses; TTY prompts with default No; daemon-up gate (ADR-0003
//! Amendment 2 A2.4 — no store-write fallback); sends `pair.remove` IPC and
//! renders the ok/err response byte-identically to the Bun reference.
//!
//! `pairRename`: 5-tier prefix match via `match_pairings`; label = remaining args
//! joined and trimmed; no confirmation required (rename is non-destructive);
//! daemon-up gate (A2.4 — no store-write fallback); sends `pair.rename` IPC
//! (Label tagged union) and renders the ok/err response byte-identically to Bun.

use std::io::{self, IsTerminal as _, Write as _};
use std::process::ExitCode;

use tp_proto::ipc::IpcMessage;
use tp_proto::label::{label_to_nullable, make_label};

use crate::colors::{dim, green, red};
use crate::commands::session::pad_end;
use crate::format::format_age;
use crate::ipc_client::{match_pairings, request, IpcError, MatchResult};
use crate::store::list_pairings;
use crate::util::now_ms;

// ---------------------------------------------------------------------------
// Color helpers mirroring colors.ts
// ---------------------------------------------------------------------------

fn ok_prefix(msg: &str) -> String {
    format!("{} {msg}", green("✓"))
}

fn fail_prefix(msg: &str) -> String {
    format!("{} {msg}", red("✕"))
}

// ---------------------------------------------------------------------------
// Confirmation prompt (TTY path only)
// ---------------------------------------------------------------------------

/// Ask `question [y/N]:` on stdout, read one line from stdin.
/// Returns `true` if the user typed `y` or `Y`; anything else (including
/// empty / Enter) → false (default No).
/// Mirrors `promptYesNo({ defaultValue: false })` in the Bun reference.
fn prompt_yes_no(question: &str) -> bool {
    print!("{question} [y/N]: ");
    let _ = io::stdout().flush();
    let mut buf = String::new();
    if io::stdin().read_line(&mut buf).is_err() {
        return false;
    }
    matches!(buf.trim().to_lowercase().as_str(), "y" | "yes")
}

// ---------------------------------------------------------------------------
// Table row
// ---------------------------------------------------------------------------

struct Row {
    daemon_id: String,
    label: String,
    relay_url: String,
    created: String,
}

pub fn list() -> ExitCode {
    let pairings = list_pairings();

    if pairings.is_empty() {
        println!("No pairings registered.");
        println!();
        println!("Create one with: tp pair new");
        return ExitCode::SUCCESS;
    }

    let now = now_ms();
    let rows: Vec<Row> = pairings
        .iter()
        .map(|p| Row {
            daemon_id: p.daemon_id.clone(),
            // labelToNullable(...) ?? "" — None renders as empty string.
            label: p.label.clone().unwrap_or_default(),
            relay_url: p.relay_url.clone(),
            created: format_age(now - p.created_at, now),
        })
        .collect();

    // Header minimums: "LABEL"=5, "DAEMON ID"=9, "RELAY"=5.
    let label_w = rows
        .iter()
        .map(|r| r.label.chars().count())
        .chain([5])
        .max()
        .unwrap_or(5);
    let id_w = rows
        .iter()
        .map(|r| r.daemon_id.chars().count())
        .chain([9])
        .max()
        .unwrap_or(9);
    let relay_w = rows
        .iter()
        .map(|r| r.relay_url.chars().count())
        .chain([5])
        .max()
        .unwrap_or(5);

    println!(
        "{}  {}  {}  CREATED",
        pad_end("LABEL", label_w),
        pad_end("DAEMON ID", id_w),
        pad_end("RELAY", relay_w),
    );
    for r in &rows {
        println!(
            "{}  {}  {}  {}",
            pad_end(&r.label, label_w),
            pad_end(&r.daemon_id, id_w),
            pad_end(&r.relay_url, relay_w),
            r.created,
        );
    }
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// `tp pair delete <daemon-id> [-y]`
// ---------------------------------------------------------------------------

/// Byte-exact port of `pairDelete` (`apps/cli/src/commands/pair.ts:453-564`).
///
/// Arg parsing: one positional (the id/label prefix) + optional `--yes`/`-y`.
/// Prefix resolution via `match_pairings` (5-tier).
/// Non-TTY without `--yes` → refuse + exit 1.
/// TTY → prompt with default No.
/// Daemon-up gate (ADR-0003 A2.4): no store-write fallback.
pub fn delete(args: &[String]) -> ExitCode {
    // ---- arg parsing ----
    // Mirrors parseArgsFriendly({ options: { yes: boolean }, allowPositionals: true }).
    let mut yes = false;
    let mut positionals: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--yes" | "-y" => yes = true,
            arg if arg.starts_with('-') => {
                eprintln!("{}", fail_prefix(&format!("Unknown option: {arg}")));
                eprintln!(
                    "{}",
                    fail_prefix("Usage: tp pair delete <daemon-id> [--yes]")
                );
                return ExitCode::FAILURE;
            }
            arg => positionals.push(arg),
        }
        i += 1;
    }

    if positionals.len() > 1 {
        eprintln!(
            "{}",
            fail_prefix("Usage: tp pair delete <daemon-id> [--yes]")
        );
        return ExitCode::FAILURE;
    }

    let prefix = match positionals.first() {
        Some(p) => *p,
        None => {
            eprintln!(
                "{}",
                fail_prefix("Usage: tp pair delete <daemon-id> [--yes]")
            );
            return ExitCode::FAILURE;
        }
    };

    // ---- prefix resolution (client-side, against the store) ----
    let candidates = list_pairings();

    let target = match match_pairings(&candidates, prefix) {
        MatchResult::None => {
            eprintln!(
                "{}",
                fail_prefix(&format!("No pairing matches '{prefix}'."))
            );
            if !candidates.is_empty() {
                eprintln!("{}", dim("Known daemon IDs:"));
                for c in &candidates {
                    eprintln!("{}", dim(&format!("  {}", c.daemon_id)));
                }
            }
            return ExitCode::FAILURE;
        }
        MatchResult::Ambiguous(matches) => {
            eprintln!(
                "{}",
                fail_prefix(&format!("'{prefix}' is ambiguous. Candidates:"))
            );
            for m in &matches {
                eprintln!("  {}  {}", m.daemon_id, m.relay_url);
            }
            return ExitCode::FAILURE;
        }
        MatchResult::One(row) => row,
    };

    let target_daemon_id = target.daemon_id.clone();
    let target_relay_url = target.relay_url.clone();

    // ---- confirmation ----
    if !yes {
        if !io::stdin().is_terminal() {
            eprintln!(
                "{}",
                fail_prefix("Refusing to delete without confirmation — pass --yes.")
            );
            return ExitCode::FAILURE;
        }
        let confirmed = prompt_yes_no(&format!(
            "Delete pairing for {target_daemon_id} (relay {target_relay_url})?"
        ));
        if !confirmed {
            println!("Aborted.");
            return ExitCode::SUCCESS;
        }
    }

    // ---- daemon IPC (A2.4: no store-write fallback) ----
    let req = IpcMessage::PairRemove {
        daemon_id: target_daemon_id.clone(),
    };

    match request(&req) {
        Err(e) => {
            // DaemonDown gives a friendly message; other errors surface as-is.
            match e {
                IpcError::DaemonDown => {
                    eprintln!("{}", fail_prefix(&e.to_string()));
                }
                _ => {
                    eprintln!("{}", fail_prefix(&format!("Pair delete failed: {e}")));
                }
            }
            ExitCode::FAILURE
        }
        Ok(IpcMessage::PairRemoveOk {
            daemon_id,
            notified_peers,
        }) => {
            println!("{}", ok_prefix(&format!("Deleted pairing {daemon_id}")));
            if notified_peers > 0 {
                println!(
                    "{}",
                    dim(&format!("Notified {notified_peers} frontend(s)."))
                );
            }
            ExitCode::SUCCESS
        }
        Ok(IpcMessage::PairRemoveErr {
            reason, message, ..
        }) => {
            let suffix = message
                .as_deref()
                .map(|m| format!(" — {m}"))
                .unwrap_or_default();
            // Serialize the reason enum to its wire string (e.g. "not-found").
            // serde_json::to_string gives `"not-found"` (with quotes); strip them.
            let reason_str = serde_json::to_string(&reason)
                .unwrap_or_else(|_| format!("{reason:?}"))
                .trim_matches('"')
                .to_string();
            eprintln!(
                "{}",
                fail_prefix(&format!("Pair delete failed: {reason_str}{suffix}"))
            );
            ExitCode::FAILURE
        }
        Ok(other) => {
            eprintln!(
                "{}",
                fail_prefix(&format!(
                    "Pair delete failed: unexpected response discriminant {:?}",
                    other
                ))
            );
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// `tp pair rename <daemon-id-prefix> <label...>`
// ---------------------------------------------------------------------------

/// Byte-exact port of `pairRename` (`apps/cli/src/commands/pair.ts:566-667`).
///
/// Arg parsing: first positional = id/label prefix; remaining positionals joined
/// with spaces and trimmed = new label (empty → label cleared / `Unset`).
/// No `--yes` needed — rename is non-destructive.
///
/// Prefix resolution via `match_pairings` (5-tier, same as delete).
///
/// Daemon-up gate (ADR-0003 A2.4): unlike the Bun reference which falls back to
/// a direct store write when the daemon is down, the Rust port requires the daemon
/// to be running. If not running, print the daemon-down guidance and exit 1.
///
/// IPC: `pair.rename` → `pair.rename.ok` | `pair.rename.err`.
/// Success: `ok("Renamed <daemonId> → <echoed>")` where `echoed` is the label
/// from the daemon response (`"<value>"` if set, `(cleared)` if unset);
/// if `notifiedPeers > 0`, also prints `dim("Notified N frontend(s).")`.
pub fn rename(args: &[String]) -> ExitCode {
    // ---- arg parsing ----
    // Mirrors parseArgsFriendly({ options: { help: boolean }, allowPositionals: true }).
    let mut positionals: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                // Mirror pairRename's values.help branch: call printPairUsage() and return.
                println!();
                println!("tp pair — manage mobile app pairings");
                println!();
                println!("Usage:");
                println!("  tp pair [--relay URL]                        Alias for 'tp pair new'");
                println!(
                    "  tp pair new [--relay URL] [--label <name>]   Generate a QR and BLOCK until the"
                );
                println!(
                    "                                               mobile app scans it (Ctrl+C to cancel)."
                );
                println!(
                    "                                               Auto-starts the daemon if needed."
                );
                println!(
                    "  tp pair list                                 List registered (completed) pairings"
                );
                println!(
                    "  tp pair rename <daemon-id> <label...>        Rename a pairing (prefix match)"
                );
                println!(
                    "  tp pair delete <daemon-id> [-y]              Delete a pairing (prefix match allowed)"
                );
                println!();
                return ExitCode::SUCCESS;
            }
            arg if arg.starts_with('-') => {
                eprintln!(
                    "{}",
                    fail_prefix("Usage: tp pair rename <daemon-id-prefix> <label...>")
                );
                return ExitCode::FAILURE;
            }
            arg => positionals.push(arg),
        }
        i += 1;
    }

    // Need at least 2 positionals: <prefix> <label-word...>
    // Mirrors pair.ts:583 — if (positionals.length < 2) { console.error(fail(...)); exit(1) }
    if positionals.len() < 2 {
        eprintln!(
            "{}",
            fail_prefix("Usage: tp pair rename <daemon-id-prefix> <label...>")
        );
        return ExitCode::FAILURE;
    }

    let prefix = positionals[0];
    // join remaining args with spaces, then trim — mirrors `labelParts.join(" ").trim()`.
    let new_label_raw = positionals[1..].join(" ");
    let new_label = new_label_raw.trim();
    // `label = newLabel === "" ? null : newLabel` in Bun (pair.ts:594).
    // make_label(None) → Unset; make_label(Some(s)) trims, empty → Unset.
    let label = if new_label.is_empty() {
        make_label(None)
    } else {
        make_label(Some(new_label))
    };

    // ---- prefix resolution (client-side, against the store) ----
    let candidates = list_pairings();

    let target = match match_pairings(&candidates, prefix) {
        MatchResult::None => {
            // pair.ts:602 — "No pairing matches '<prefix>'."
            eprintln!(
                "{}",
                fail_prefix(&format!("No pairing matches '{prefix}'."))
            );
            if !candidates.is_empty() {
                eprintln!("{}", dim("Known daemon IDs:"));
                for c in &candidates {
                    eprintln!("{}", dim(&format!("  {}", c.daemon_id)));
                }
            }
            return ExitCode::FAILURE;
        }
        MatchResult::Ambiguous(matches) => {
            // pair.ts:609 — note "Prefix" capital P (differs from pairDelete at 498).
            eprintln!(
                "{}",
                fail_prefix(&format!("Prefix '{prefix}' is ambiguous. Candidates:"))
            );
            for m in &matches {
                eprintln!("  {}  {}", m.daemon_id, m.relay_url);
            }
            return ExitCode::FAILURE;
        }
        MatchResult::One(row) => row,
    };

    let target_daemon_id = target.daemon_id.clone();

    // ---- daemon IPC (A2.4: no store-write fallback) ----
    let req = IpcMessage::PairRename {
        daemon_id: target_daemon_id.clone(),
        label,
    };

    match request(&req) {
        Err(e) => {
            match e {
                IpcError::DaemonDown => {
                    // Bun would fall back to store write; Rust A2.4: no fallback.
                    eprintln!("{}", fail_prefix(&e.to_string()));
                }
                _ => {
                    eprintln!("{}", fail_prefix(&format!("Pair rename failed: {e}")));
                }
            }
            ExitCode::FAILURE
        }
        Ok(IpcMessage::PairRenameOk {
            daemon_id,
            label: returned_label,
            notified_peers,
        }) => {
            // pair.ts:643-651
            // echoed = labelToNullable(result.label)
            // ok(`Renamed ${result.daemonId} → ${echoed === null ? "(cleared)" : `"${echoed}"`}`)
            let echoed = label_to_nullable(&returned_label);
            let label_display = match echoed {
                None => "(cleared)".to_string(),
                Some(v) => format!("\"{v}\""),
            };
            println!(
                "{}",
                ok_prefix(&format!("Renamed {daemon_id} → {label_display}"))
            );
            if notified_peers > 0 {
                println!(
                    "{}",
                    dim(&format!("Notified {notified_peers} frontend(s)."))
                );
            }
            ExitCode::SUCCESS
        }
        Ok(IpcMessage::PairRenameErr {
            reason, message, ..
        }) => {
            // pair.ts:634-641
            // `Pair rename failed: ${result.reason}${result.message ? ` — ${result.message}` : ""}`
            let suffix = message
                .as_deref()
                .map(|m| format!(" — {m}"))
                .unwrap_or_default();
            let reason_str = serde_json::to_string(&reason)
                .unwrap_or_else(|_| format!("{reason:?}"))
                .trim_matches('"')
                .to_string();
            eprintln!(
                "{}",
                fail_prefix(&format!("Pair rename failed: {reason_str}{suffix}"))
            );
            ExitCode::FAILURE
        }
        Ok(other) => {
            eprintln!(
                "{}",
                fail_prefix(&format!(
                    "Pair rename failed: unexpected response discriminant {:?}",
                    other
                ))
            );
            ExitCode::FAILURE
        }
    }
}
