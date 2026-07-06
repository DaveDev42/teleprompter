//! Hook-capture settings — byte-exact port of
//! `packages/runner/src/hooks/{capture-hook,settings-builder}.ts`.
//!
//! Two pieces:
//!
//! - [`capture_hook_command`] builds the `bun -e '<script>'` one-liner that each
//!   hook shells out to. This string is **executed verbatim** by Claude Code, so
//!   it is held to strict byte-exactness with the TS output — the golden test
//!   pins the exact bytes.
//! - [`build_settings`] merges the tp hook entry into every known hook event of
//!   the project's `.claude/settings.local.json`, preserving unknown events and
//!   non-hooks fields. The result is a JSON string passed to `claude --settings`.
//!   Claude parses it as JSON (semantically), so byte-exactness of the whole
//!   object is not load-bearing — structural parity is. The merge mirrors the
//!   TS logic exactly (append tp entry per known event, pass unknown keys
//!   through, coerce non-array event values to `[]`).

use std::path::Path;

use serde_json::{json, Map, Value};

/// The 16 hook events tp registers a capture command for. Order matches
/// `HOOK_EVENTS` in `settings-builder.ts` (load-bearing for golden parity — the
/// merged `hooks` object lists known events in this order).
pub const HOOK_EVENTS: [&str; 16] = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "StopFailure",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "Elicitation",
    "ElicitationResult",
];

/// Build the `bun -e '<script>'` one-liner a hook uses to send its stdin JSON to
/// the [`crate::pty`]-adjacent HookReceiver unix socket.
///
/// Byte-exact with `captureHookCommand` (capture-hook.ts):
///
/// - The path is embedded as a JS string literal via `serde_json::to_string`
///   (the Rust analogue of `JSON.stringify` for a string — same escaping rules:
///   `"` and `\` escaped, `'` left untouched since it is not a JSON special).
/// - The whole `bun -e` argument is single-quoted; any `'` inside the script
///   (possible only if the socket path contains one) is escaped with the
///   POSIX-safe `'\''` idiom.
#[must_use]
pub fn capture_hook_command(hook_socket_path: &str) -> String {
    // serde_json::to_string on a JSON string produces a double-quoted, escaped
    // literal identical to JS `JSON.stringify("…")`. Infallible for a String.
    let js_literal_path =
        serde_json::to_string(hook_socket_path).expect("string is always serialisable");
    let script = format!(
        "const d=await Bun.stdin.text();const s=await Bun.connect({{unix:{js_literal_path},socket:{{open(s){{s.write(d);s.end()}},data(){{}},error(){{}}}}}});"
    );
    let shell_escaped = script.replace('\'', "'\\''");
    format!("bun -e '{shell_escaped}'")
}

/// The tp hook entry appended to every known event: `{matcher:"", hooks:[{type,
/// command, timeout:10}]}`. Byte-exact shape with `tpHookEntry` in
/// settings-builder.ts.
fn tp_hook_entry(command: &str) -> Value {
    json!({
        "matcher": "",
        "hooks": [{ "type": "command", "command": command, "timeout": 10 }],
    })
}

/// Read + sanitise `<cwd>/.claude/settings.local.json`, returning its top-level
/// object as a map (with a sanitised `hooks` sub-object) or `None` if the file
/// is absent, unreadable, non-JSON, or not a JSON object. Mirrors
/// `readExistingSettings`.
///
/// Sanitisation of `hooks` matches the TS: known events are coerced to arrays
/// (non-arrays → `[]`), unknown event keys are preserved only when their value
/// is an array (junk guard).
fn read_existing_settings(cwd: &Path) -> Option<Map<String, Value>> {
    let settings_path = cwd.join(".claude").join("settings.local.json");
    let text = std::fs::read_to_string(&settings_path).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    let obj = parsed.as_object()?;

    // Rebuild the top-level object, replacing `hooks` with a sanitised version
    // (matching `{ ...obj, hooks }` — obj's other keys are preserved verbatim).
    let mut out: Map<String, Value> = obj.clone();

    let mut hooks = Map::new();
    if let Some(raw_hooks) = obj.get("hooks").and_then(Value::as_object) {
        // Known events first, coercing non-arrays to [].
        for event in HOOK_EVENTS {
            let val = raw_hooks.get(event);
            let arr = match val {
                Some(Value::Array(a)) => Value::Array(a.clone()),
                _ => Value::Array(vec![]),
            };
            hooks.insert(event.to_string(), arr);
        }
        // Unknown event keys: preserve verbatim only if the value is an array.
        for (key, val) in raw_hooks {
            if !HOOK_EVENTS.contains(&key.as_str()) && val.is_array() {
                hooks.insert(key.clone(), val.clone());
            }
        }
    }
    out.insert("hooks".to_string(), Value::Object(hooks));
    Some(out)
}

/// Build the merged settings JSON string passed to `claude --settings`.
///
/// Byte-for-structure port of `buildSettings`: append the tp hook entry to each
/// known event's existing hooks, pass unknown event keys through unchanged, and
/// preserve non-hooks top-level fields from the existing settings.
///
/// `cwd` is optional — when `None`, no project settings are read and the result
/// is just the tp entry under each known event.
#[must_use]
pub fn build_settings(hook_socket_path: &str, cwd: Option<&Path>) -> String {
    let command = capture_hook_command(hook_socket_path);
    let entry = tp_hook_entry(&command);

    let existing = cwd.and_then(read_existing_settings);
    let existing_hooks: Map<String, Value> = existing
        .as_ref()
        .and_then(|e| e.get("hooks"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // Start from existing hooks (`{ ...existingHooks }`), then append the tp
    // entry to each known event. Unknown keys carried in from existing_hooks
    // are left untouched.
    let mut hooks = existing_hooks.clone();
    for event in HOOK_EVENTS {
        let mut entries = match existing_hooks.get(event) {
            Some(Value::Array(a)) => a.clone(),
            _ => vec![],
        };
        entries.push(entry.clone());
        hooks.insert(event.to_string(), Value::Array(entries));
    }

    // `{ ...existing, hooks }` — preserve non-hooks top-level fields.
    let mut settings = existing.unwrap_or_default();
    settings.insert("hooks".to_string(), Value::Object(hooks));

    serde_json::to_string(&Value::Object(settings)).expect("settings map is always serialisable")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_hook_command_is_byte_exact() {
        // Golden — pinned to the exact bytes captureHookCommand produces for a
        // plain path. If this drifts, the shelled-out hook breaks.
        let got = capture_hook_command("/tmp/hook.sock");
        let want = "bun -e 'const d=await Bun.stdin.text();const s=await Bun.connect({unix:\"/tmp/hook.sock\",socket:{open(s){s.write(d);s.end()},data(){},error(){}}});'";
        assert_eq!(got, want);
    }

    #[test]
    fn capture_hook_command_escapes_single_quote_in_path() {
        // A `'` in the path is not a JSON special (stays unescaped in the JS
        // literal) but IS a shell special — must become the POSIX `'\''` idiom.
        let got = capture_hook_command("/tmp/o'brien.sock");
        assert!(
            got.contains("\"/tmp/o'\\''brien.sock\""),
            "single-quote must be POSIX-escaped: {got}"
        );
        // The command still opens and closes its single-quoted argument. The
        // script body ends `...}});` and the closing shell quote follows, so the
        // whole command ends with `});'`.
        assert!(got.starts_with("bun -e '"));
        assert!(
            got.ends_with("});'"),
            "must close the single-quoted arg: {got}"
        );
    }

    #[test]
    fn build_settings_no_cwd_has_tp_entry_under_every_known_event() {
        let s = build_settings("/tmp/hook.sock", None);
        let v: Value = serde_json::from_str(&s).unwrap();
        let hooks = v.get("hooks").and_then(Value::as_object).unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for event in HOOK_EVENTS {
            let entries = hooks.get(event).and_then(Value::as_array).unwrap();
            assert_eq!(entries.len(), 1, "one tp entry for {event}");
            let cmd = entries[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.starts_with("bun -e '"));
            assert_eq!(entries[0]["hooks"][0]["timeout"], 10);
            assert_eq!(entries[0]["matcher"], "");
        }
    }

    #[test]
    fn build_settings_merges_existing_and_preserves_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        // Existing settings: one pre-existing Stop hook, a custom event, and a
        // non-hooks top-level field that must survive the round-trip.
        let existing = r#"{
            "model": "opus",
            "hooks": {
                "Stop": [{"matcher":"x","hooks":[{"type":"command","command":"echo hi","timeout":5}]}],
                "CustomFutureEvent": [{"matcher":"","hooks":[]}]
            }
        }"#;
        std::fs::write(claude.join("settings.local.json"), existing).unwrap();

        let s = build_settings("/tmp/hook.sock", Some(dir.path()));
        let v: Value = serde_json::from_str(&s).unwrap();

        // Non-hooks field preserved.
        assert_eq!(v["model"], "opus");
        // Stop now has the pre-existing entry AND the tp entry appended.
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["matcher"], "x");
        assert_eq!(stop[1]["matcher"], "");
        assert!(stop[1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .starts_with("bun -e '"));
        // Unknown custom event preserved untouched (no tp entry appended).
        let custom = v["hooks"]["CustomFutureEvent"].as_array().unwrap();
        assert_eq!(custom.len(), 1);
        assert_eq!(custom[0]["hooks"].as_array().unwrap().len(), 0);
        // A known event with no pre-existing hooks still gets exactly the tp entry.
        let sess = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(sess.len(), 1);
    }

    #[test]
    fn build_settings_absent_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        // No .claude/settings.local.json — behaves like the no-cwd case.
        let s = build_settings("/tmp/hook.sock", Some(dir.path()));
        let v: Value = serde_json::from_str(&s).unwrap();
        let hooks = v.get("hooks").and_then(Value::as_object).unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        // No stray non-hooks fields.
        assert_eq!(v.as_object().unwrap().len(), 1);
    }

    #[test]
    fn build_settings_coerces_non_array_event_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        // Stop is a string (junk) — must be coerced to [] then get the tp entry,
        // never spread char-by-char.
        std::fs::write(
            claude.join("settings.local.json"),
            r#"{"hooks":{"Stop":"garbage"}}"#,
        )
        .unwrap();
        let s = build_settings("/tmp/hook.sock", Some(dir.path()));
        let v: Value = serde_json::from_str(&s).unwrap();
        let stop = v["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["matcher"], "");
    }
}
