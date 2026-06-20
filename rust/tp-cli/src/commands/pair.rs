//! `tp pair list` — list registered pairings.
//!
//! Byte-exact port of `apps/cli/src/commands/pair.ts` `pairList` (lines
//! 406-451). Reads the Store directly; empty store prints "No pairings
//! registered." + a hint. Otherwise a fixed-width LABEL/DAEMON ID/RELAY/CREATED
//! table (column widths = max(header, values); LABEL = decoded label or empty;
//! CREATED = `format_age` of `created_at`).

use std::process::ExitCode;

use crate::commands::session::pad_end;
use crate::format::format_age;
use crate::store::list_pairings;
use crate::util::now_ms;

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
