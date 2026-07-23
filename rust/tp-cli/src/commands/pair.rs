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
use std::net::Shutdown;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use tp_proto::ipc::IpcMessage;
use tp_proto::label::{label_to_nullable, make_label, Label};

use crate::colors::{dim, green, red};
use crate::commands::session::pad_end;
use crate::config_dir::config_dir;
use crate::format::format_age;
use crate::ipc_client::{match_pairings, request, IpcError, MatchResult};
use crate::ipc_session::IpcSession;
use crate::osc52::{copy_to_clipboard, is_clipboard_support_likely};
use crate::pair_lock::acquire_pair_lock;
use crate::qr::render_qr_small;
use crate::socket::{is_daemon_running, socket_path};
use crate::store::list_pairings;
use crate::tui::raw_mode::RawModeGuard;
use crate::util::now_ms;

/// Production relay URL — byte-exact port of `DEFAULT_PAIRING_RELAY_URL`
/// (`packages/protocol/src/pairing.ts:50`). Used as the `--relay` default.
const DEFAULT_PAIRING_RELAY_URL: &str = "wss://relay.tpmt.dev";

/// Host suffixes trimmed from the default label. Byte-exact port of
/// `TRIMMABLE_HOST_SUFFIXES` (pair.ts:383).
const TRIMMABLE_HOST_SUFFIXES: &[&str] = &[".local", ".lan", ".localdomain", ".home"];

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

/// Ask `question [y/N] ` on stdout, read one line from stdin.
/// Returns `true` if the user typed `y` or `Y`; anything else (including
/// empty / Enter) → false (default No).
/// Mirrors `promptYesNo({ defaultValue: false })` in the Bun reference.
/// Format matches yes-no-prompt.tsx: `{question} {hint}{" "}` (trailing space, no colon).
fn prompt_yes_no(question: &str) -> bool {
    print!("{question} [y/N] ");
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
            // NOTE: the peer-supplied label is printed RAW. The TS reference
            // stripped ANSI/control chars at display time (lib/sanitize.ts);
            // that display-only sanitization is not yet ported, so a hostile
            // peer rename could inject terminal escapes here. Follow-up port
            // is tracked in TODO.md.
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

// ---------------------------------------------------------------------------
// Default label derivation (pair.ts:378-404)
// ---------------------------------------------------------------------------

/// Strip a single trailing zeroconf/LAN suffix from a host name. Byte-exact
/// port of `normalizeHostLabel` (pair.ts:385-395): trim, then drop ONE leaf
/// suffix from `TRIMMABLE_HOST_SUFFIXES` (case-insensitive match, only if the
/// remaining length is strictly greater than the suffix length).
pub fn normalize_host_label(raw: &str) -> String {
    let h = raw.trim();
    let lower = h.to_lowercase();
    for suffix in TRIMMABLE_HOST_SUFFIXES {
        // `h.length > suffix.length` in Bun — a host that IS exactly the suffix
        // keeps everything (no strip).
        if lower.ends_with(suffix) && h.len() > suffix.len() {
            return h[..h.len() - suffix.len()].to_string();
        }
    }
    h.to_string()
}

/// Resolve the host-derived default label. Byte-exact port of `defaultLabel`
/// (pair.ts:397-404): `normalizeHostLabel(hostname())`, falling back to
/// `"daemon"` on an empty result or any error reading the host name.
pub fn default_label() -> String {
    match hostname::get() {
        Ok(os) => {
            let h = normalize_host_label(&os.to_string_lossy());
            if h.is_empty() {
                "daemon".to_string()
            } else {
                h
            }
        }
        Err(_) => "daemon".to_string(),
    }
}

// ---------------------------------------------------------------------------
// `tp pair new [--relay URL] [--daemon-id ID] [--label NAME]`
// ---------------------------------------------------------------------------

/// Byte-exact port of `pairNew` (`apps/cli/src/commands/pair.ts:73-323`).
///
/// Flow:
/// 1. Parse `--relay` / `--daemon-id` / `--label` / `-h` (lenient, `strict:false`).
/// 2. Acquire the pair lock (`config_dir()/pair.lock`) — contention → exit 1.
/// 3. Daemon-up gate via `is_daemon_running()` (ADR-0003 A2.4 consistency with
///    `pair delete`/`rename`; we do NOT auto-start — that is a later tranche).
/// 4. Open a streaming `IpcSession`, install a Ctrl+C handler, send `pair.begin`.
/// 5. Drain frames: on `pair.begin.ok` print the QR block; on a terminal frame
///    print the result and map to an exit code.
///
/// Exit codes mirror Bun: begin.err/error → 1, completed → 0, cancelled → 130.
pub fn new(args: &[String]) -> ExitCode {
    // ---- arg parsing (mirrors parseArgs strict:false, pair.ts:74-83) ----
    let mut relay_url: Option<String> = None;
    let mut daemon_id: Option<String> = None;
    let mut raw_label: Option<String> = None;
    let mut help = false;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" => help = true,
            "--relay" => {
                i += 1;
                relay_url = args.get(i).cloned();
            }
            "--daemon-id" => {
                i += 1;
                daemon_id = args.get(i).cloned();
            }
            "--label" => {
                i += 1;
                raw_label = args.get(i).cloned();
            }
            // `--relay=URL` / `--label=NAME` long-form (parseArgs accepts both).
            _ if arg.starts_with("--relay=") => {
                relay_url = Some(arg["--relay=".len()..].to_string());
            }
            _ if arg.starts_with("--daemon-id=") => {
                daemon_id = Some(arg["--daemon-id=".len()..].to_string());
            }
            _ if arg.starts_with("--label=") => {
                raw_label = Some(arg["--label=".len()..].to_string());
            }
            // strict:false — unknown args are tolerated (and ignored) by Bun.
            _ => {}
        }
        i += 1;
    }

    if help {
        print_pair_usage();
        return ExitCode::SUCCESS;
    }

    // relay default = DEFAULT_PAIRING_RELAY_URL (pair.ts:77,90).
    let relay = relay_url.unwrap_or_else(|| DEFAULT_PAIRING_RELAY_URL.to_string());

    // label: CLI flag (trimmed) or host-derived default. The Bun union is always
    // `{ set: true }` here because pair new always resolves a concrete label
    // (pair.ts:92-97).
    let raw_label_trimmed = raw_label.map(|s| s.trim().to_string()).unwrap_or_default();
    let label_value = if raw_label_trimmed.is_empty() {
        default_label()
    } else {
        raw_label_trimmed
    };
    let label: Label = make_label(Some(&label_value));
    // labelText = label.set ? label.value : defaultLabel(). Since make_label of a
    // non-empty string is always set, label_text == label_value.
    let label_text = label_value.clone();

    // ---- pair lock (config_dir()/pair.lock, pair.ts:99-106) ----
    let lock_path = config_dir().join("pair.lock");
    let Some(_lock) = acquire_pair_lock(&lock_path) else {
        eprintln!(
            "{}",
            fail_prefix("Another `tp pair new` is already running. Cancel it first.")
        );
        return ExitCode::FAILURE;
    };

    // ---- daemon-up gate (RESOLVED DECISION #1: gate, not auto-start) ----
    // The Bun reference calls ensureDaemon() (auto-start). The native CLI does
    // not yet port daemon lifecycle, so — consistent with pair delete/rename
    // (A2.4) — we require the daemon to be running and emit the same friendly
    // daemon-down error if it is not.
    if !is_daemon_running() {
        eprintln!("{}", fail_prefix(&IpcError::DaemonDown.to_string()));
        return ExitCode::FAILURE;
    }

    let mut session = match IpcSession::connect(&socket_path()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{}", fail_prefix(&format!("Pairing failed: {e}")));
            return ExitCode::FAILURE;
        }
    };

    // Shared pairing_id cell: None until pair.begin.ok. The Ctrl+C handler reads
    // it to decide between framing pair.cancel (post-ok) and shutting the socket
    // (pre-ok) — mirrors pair.ts:236-247.
    let pairing_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let writer = session.writer_handle();

    // ---- Ctrl+C handler (pair.ts:234-249 onSigint) ----
    {
        let pid_cell = Arc::clone(&pairing_id);
        let writer_for_sig = Arc::clone(&writer);
        // ctrlc::set_handler may fail only if a handler is already installed;
        // in that case Ctrl+C falls back to default SIGINT (process dies) — the
        // pair lock still releases via Drop on exit, so this is safe to ignore.
        let _ = ctrlc::set_handler(move || {
            let pid = pid_cell.lock().ok().and_then(|g| g.clone());
            if let Some(pid) = pid {
                // Post-ok: frame a pair.cancel through the shared writer.
                let cancel = IpcMessage::PairCancel { pairing_id: pid };
                if let Ok(json) = serde_json::to_vec(&cancel) {
                    let frame = crate::codec::encode_frame(&json);
                    if let Ok(mut guard) = writer_for_sig.lock() {
                        let _ = guard.write_all(&frame);
                        let _ = guard.flush();
                    }
                }
            } else {
                // Pre-ok: no pairingId yet — shut the socket so the daemon's
                // onDisconnect cancels any half-begun PendingPairing.
                if let Ok(guard) = writer_for_sig.lock() {
                    let _ = guard.shutdown(Shutdown::Both);
                }
            }
        });
    }

    // ---- send pair.begin (pair.ts:251-257) ----
    let begin = IpcMessage::PairBegin {
        relay_url: relay.clone(),
        daemon_id,
        label: Some(label),
    };
    if let Err(e) = session.send(&begin) {
        eprintln!("{}", fail_prefix(&format!("Pairing failed: {e}")));
        return ExitCode::FAILURE;
    }

    // ---- drain frames (pair.ts:157-229) ----
    // Every terminal frame (begin.err / completed / cancelled / error) `break`s
    // the loop immediately, so the `Err(Closed)` arm is only reached when the
    // daemon closes the socket BEFORE any terminal frame — i.e. the `settled`
    // guard the Bun reference needs (pair.ts:148-153, because its onMessage and
    // onClose callbacks race on the same event loop) is structurally guaranteed
    // here by the single-threaded match-then-break loop. No flag required.
    //
    // `raw_guard` holds raw mode for the duration of the wait when `can_copy`
    // is true (see PairBeginOk arm). It is taken (set to None) before every
    // break-with-output path so the terminal is restored to cooked mode before
    // any final message is printed. If the process exits without going through a
    // terminal arm (bug/panic), Drop restores the terminal automatically.
    let mut raw_guard: Option<RawModeGuard> = None;
    let exit = loop {
        match session.recv() {
            Ok(IpcMessage::PairBeginOk {
                pairing_id: pid,
                qr_string,
                daemon_id: did,
            }) => {
                // Store the pairing id for the Ctrl+C handler.
                if let Ok(mut guard) = pairing_id.lock() {
                    *guard = Some(pid);
                }
                // Render the QR image (glyphs may differ; the URL below is exact).
                let qr = render_qr_small(&qr_string);
                if !qr.is_empty() {
                    println!("{qr}");
                }
                // Byte-exact contract lines (pair.ts:164-170).
                println!("\nDaemon ID:    {did}");
                println!("Label:        {label_text}");
                println!("Relay:        {relay}");
                println!(
                    "\n{}",
                    dim("Scan with the iPhone Camera app, or paste this URL in Teleprompter:")
                );
                println!("{qr_string}");

                // canCopy gate (pair.ts:173). The native CLI mounts a raw-mode
                // crossterm event loop on a side thread when copy is supported,
                // mirroring ink's inherently-raw single-keypress detection in the
                // Bun reference (pair.ts:283-325, `useInput` is raw mode). Either
                // way the hint line is byte-exact.
                let can_copy = is_clipboard_support_likely() && io::stdin().is_terminal();
                if can_copy {
                    // pair.ts:178-180 — the entire string is inside dim().
                    println!("\n{}", dim("Press c to copy URL  ·  Ctrl+C to cancel"));
                    // Enable raw mode on the main thread so the terminal delivers
                    // keystrokes immediately (no line-buffer). The guard is held
                    // until we break out of this loop, at which point we take() it
                    // (cooked mode restored) before printing the final message.
                    // If enabling raw mode fails (not a TTY despite is_terminal check,
                    // or platform restriction), fall back to the cooked-mode branch
                    // gracefully by skipping the spawn.
                    if let Ok(guard) = RawModeGuard::enable() {
                        raw_guard = Some(guard);
                        spawn_copy_listener(
                            qr_string.clone(),
                            Arc::clone(&pairing_id),
                            Arc::clone(&writer),
                        );
                    }
                    // If raw mode fails we simply wait without a copy affordance —
                    // the hint line is already printed and Ctrl+C still works via
                    // the signal handler (canonical mode preserves SIGINT).
                } else {
                    // pair.ts:183-185 — only "Waiting..." is dimmed; the
                    // " (Ctrl+C to cancel)" suffix is plain, on the SAME line.
                    println!(
                        "\n{} (Ctrl+C to cancel)",
                        dim("Waiting for your app to scan the QR...")
                    );
                }
            }
            Ok(IpcMessage::PairBeginErr { reason, message }) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
                let suffix = message
                    .as_deref()
                    .map(|m| format!(" — {m}"))
                    .unwrap_or_default();
                // Serialize the reason enum to its bare wire string (e.g.
                // "already-pending"), stripping serde_json's quotes — same
                // pattern as delete/rename.
                let reason_str = serde_json::to_string(&reason)
                    .unwrap_or_else(|_| format!("{reason:?}"))
                    .trim_matches('"')
                    .to_string();
                eprintln!(
                    "{}",
                    fail_prefix(&format!("Pairing failed: {reason_str}{suffix}"))
                );
                break ExitCode::FAILURE;
            }
            Ok(IpcMessage::PairCompleted {
                daemon_id: did,
                label: completed_label,
                ..
            }) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
                let name = label_to_nullable(&completed_label)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| did.clone());
                println!("{}", ok_prefix(&format!("Paired {name} ({did})")));
                break ExitCode::SUCCESS;
            }
            Ok(IpcMessage::PairCancelled { .. }) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
                eprintln!("{}", dim("Pairing cancelled."));
                break exit_code(130);
            }
            Ok(IpcMessage::PairError {
                reason, message, ..
            }) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
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
                    fail_prefix(&format!("Pairing error: {reason_str}{suffix}"))
                );
                break ExitCode::FAILURE;
            }
            // Any other validated message is not part of the handshake — ignore
            // (mirrors Bun's `default:` arm, pair.ts:217-222).
            Ok(_) => {}
            Err(IpcError::Closed) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
                // Clean EOF reached BEFORE any terminal frame (a terminal frame
                // would have broken the loop already), so this is always the
                // genuine "daemon disconnected mid-pairing" case — print the
                // line unconditionally (pair.ts:225-229 onClose, with `settled`
                // structurally false here).
                eprintln!("{}", fail_prefix("Daemon disconnected — pairing aborted."));
                break ExitCode::FAILURE;
            }
            Err(e) => {
                // Restore cooked mode before printing so the line ends correctly.
                drop(raw_guard.take());
                eprintln!("{}", fail_prefix(&format!("Pairing failed: {e}")));
                break ExitCode::FAILURE;
            }
        }
    };

    // Tear down the session (joins the reader thread) and release the lock via
    // Drop. `_lock` is held until here.
    session.shutdown();
    exit
}

/// Map an exit code integer to an `ExitCode`. `ExitCode::from` takes a `u8`,
/// which covers the 130 (128+SIGINT) we emit for the cancelled path.
fn exit_code(code: u8) -> ExitCode {
    ExitCode::from(code)
}

/// Spawn a detached side thread that reads keyboard events in raw mode and, on
/// `c` / `C`, copies the URL to the clipboard via OSC 52 and prints the result.
///
/// This is the native analogue of the Bun ink keypress app (pair.ts:272-322)
/// for the `c`-to-copy affordance. The Bun version uses ink's `useInput` which
/// is inherently raw-mode (single-keypress, no Enter required). The previous
/// Rust port used `stdin.read()` in canonical mode, requiring `c`+Enter — this
/// function fixes that by using `crossterm::event::read()`.
///
/// Raw mode is enabled on the **main thread** by the caller (via `RawModeGuard`)
/// BEFORE this thread is spawned. The main-thread guard is dropped (cooked mode
/// restored) when the main `recv()` loop breaks — covering all exit paths
/// including panic. This thread does NOT own a `RawModeGuard`; it reads events
/// from the already-raw terminal.
///
/// Ctrl+C handling in raw mode: the OS no longer auto-translates Ctrl+C into
/// SIGINT while the terminal is raw, so the `ctrlc` signal handler is dead for
/// keyboard Ctrl+C. This thread detects `KeyCode::Char('c')` with the `CONTROL`
/// modifier (crossterm's representation of `0x03`) and performs the same cancel
/// logic as the signal handler: if a pairingId is known, send `pair.cancel` over
/// IPC; otherwise shut the socket so the daemon aborts the pending pairing.
///
/// The thread is detached: the process exits when a terminal IPC frame arrives
/// (main loop breaks), which kills this thread implicitly. The main-thread guard
/// drop happens before the final output, so the shell is never left in raw mode.
fn spawn_copy_listener(
    url: String,
    pid_cell: Arc<Mutex<Option<String>>>,
    writer: Arc<Mutex<std::os::unix::net::UnixStream>>,
) {
    let _ = std::thread::Builder::new()
        .name("tp-pair-copy".to_string())
        .spawn(move || {
            loop {
                // `event::read()` blocks until a key/mouse/resize event.
                // It operates on the already-raw stdin (raw mode enabled by
                // the main thread before this thread was spawned).
                let Ok(ev) = event::read() else {
                    return; // read error → exit thread
                };

                let Event::Key(key) = ev else {
                    continue; // mouse/resize — ignore
                };

                // Ctrl+C: raw mode suppresses SIGINT from the kernel, so we
                // must handle it here — same logic as the ctrlc signal handler.
                if key.code == KeyCode::Char('c')
                    && key.modifiers.contains(KeyModifiers::CONTROL)
                {
                    let pid = pid_cell.lock().ok().and_then(|g| g.clone());
                    if let Some(pid) = pid {
                        // Post-ok: frame a pair.cancel through the IPC writer.
                        let cancel = IpcMessage::PairCancel { pairing_id: pid };
                        if let Ok(json) = serde_json::to_vec(&cancel) {
                            let frame = crate::codec::encode_frame(&json);
                            if let Ok(mut guard) = writer.lock() {
                                let _ = guard.write_all(&frame);
                                let _ = guard.flush();
                            }
                        }
                    } else {
                        // Pre-ok: shut the socket so the daemon aborts.
                        if let Ok(guard) = writer.lock() {
                            let _ = guard.shutdown(Shutdown::Both);
                        }
                    }
                    return;
                }

                // `c` / `C` without modifiers → copy URL to clipboard.
                if (key.code == KeyCode::Char('c') || key.code == KeyCode::Char('C'))
                    && key.modifiers.is_empty()
                {
                    let result = copy_to_clipboard(&url);
                    // Print using \r\n: raw mode does not translate \n to \r\n,
                    // so without \r the cursor would stay at the same column.
                    // This matches how session.rs renders output in raw mode.
                    if result.ok {
                        print!("\n\r{}\r\n", green("Copied to clipboard"));
                    } else {
                        print!(
                            "\n\r{}\r\n",
                            dim("Clipboard copy not supported by this terminal — copy the URL above manually")
                        );
                    }
                    let _ = io::stdout().flush();
                    return;
                }

                // Any other key → ignore (keep waiting).
            }
        });
}

/// Print the `tp pair` usage block. Byte-exact port of `printPairUsage`
/// (pair.ts:696-709), shared with the `-h` path of `new`/`rename`.
fn print_pair_usage() {
    println!();
    println!("tp pair — manage mobile app pairings");
    println!();
    println!("Usage:");
    println!("  tp pair [--relay URL]                        Alias for 'tp pair new'");
    println!("  tp pair new [--relay URL] [--label <name>]   Generate a QR and BLOCK until the");
    println!(
        "                                               mobile app scans it (Ctrl+C to cancel)."
    );
    println!("                                               Auto-starts the daemon if needed.");
    println!("  tp pair list                                 List registered (completed) pairings");
    println!("  tp pair rename <daemon-id> <label...>        Rename a pairing (prefix match)");
    println!(
        "  tp pair delete <daemon-id> [-y]              Delete a pairing (prefix match allowed)"
    );
    println!();
}
