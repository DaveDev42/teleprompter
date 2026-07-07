//! Session export markdown formatter.
//!
//! Byte-exact port of `packages/daemon/src/export-formatter.ts`. Pure
//! formatting over already-loaded `StoredRecord`s — no DB access.

use serde_json::Value;

use crate::store::session_db::StoredRecord;

const IO_MERGE_GAP_MS: i64 = 2000;

/// Event names that render as `### {Display Name}` + full JSON block.
/// Mirrors `JSON_BLOCK_EVENTS` (export-formatter.ts).
fn json_block_display_name(name: &str) -> Option<&'static str> {
    match name {
        "PermissionRequest" => Some("Permission Request"),
        "Elicitation" => Some("Elicitation"),
        "ElicitationResult" => Some("Elicitation Result"),
        "SubagentStart" => Some("Subagent Start"),
        "SubagentStop" => Some("Subagent Stop"),
        "SessionStart" => Some("Session Start"),
        "SessionEnd" => Some("Session End"),
        _ => None,
    }
}

fn json_block(heading: &str, data: &Value) -> String {
    let pretty = serde_json::to_string_pretty(data).unwrap_or_default();
    format!("### {heading}\n\n```json\n{pretty}\n```")
}

/// Minimal state machine reproducing the `ansi-regex` package's pattern
/// (OSC `ESC ] ... ST` non-greedy, or CSI `ESC/C1 [params] final-byte`),
/// mirroring what `strip-ansi` (used by export-formatter.ts) strips from PTY
/// output before it lands in a markdown export.
#[must_use]
pub fn strip_ansi(input: &str) -> String {
    // Fast path: no ESC (0x1B) or C1 CSI (0x9B) introducer present.
    if !input.contains('\u{1B}') && !input.contains('\u{9B}') {
        return input.to_string();
    }

    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\u{1B}' && chars.get(i + 1) == Some(&']') {
            // OSC: ESC ] ... ST, non-greedy until first ST (BEL, ESC\, or 0x9C).
            let mut j = i + 2;
            let mut consumed = false;
            while j < chars.len() {
                if chars[j] == '\u{07}' {
                    j += 1;
                    consumed = true;
                    break;
                }
                if chars[j] == '\u{1B}' && chars.get(j + 1) == Some(&'\\') {
                    j += 2;
                    consumed = true;
                    break;
                }
                if chars[j] == '\u{9C}' {
                    j += 1;
                    consumed = true;
                    break;
                }
                j += 1;
            }
            if consumed {
                i = j;
                continue;
            }
            // No terminator found — not a well-formed OSC sequence; fall
            // through to CSI/plain-char handling for this ESC.
        }
        if c == '\u{1B}' || c == '\u{9B}' {
            // CSI: [ESC|0x9B] [ ] ( ) # ; ? ]* (params)? final-byte
            let mut j = i + 1;
            // Intermediate bytes: one of ][()#;?
            while j < chars.len() && matches!(chars[j], ']' | '[' | '(' | ')' | '#' | ';' | '?') {
                j += 1;
            }
            // Optional params: digits with ; or : separators.
            if j < chars.len() && chars[j].is_ascii_digit() {
                let start = j;
                while j < chars.len()
                    && (chars[j].is_ascii_digit() || chars[j] == ';' || chars[j] == ':')
                {
                    j += 1;
                }
                // ansi-regex bounds each param group to 1-4 digits repeated;
                // for stripping purposes consuming the full digit/sep run is
                // equivalent since final-byte set never overlaps digits/;/:.
                debug_assert!(j > start);
            }
            // Final byte: one of \d A-P R-T Z c f-n q-u y = > < ~
            if j < chars.len() {
                let f = chars[j];
                let is_final = f.is_ascii_digit()
                    || ('A'..='P').contains(&f)
                    || ('R'..='T').contains(&f)
                    || f == 'Z'
                    || f == 'c'
                    || ('f'..='n').contains(&f)
                    || ('q'..='u').contains(&f)
                    || f == 'y'
                    || f == '='
                    || f == '>'
                    || f == '<'
                    || f == '~';
                if is_final {
                    i = j + 1;
                    continue;
                }
            }
            // Not a recognized CSI final byte — treat the introducer as a
            // literal character (matches regex non-match: nothing consumed
            // beyond one char via the outer loop).
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Format one `event` record as a markdown block.
#[must_use]
pub fn format_event_record(rec: &StoredRecord) -> String {
    let raw = String::from_utf8_lossy(&rec.payload).into_owned();
    let data: Option<Value> = serde_json::from_str(&raw).ok();

    let Some(data) = data else {
        return format!("### {}\n\n{}", rec.name.as_deref().unwrap_or("Event"), raw);
    };
    if data.is_null() {
        return format!("### {}\n\n{}", rec.name.as_deref().unwrap_or("Event"), raw);
    }

    match rec.name.as_deref() {
        Some("Stop") => {
            if let Some(msg) = data.get("last_assistant_message").and_then(Value::as_str) {
                if !msg.is_empty() {
                    return format!("### Assistant Response\n\n{msg}");
                }
            }
            // Any truthy `last_assistant_message` (including non-string,
            // non-empty JSON values) takes the plain-text arm in TS; a
            // present-but-falsy value (missing, "", null, 0, false) falls
            // through to the JSON block, mirroring `if (data["last_assistant_message"])`.
            if let Some(v) = data.get("last_assistant_message") {
                if is_js_truthy(v) {
                    return format!("### Assistant Response\n\n{}", json_display(v));
                }
            }
            json_block("Assistant Response", &data)
        }
        Some("UserPromptSubmit") => {
            if let Some(v) = data.get("prompt") {
                if is_js_truthy(v) {
                    let text = json_display(v);
                    let quoted = text.replace('\n', "\n> ");
                    return format!("### User\n\n> {quoted}");
                }
            }
            json_block("User", &data)
        }
        Some("PreToolUse") => {
            let tool_name = data
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let empty = Value::Null;
            let tool_input = data.get("tool_input").unwrap_or(&empty);
            json_block(&format!("Tool Use: {tool_name}"), tool_input)
        }
        Some("PostToolUse") => {
            let tool_name = data
                .get("tool_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let empty = Value::Null;
            let result = data
                .get("tool_result")
                .filter(|v| is_js_truthy(v))
                .or_else(|| data.get("tool_input"))
                .unwrap_or(&empty);
            json_block(&format!("Tool Result: {tool_name}"), result)
        }
        other => {
            let display_name = other
                .and_then(json_block_display_name)
                .map(str::to_string)
                .or_else(|| other.map(str::to_string))
                .unwrap_or_else(|| "Event".to_string());
            json_block(&display_name, &data)
        }
    }
}

/// JS-truthiness for a parsed JSON value (mirrors `if (x)` in the TS source):
/// falsy = `null`, `false`, `0`/`0.0`, `""`; everything else truthy.
fn is_js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Render a JSON value the way JS string interpolation (`${value}`) would:
/// strings pass through verbatim, everything else uses its JSON text.
fn json_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Merge consecutive `io` records into ```terminal fenced blocks, splitting
/// on gaps > `IO_MERGE_GAP_MS` between consecutive timestamps.
#[must_use]
pub fn format_io_records(records: &[StoredRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }

    let mut blocks: Vec<String> = Vec::new();
    let mut current_block = String::new();
    let mut last_ts: i64 = 0;

    for rec in records {
        let text = strip_ansi(&String::from_utf8_lossy(&rec.payload));
        if text.trim().is_empty() {
            continue;
        }

        if last_ts > 0 && rec.ts - last_ts > IO_MERGE_GAP_MS && !current_block.is_empty() {
            blocks.push(format!("```terminal\n{current_block}\n```"));
            current_block.clear();
        }

        current_block.push_str(&text);
        last_ts = rec.ts;
    }

    if !current_block.is_empty() {
        blocks.push(format!("```terminal\n{current_block}\n```"));
    }

    blocks.join("\n\n")
}

fn format_meta_record(rec: &StoredRecord) -> String {
    let label = format!("Meta: {}", rec.name.as_deref().unwrap_or("unknown"));
    let raw = String::from_utf8_lossy(&rec.payload).into_owned();
    match serde_json::from_str::<Value>(&raw) {
        Ok(data) => json_block(&label, &data),
        Err(_) => format!("### {label}\n\n{raw}"),
    }
}

/// Minimal session metadata needed for the export header. A subset of the
/// wire `SessionMeta` (inc1 does not port `session-meta.ts`'s wire
/// conversion; callers pass the fields the header needs directly).
#[derive(Debug, Clone)]
pub struct ExportSessionMeta {
    pub sid: String,
    pub cwd: String,
    pub state: String,
    pub created_at_ms: i64,
}

/// Render a full session export as GitHub-flavored markdown.
#[must_use]
pub fn format_markdown(
    meta: &ExportSessionMeta,
    records: &[StoredRecord],
    truncated: bool,
) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push(format!("# Session: {}", meta.sid));
    lines.push(format!("- CWD: {}", meta.cwd));
    lines.push(format!("- State: {}", meta.state));
    lines.push(format!("- Created: {}", format_iso8601(meta.created_at_ms)));
    lines.push(String::new());

    let mut i = 0;
    while i < records.len() {
        let rec = &records[i];
        match rec.kind.as_str() {
            "io" => {
                let start = i;
                while i < records.len() && records[i].kind == "io" {
                    i += 1;
                }
                let formatted = format_io_records(&records[start..i]);
                if !formatted.is_empty() {
                    lines.push(formatted);
                    lines.push(String::new());
                }
            }
            "event" => {
                lines.push(format_event_record(rec));
                lines.push(String::new());
                i += 1;
            }
            "meta" => {
                lines.push(format_meta_record(rec));
                lines.push(String::new());
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    if truncated {
        lines.push("> **Note:** Export truncated at the configured record limit.".to_string());
        lines.push(String::new());
    }

    lines.join("\n")
}

/// Render a millisecond Unix timestamp as `Date.prototype.toISOString()`
/// would: `YYYY-MM-DDTHH:MM:SS.sssZ`. Hand-rolled (no chrono dependency in
/// this crate) — proleptic Gregorian civil-from-days algorithm, valid for the
/// full range `Date` supports.
fn format_iso8601(ms: i64) -> String {
    let millis = ms.rem_euclid(1000);
    let secs_total = ms.div_euclid(1000);
    let days = secs_total.div_euclid(86400);
    let secs_of_day = secs_total.rem_euclid(86400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    let (year, month, day) = civil_from_days(days);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch → (Y, M, D).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(kind: &str, ts: i64, name: Option<&str>, payload: &[u8]) -> StoredRecord {
        StoredRecord {
            seq: 0,
            kind: kind.to_string(),
            ts,
            ns: None,
            name: name.map(str::to_string),
            payload: payload.to_vec(),
        }
    }

    #[test]
    fn strip_ansi_removes_csi_color_codes() {
        let input = "\u{1B}[31mred\u{1B}[0m plain";
        assert_eq!(strip_ansi(input), "red plain");
    }

    #[test]
    fn strip_ansi_noop_without_escape() {
        assert_eq!(strip_ansi("plain text"), "plain text");
    }

    #[test]
    fn strip_ansi_removes_osc_sequence() {
        // OSC 8 hyperlink: ESC ] 8 ; ; url BEL text ESC ] 8 ; ; BEL
        let input = "\u{1B}]8;;http://example.com\u{07}link\u{1B}]8;;\u{07}";
        assert_eq!(strip_ansi(input), "link");
    }

    #[test]
    fn format_event_stop_renders_assistant_response() {
        let payload = br#"{"last_assistant_message":"PONG"}"#;
        let r = rec("event", 1, Some("Stop"), payload);
        assert_eq!(format_event_record(&r), "### Assistant Response\n\nPONG");
    }

    #[test]
    fn format_event_user_prompt_submit_renders_quoted() {
        let payload = br#"{"prompt":"line1\nline2"}"#;
        let r = rec("event", 1, Some("UserPromptSubmit"), payload);
        assert_eq!(format_event_record(&r), "### User\n\n> line1\n> line2");
    }

    #[test]
    fn format_event_pre_tool_use_renders_json_block() {
        let payload = br#"{"tool_name":"Bash","tool_input":{"command":"ls"}}"#;
        let r = rec("event", 1, Some("PreToolUse"), payload);
        let out = format_event_record(&r);
        assert!(out.starts_with("### Tool Use: Bash\n\n```json\n"));
        assert!(out.contains("\"command\": \"ls\""));
    }

    #[test]
    fn format_event_unknown_name_uses_json_block_display_map() {
        let payload = br#"{"foo":"bar"}"#;
        let r = rec("event", 1, Some("SessionStart"), payload);
        let out = format_event_record(&r);
        assert!(out.starts_with("### Session Start\n\n```json\n"));
    }

    #[test]
    fn format_event_invalid_json_falls_back_to_raw() {
        let r = rec("event", 1, Some("Weird"), b"not json");
        assert_eq!(format_event_record(&r), "### Weird\n\nnot json");
    }

    #[test]
    fn format_io_records_merges_within_gap_and_splits_on_large_gap() {
        let recs = vec![
            rec("io", 1000, None, b"hello "),
            rec("io", 1500, None, b"world"),
            rec("io", 5000, None, b"far apart"),
        ];
        let out = format_io_records(&recs);
        assert_eq!(
            out,
            "```terminal\nhello world\n```\n\n```terminal\nfar apart\n```"
        );
    }

    #[test]
    fn format_io_records_empty_returns_empty_string() {
        assert_eq!(format_io_records(&[]), "");
    }

    #[test]
    fn format_markdown_includes_header_and_truncation_note() {
        let meta = ExportSessionMeta {
            sid: "sess-1".to_string(),
            cwd: "/tmp/work".to_string(),
            state: "stopped".to_string(),
            created_at_ms: 0,
        };
        let out = format_markdown(&meta, &[], true);
        assert!(out.starts_with("# Session: sess-1\n- CWD: /tmp/work\n- State: stopped\n- Created: 1970-01-01T00:00:00.000Z"));
        assert!(out.contains("Export truncated at the configured record limit."));
    }

    #[test]
    fn iso8601_matches_known_epoch() {
        assert_eq!(format_iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_iso8601(1_700_000_000_000),
            "2023-11-14T22:13:20.000Z"
        );
    }
}
