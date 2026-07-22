//! Real-claude session modes — print / interactive M5 / coding / webpage.
//!
//! Faithful port of the retired Bun holder's `startClaudeSession*` family.
//! Every session is spawned as a standalone Rust `tp-runner` process against
//! the isolated daemon socket (never via the daemon's `SessionManager`), BEFORE
//! pairing, so the app's first `hello` already lists it (race-free sequencing —
//! a print session ends within seconds, but a stopped session still appears in
//! the store listing).
//!
//! First-run dialog handling (`answer_first_run_prompts`) answers claude's
//! prompts for the harness's OWN throwaway sandbox HOME by reading the live PTY
//! io and sending the CORRECT key for whichever dialog is on screen — NOT a
//! context-free Enter. The dialogs have OPPOSITE safe options (empirically,
//! claude 2.1.198 through the real `tp run` PTY):
//!   - "Is this a project you trust?" — default = "1. Yes, I trust this
//!     folder"; bare Enter accepts.
//!   - "Bypass Permissions mode" disclaimer — default = "1. No, exit"; a bare
//!     Enter QUITS. Accept = Down-arrow + Enter (`\x1b[B` then `\r`). Digit
//!     selection is avoided because "2" means "No, exit" on the trust dialog.
//!   - settings-error gate ("Continue without these settings") — pick "3".
//!
//! Config seeds in `~/.claude.json` do NOT suppress these dialogs when bypass
//! is requested via `--permission-mode`, so they are dismissed live.
//!
//! Turn driving (`send_turn`): prompt text (no CR) → 1.5 s composer settle →
//! SEPARATE `\r` submit (a CR glued to the text lands in claude's multi-line
//! paste buffer and never submits) → confirm UserPromptSubmit incremented
//! (resend the submit on warmup keystroke-drops, ≤5 attempts × 8 s) → wait for
//! that turn's Stop (180 s). Turn gating reads the SAME per-session DB the
//! harness asserts on.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::json;
use tp_proto::ipc::IpcMessage;

use crate::db::count_records;
use crate::db::read_recent_io;
use crate::envcfg::env_nonempty;
use crate::ipc::IpcWriter;
use crate::out::{contract, die, log};
use crate::spawn::{spawn_runner, SharedChildren};

/// The fixed sid (`TP_E2E_CLAUDE_SID`, default `real-smoke-sess`) — the harness
/// asserts markers/DB rows against it without knowing a generated id.
pub fn claude_sid() -> String {
    env_nonempty("TP_E2E_CLAUDE_SID").unwrap_or_else(|| "real-smoke-sess".to_string())
}

fn claude_cwd() -> String {
    env_nonempty("TP_E2E_CLAUDE_CWD")
        .or_else(|| env_nonempty("HOME"))
        .unwrap_or_else(|| ".".to_string())
}

fn ensure_cwd(cwd: &str) {
    if let Err(err) = std::fs::create_dir_all(cwd) {
        die(&format!("mkdir {cwd} failed: {err}"));
    }
}

/// Pre-seed trust + onboarding in the isolated HOME's `~/.claude.json`. NOTE:
/// neither key reliably SUPPRESSES the first-run dialogs when bypass is
/// requested via the CLI flag (see module docs) — they stay only as harmless
/// belt-and-suspenders should a future claude honour them from this file.
fn seed_claude_json(cwd: &str) {
    let Some(home) = env_nonempty("HOME") else {
        return;
    };
    let mut projects = serde_json::Map::new();
    projects.insert(cwd.to_string(), json!({ "hasTrustDialogAccepted": true }));
    let seed = json!({
        "hasCompletedOnboarding": true,
        "bypassPermissionsModeAccepted": true,
        "projects": projects,
    });
    let path = std::path::Path::new(&home).join(".claude.json");
    if let Err(err) = std::fs::write(&path, seed.to_string()) {
        log(&format!("WARN — could not seed ~/.claude.json: {err}"));
    }
}

/// Raw-byte sender: IPC `input` frames the daemon routes by sid to the runner's
/// PTY. `log_suffix` preserves the Bun holder's per-mode log wording.
#[derive(Clone)]
struct RawSender {
    writer: IpcWriter,
    sid: String,
    log_suffix: &'static str,
}

impl RawSender {
    fn send(&self, bytes: &str, label: &str) {
        let data = BASE64_STANDARD.encode(bytes.as_bytes());
        let msg = IpcMessage::Input {
            sid: self.sid.clone(),
            data,
        };
        match self.writer.send(&msg) {
            Ok(()) => log(&format!("sent {label}{}", self.log_suffix)),
            Err(err) => log(&format!("WARN — failed to send {label}: {err}")),
        }
    }

    /// A standalone carriage return — submits whatever is in claude's composer
    /// (and accepts the trust dialog's highlighted option).
    fn submit(&self, label: &str) {
        self.send("\r", &format!("submit ({label})"));
    }
}

/// Content-aware first-run dialog driver (see module docs). Resolves once
/// claude submits a real prompt (UserPromptSubmit > baseline) or ~40 s elapses.
fn answer_first_run_prompts(sid: &str, sender: &RawSender) {
    let ups_baseline = count_records(sid, "event", "UserPromptSubmit");
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut ticks = 0u32;
    while Instant::now() < deadline {
        // Past the gates once claude accepts and processes a prompt.
        if count_records(sid, "event", "UserPromptSubmit") > ups_baseline {
            return;
        }
        ticks += 1;
        let io = read_recent_io(sid, 6);
        let on_bypass_dialog =
            io.contains("Bypass Permissions mode") || io.contains("Yes, I accept");
        let on_trust_dialog = io.contains("Yes, I trust this folder");
        let on_settings_error = io.contains("Continue without these settings")
            || (io.contains("Files with errors are skipped") && io.contains("Fix with Claude"));
        if on_settings_error {
            sender.send("3", &format!("settings-error continue (tick {ticks})"));
            std::thread::sleep(Duration::from_millis(250));
            sender.send("\r", &format!("settings-error confirm (tick {ticks})"));
        } else if on_bypass_dialog {
            // Down-arrow to "Yes, I accept", then Enter. Never a bare Enter here.
            sender.send("\x1b[B", &format!("bypass-dialog select (tick {ticks})"));
            std::thread::sleep(Duration::from_millis(250));
            sender.send("\r", &format!("bypass-dialog confirm (tick {ticks})"));
        } else if on_trust_dialog {
            // Default is already "Yes, I trust" — Enter accepts.
            sender.send("\r", &format!("trust-dialog accept (tick {ticks})"));
        } else {
            // Cold start or already at the REPL — a stray Enter is harmless
            // (empty submit). Nudge in case the dialog render lagged the DB.
            sender.send("\r", &format!("trust nudge (tick {ticks})"));
        }
        std::thread::sleep(Duration::from_millis(1_500));
    }
}

fn wait_for_stop_count(sid: &str, target: i64, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if count_records(sid, "event", "Stop") >= target {
            return true;
        }
        std::thread::sleep(Duration::from_millis(1_000));
    }
    false
}

/// Drive one coding/webpage turn robustly (see module docs). Returns true once
/// the turn's UserPromptSubmit AND its Stop are both observed.
fn send_turn(sid: &str, sender: &RawSender, text: &str, turn_index: u32, kind_label: &str) -> bool {
    let ups_before = count_records(sid, "event", "UserPromptSubmit");
    let stops_before = count_records(sid, "event", "Stop");
    // Type the text (no CR), let the composer settle, then submit.
    sender.send(
        text,
        &format!("{kind_label} turn {turn_index} text ({} chars)", text.len()),
    );
    std::thread::sleep(Duration::from_millis(1_500));
    sender.submit(&format!("turn {turn_index}"));
    // Confirm the prompt registered; resend submit on warmup drops (≤5 tries).
    let mut registered = false;
    for attempt in 1..=5u32 {
        let deadline = Instant::now() + Duration::from_millis(8_000);
        while Instant::now() < deadline {
            if count_records(sid, "event", "UserPromptSubmit") > ups_before {
                registered = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if registered {
            break;
        }
        log(&format!(
            "turn {turn_index}: UserPromptSubmit not yet incremented (attempt {attempt}) — resending submit"
        ));
        sender.submit(&format!("turn {turn_index} retry {attempt}"));
    }
    if !registered {
        log(&format!(
            "WARN — turn {turn_index}: prompt never registered (UserPromptSubmit)"
        ));
        return false;
    }
    log(&format!(
        "turn {turn_index}: prompt registered; waiting for its Stop"
    ));
    let ok = wait_for_stop_count(sid, stops_before + 1, Duration::from_millis(180_000));
    if ok {
        log(&format!("turn {turn_index}: Stop observed (turn complete)"));
    } else {
        log(&format!(
            "WARN — turn {turn_index}: Stop never observed within 180s"
        ));
    }
    ok
}

/// `--run-claude` (TP_E2E_CLAUDE=1): print mode. `claude -p <prompt>` fires the
/// Stop hook deterministically with a populated `last_assistant_message` → M4.
pub fn start_print(children: &SharedChildren, socket_path: &str) {
    let sid = claude_sid();
    let cwd = claude_cwd();
    let prompt = env_nonempty("TP_E2E_CLAUDE_PROMPT")
        .unwrap_or_else(|| "Reply with exactly: PONG".to_string());
    ensure_cwd(&cwd);
    log(&format!(
        "spawning real claude session sid={sid} cwd={cwd} (print mode)"
    ));
    let pid = spawn_runner(
        children,
        &sid,
        &cwd,
        socket_path,
        &["-p", &prompt, "--dangerously-skip-permissions"],
    );
    // Emit the sid so the harness can override SMOKE_SESSION_ID for the M4 assertion.
    contract(&format!("REAL_SESSION_SID={sid}"));
    log(&format!("real claude runner spawned (pid {pid})"));
}

/// `--run-claude-interactive` (TP_E2E_CLAUDE_M5=1): interactive REPL (live PTY)
/// so the APP's input round-trip (M5 auto-probe) can be exercised. The detached
/// dialog driver leaves claude idle at the REPL before the app's probe lands.
pub fn start_interactive(children: &SharedChildren, writer: IpcWriter, socket_path: &str) {
    let sid = claude_sid();
    let cwd = claude_cwd();
    ensure_cwd(&cwd);
    seed_claude_json(&cwd);
    log(&format!(
        "spawning real claude session sid={sid} cwd={cwd} (INTERACTIVE)"
    ));
    let pid = spawn_runner(
        children,
        &sid,
        &cwd,
        socket_path,
        &["--permission-mode", "bypassPermissions"],
    );
    contract(&format!("REAL_SESSION_SID={sid}"));
    log(&format!(
        "real interactive claude runner spawned (pid {pid})"
    ));

    let sender = RawSender {
        writer,
        sid: sid.clone(),
        log_suffix: " to interactive claude",
    };
    // Detached so the holder proceeds to pairing immediately (the app pairs +
    // probes concurrently). Must finish before the app's probe so the probe
    // text is never consumed as a dialog keystroke.
    std::thread::spawn(move || answer_first_run_prompts(&sid, &sender));
}

/// `--run-claude-coding` (TP_E2E_CLAUDE_CODING=1): interactive claude driven
/// through TWO real coding turns (Write then Bash) over the genuine pipeline.
/// The harness asserts the deterministic side-effects (file on disk, DB
/// UserPromptSubmit/Stop ≥ 2, PostToolUse hook events) — not model text.
pub fn start_coding(children: &SharedChildren, writer: IpcWriter, socket_path: &str) {
    let sid = claude_sid();
    let cwd = claude_cwd();
    ensure_cwd(&cwd);
    seed_claude_json(&cwd);
    log(&format!(
        "spawning real claude session sid={sid} cwd={cwd} (CODING multi-turn)"
    ));
    let pid = spawn_runner(
        children,
        &sid,
        &cwd,
        socket_path,
        &["--permission-mode", "bypassPermissions"],
    );
    contract(&format!("REAL_SESSION_SID={sid}"));
    log(&format!("real coding claude runner spawned (pid {pid})"));

    let marker = env_nonempty("TP_E2E_CODING_MARKER").unwrap_or_else(|| "QA-CODING-OK".to_string());
    let file_name =
        env_nonempty("TP_E2E_CODING_FILE").unwrap_or_else(|| "tp_qa_marker.txt".to_string());
    let turn1 = format!(
        "Create a file named {file_name} in the current directory containing exactly this text and nothing else: {marker}"
    );
    let turn2 = format!("Now run this shell command: cat {file_name} && echo BUILD-STEP-DONE");

    let sender = RawSender {
        writer,
        sid: sid.clone(),
        log_suffix: "",
    };
    // Detached driver chain: dialogs → turn 1 → turn 2 (strictly ordered — each
    // turn is gated on its own Stop inside send_turn). Failures are logged, not
    // fatal: the harness's marker/DB/file assertions are the real pass/fail.
    std::thread::spawn(move || {
        answer_first_run_prompts(&sid, &sender);
        let _ = send_turn(&sid, &sender, &turn1, 1, "coding");
        let _ = send_turn(&sid, &sender, &turn2, 2, "coding");
        log("coding turn driver finished (both turns attempted)");
    });
}

/// `--run-claude-webpage` (TP_E2E_WEBPAGE=1): sibling of the coding mode —
/// TWO turns building + validating a complete HTML5 page. Highest spawn-flag
/// precedence (webpage > coding > interactive > print).
pub fn start_webpage(children: &SharedChildren, writer: IpcWriter, socket_path: &str) {
    let sid = claude_sid();
    let cwd = claude_cwd();
    ensure_cwd(&cwd);
    seed_claude_json(&cwd);
    log(&format!(
        "spawning real claude session sid={sid} cwd={cwd} (WEBPAGE multi-turn)"
    ));
    let pid = spawn_runner(
        children,
        &sid,
        &cwd,
        socket_path,
        &["--permission-mode", "bypassPermissions"],
    );
    contract(&format!("REAL_SESSION_SID={sid}"));
    log(&format!("real webpage claude runner spawned (pid {pid})"));

    let marker =
        env_nonempty("TP_E2E_WEBPAGE_MARKER").unwrap_or_else(|| "TP-WEBPAGE-OK".to_string());
    let file_name = env_nonempty("TP_E2E_WEBPAGE_FILE").unwrap_or_else(|| "index.html".to_string());
    let turn1 = format!(
        "Create a file named {file_name} in the current directory using the Write tool. \
         The file must be a complete valid HTML5 document with: \
         a <!DOCTYPE html> declaration, an <html> element, a <head> element containing a <title>, \
         a <body> element containing an <h1> that includes the text \"{marker}\", \
         and an inline <style> block inside <head> with at least one CSS rule (e.g. body {{ font-family: sans-serif; }}). \
         Do not truncate the file — write the complete document in one Write tool call."
    );
    let turn2 = format!(
        "Now run this shell command to validate the file you just created: \
         grep -c \"<!DOCTYPE html>\" {file_name} && grep -c \"{marker}\" {file_name} && echo WEBPAGE-STEP-DONE"
    );

    let sender = RawSender {
        writer,
        sid: sid.clone(),
        log_suffix: "",
    };
    std::thread::spawn(move || {
        answer_first_run_prompts(&sid, &sender);
        let _ = send_turn(&sid, &sender, &turn1, 1, "webpage");
        let _ = send_turn(&sid, &sender, &turn2, 2, "webpage");
        log("webpage turn driver finished (both turns attempted)");
    });
}
