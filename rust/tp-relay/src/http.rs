//! HTTP surface — `/health`, `/metrics`, `/admin` — sharing the same axum
//! `Router` (and the same listener) as the WS `/` upgrade route.
//!
//! Field/byte parity with the TS reference `relay-server.ts`:
//!
//! * **`/health`** (`relay-server.ts:419-435`) — JSON, key order: `status`,
//!   `buildSha`, `buildTime`, `protocolVersion`, `clients`, `pendingAuth`,
//!   `daemons`, `sessions`, `attached`, `uptime`, `metrics`.
//! * **`/metrics`** (`relay-server.ts:438-466`) — Prometheus text v0.0.4, the
//!   exact 17 lines in TS order, joined with `\n` + a trailing `\n`,
//!   `Content-Type: text/plain; version=0.0.4`.
//! * **`/admin`** (`relay-server.ts:470-512`) — HTML dashboard. **Redesign-now:
//!   the TS `/admin` is unauthenticated (a security wart). This port closes it
//!   behind a bearer token** read from `TP_RELAY_ADMIN_TOKEN`: env unset → 404
//!   (closed by default), set + correct `Authorization: Bearer <token>` → 200,
//!   absent/wrong → 401. The bearer compare is constant-time AND
//!   length-independent: both tokens are keyed-BLAKE2b'd with a per-process
//!   random key, then the fixed 32-byte digests are `subtle`-compared (so the
//!   response time leaks neither the token contents nor its length).
//!
//! Build identity (`buildSha`/`buildTime`) is injected at compile time by
//! `build.rs` and read here via `env!`.

use std::fmt::Write as _;
use std::sync::OnceLock;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use blake2::digest::generic_array::typenum::U32;
use blake2::digest::{FixedOutput, Mac};
use blake2::Blake2bMac;
use rand_core::{OsRng, RngCore};
use subtle::ConstantTimeEq;

use crate::metrics::MetricsSnapshot;
use crate::server::SharedState;

/// Compile-time build SHA, injected by `build.rs` (`TP_BUILD_SHA`). `"unknown"`
/// for local/uninstrumented builds. Mirrors `BUILD_SHA` (`relay-server.ts:23`).
///
/// **Compile-time, not runtime**: this is frozen by `env!` at build time (CI sets
/// `TP_BUILD_SHA`/`github.sha` BEFORE `cargo build`; `build.rs` `rerun-if-env-changed`
/// guarantees the recompile). Setting `TP_BUILD_SHA` in the *process* environment
/// at launch does NOT change it — same semantics as the TS `bun build --define`.
pub const BUILD_SHA: &str = env!("TP_BUILD_SHA");

/// Compile-time build timestamp, injected by `build.rs` (`TP_BUILD_TIME`).
/// `"unknown"` for local builds. Mirrors `BUILD_TIME` (`relay-server.ts:26`).
/// Compile-time only — see [`BUILD_SHA`] for the runtime-env caveat.
pub const BUILD_TIME: &str = env!("TP_BUILD_TIME");

/// Wire `protocolVersion` reported by `/health`. Mirrors `relay-server.ts:426`.
pub const PROTOCOL_VERSION: u32 = 2;

/// The Prometheus exposition content type. Mirrors `relay-server.ts:465`.
pub const METRICS_CONTENT_TYPE: &str = "text/plain; version=0.0.4";

/// Env var holding the `/admin` bearer token. When **unset**, `/admin` returns
/// 404 (closed by default — never serve an unauthenticated dashboard).
pub const ADMIN_TOKEN_ENV: &str = "TP_RELAY_ADMIN_TOKEN";

/// Aggregate counts computed in a single pass over `daemon_states` plus the
/// conn-table-derived `clients`/`pending_auth`. Mirrors `aggregateDaemonStats`
/// (`relay-server.ts:575-589`) folded together with `clients.size` /
/// `pendingAuth.size` so `/health` + `/metrics` take the `RelayCore` lock once.
struct CoreAggregate {
    clients: usize,
    pending_auth: usize,
    daemons_online: usize,
    sessions_total: usize,
    attached_total: usize,
}

/// Take the `RelayCore` lock ONCE and fold all the counts `/health` + `/metrics`
/// need. `clients` = AUTHENTICATED conns only (`h.auth.is_some()`), byte-parity
/// with the TS `clients` Map which holds authenticated clients alone
/// (`relay-server.ts:240`, surfaced at `:427`/`:443`). `pendingAuth` = conns with
/// no auth yet (`h.auth.is_none()`), the Rust mirror of the TS `pendingAuth` Map
/// (`relay-server.ts:268`, surfaced at `:428`/`:444`). Every conn is in exactly
/// one bucket, so `clients + pendingAuth == conns.len()`.
fn aggregate(state: &SharedState, include_attached: bool) -> CoreAggregate {
    // LOCK: synchronous read — no `.await` inside.
    let core = state.core.lock().expect("relay core mutex poisoned");
    let clients = core.conns.values().filter(|h| h.auth.is_some()).count();
    // Invariant: clients + pending_auth == conns.len() (every conn is in exactly
    // one bucket). Use subtraction instead of a second filter pass (#19 fix).
    let pending_auth = core.conns.len() - clients;
    let mut daemons_online = 0;
    let mut sessions_total = 0;
    let mut attached_total = 0;
    for s in core.registry.daemon_states.values() {
        if s.online {
            daemons_online += 1;
        }
        sessions_total += s.sessions.len();
        // Only accumulate attached_total when the caller needs it (/health).
        // The /metrics path does not emit attached_total (#20 fix).
        if include_attached {
            attached_total += s.attached.len();
        }
    }
    CoreAggregate {
        clients,
        pending_auth,
        daemons_online,
        sessions_total,
        attached_total,
    }
    // guard dropped here
}

/// Process uptime in whole seconds (`Math.floor(process.uptime())` parity,
/// `relay-server.ts:432`/`463`).
#[allow(clippy::cast_possible_truncation)]
fn uptime_secs(state: &SharedState) -> u64 {
    state.started_at.elapsed().as_secs()
}

/// `GET /health` — JSON with the TS key order. Built by hand (NOT `serde_json`'s
/// derive, which would sort nothing but cannot guarantee insertion order across
/// types) so the serialized key order is byte-identical to the TS `Response.json`
/// object literal: `status, buildSha, buildTime, protocolVersion, clients,
/// pendingAuth, daemons, sessions, attached, uptime, metrics`.
pub async fn health(State(state): State<SharedState>) -> Response {
    let agg = aggregate(&state, true); // include_attached=true: /health emits attached
    let m = state.metrics.snapshot();
    let uptime = uptime_secs(&state);
    let body = render_health_json(&agg, &m, uptime);
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// Render the `/health` JSON body with the exact TS key order. `serde_json::json!`
/// on a `Map` would alphabetise; we build the string positionally instead.
fn render_health_json(agg: &CoreAggregate, m: &MetricsSnapshot, uptime: u64) -> String {
    // `buildSha`/`buildTime` are operator-controlled compile-time constants, but
    // JSON-escape them anyway so an exotic value can never break the body.
    let build_sha = json_escape(BUILD_SHA);
    let build_time = json_escape(BUILD_TIME);
    format!(
        concat!(
            "{{",
            "\"status\":\"ok\",",
            "\"buildSha\":\"{build_sha}\",",
            "\"buildTime\":\"{build_time}\",",
            "\"protocolVersion\":{protocol_version},",
            "\"clients\":{clients},",
            "\"pendingAuth\":{pending_auth},",
            "\"daemons\":{daemons},",
            "\"sessions\":{sessions},",
            "\"attached\":{attached},",
            "\"uptime\":{uptime},",
            "\"metrics\":{{",
            "\"framesIn\":{frames_in},",
            "\"framesOut\":{frames_out},",
            "\"rateLimitedDrops\":{rate_limited_drops},",
            "\"daemonRateLimitedDrops\":{daemon_rate_limited_drops},",
            "\"backpressureDisconnects\":{backpressure_disconnects},",
            "\"authTimeouts\":{auth_timeouts},",
            "\"oversizedDrops\":{oversized_drops},",
            "\"unknownTypeDrops\":{unknown_type_drops},",
            "\"evictions\":{evictions},",
            "\"resumesAttempted\":{resumes_attempted},",
            "\"resumesAccepted\":{resumes_accepted},",
            "\"resumesRejected\":{resumes_rejected}",
            "}}",
            "}}"
        ),
        build_sha = build_sha,
        build_time = build_time,
        protocol_version = PROTOCOL_VERSION,
        clients = agg.clients,
        pending_auth = agg.pending_auth,
        daemons = agg.daemons_online,
        sessions = agg.sessions_total,
        attached = agg.attached_total,
        uptime = uptime,
        frames_in = m.frames_in,
        frames_out = m.frames_out,
        rate_limited_drops = m.rate_limited_drops,
        daemon_rate_limited_drops = m.daemon_rate_limited_drops,
        backpressure_disconnects = m.backpressure_disconnects,
        auth_timeouts = m.auth_timeouts,
        oversized_drops = m.oversized_drops,
        unknown_type_drops = m.unknown_type_drops,
        evictions = m.evictions,
        resumes_attempted = m.resumes_attempted,
        resumes_accepted = m.resumes_accepted,
        resumes_rejected = m.resumes_rejected,
    )
}

/// `GET /metrics` — Prometheus text v0.0.4, the exact 17 TS lines + trailing
/// newline. Mirrors `relay-server.ts:438-466`.
pub async fn metrics(State(state): State<SharedState>) -> Response {
    let agg = aggregate(&state, false); // include_attached=false: /metrics does not emit attached
    let m = state.metrics.snapshot();
    let uptime = uptime_secs(&state);
    let body = render_metrics_text(&agg, &m, uptime);
    ([(header::CONTENT_TYPE, METRICS_CONTENT_TYPE)], body).into_response()
}

/// Build the Prometheus text body. The 17 lines, in TS order
/// (`relay-server.ts:443-463`), joined with `\n` and a trailing `\n`.
fn render_metrics_text(agg: &CoreAggregate, m: &MetricsSnapshot, uptime: u64) -> String {
    let lines = [
        format!("relay_clients {}", agg.clients),
        format!("relay_pending_auth {}", agg.pending_auth),
        format!("relay_daemons_online {}", agg.daemons_online),
        format!("relay_sessions_total {}", agg.sessions_total),
        format!("relay_frames_in {}", m.frames_in),
        format!("relay_frames_out {}", m.frames_out),
        format!("relay_rate_limited_drops {}", m.rate_limited_drops),
        format!(
            "relay_daemon_rate_limited_drops {}",
            m.daemon_rate_limited_drops
        ),
        format!(
            "relay_backpressure_disconnects {}",
            m.backpressure_disconnects
        ),
        format!("relay_auth_timeouts {}", m.auth_timeouts),
        format!("relay_oversized_drops {}", m.oversized_drops),
        format!("relay_unknown_type_drops {}", m.unknown_type_drops),
        format!("relay_evictions {}", m.evictions),
        format!("relay_resumes_attempted {}", m.resumes_attempted),
        format!("relay_resumes_accepted {}", m.resumes_accepted),
        format!("relay_resumes_rejected {}", m.resumes_rejected),
        format!("relay_uptime_seconds {uptime}"),
    ];
    let mut body = lines.join("\n");
    body.push('\n');
    body
}

/// A daemon row for the `/admin` table (escaped id + escaped session ids +
/// online flag + ISO `lastSeen`).
struct AdminDaemonRow {
    id: String,
    online: bool,
    sessions: Vec<String>,
    last_seen_iso: String,
}

/// `GET /admin` — bearer-gated HTML dashboard. See module docs for the gate
/// matrix (unset→404, wrong/absent→401, correct→200).
///
/// # Panics
///
/// Panics only if the `RelayCore` mutex is poisoned (a prior panic while holding
/// the routing lock), which is unrecoverable for the whole relay.
pub async fn admin(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    let Some(expected) = std::env::var(ADMIN_TOKEN_ENV)
        .ok()
        .filter(|t| !t.is_empty())
    else {
        // Closed by default: never serve an unauthenticated dashboard.
        return StatusCode::NOT_FOUND.into_response();
    };
    if !bearer_ok(&headers, &expected) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // Take the core lock ONCE to get both the daemon rows and the clients count
    // (consistent snapshot — #18 fix eliminates the double-lock inconsistency
    // where `collect_admin_rows` and the `clients` read came from different
    // instants and could disagree under concurrent writes).
    let (rows, clients) = {
        let core = state.core.lock().expect("relay core mutex poisoned");
        let clients = core.conns.values().filter(|h| h.auth.is_some()).count();
        let rows = core
            .registry
            .daemon_states
            .iter()
            .map(|(id, s)| AdminDaemonRow {
                id: id.clone(),
                online: s.online,
                sessions: s.sessions.iter().cloned().collect(),
                last_seen_iso: iso8601_millis(s.last_seen),
            })
            .collect::<Vec<_>>();
        (rows, clients)
        // guard dropped here
    };
    let html = render_admin_html(clients, uptime_secs(&state), &rows);
    ([(header::CONTENT_TYPE, "text/html")], html).into_response()
}

/// Validate the `Authorization: Bearer <token>` header against `expected` in
/// constant time. Absent header / wrong scheme / mismatch → `false`.
fn bearer_ok(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    // Constant-time compare that does NOT leak the token length. A raw
    // `ct_eq` on the two byte slices short-circuits when their lengths differ
    // (subtle's documented slice limitation), letting an attacker binary-search
    // the correct length by timing. Instead, keyed-BLAKE2b BOTH values with a
    // per-process random key and `ct_eq` the two fixed 32-byte digests: the
    // comparison is now over equal-length inputs regardless of token length,
    // and the random key prevents offline digest precomputation.
    let key = bearer_hash_key();
    keyed_digest(key, token.as_bytes())
        .ct_eq(&keyed_digest(key, expected.as_bytes()))
        .into()
}

/// Per-process random key for [`keyed_digest`]. Generated once via `OsRng`; never
/// persisted or exposed. Only purpose is to make the `/admin` bearer compare
/// length-independent (and resist offline precomputation of the digest).
fn bearer_hash_key() -> &'static [u8; 32] {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    KEY.get_or_init(|| {
        let mut k = [0u8; 32];
        OsRng.fill_bytes(&mut k);
        k
    })
}

/// Keyed BLAKE2b-256 of `data`. Used only to fold a variable-length bearer token
/// into a fixed 32-byte digest so the comparison is constant-time regardless of
/// the presented token's length. Mirrors the `blake2` usage in `resume_token.rs`.
fn keyed_digest(key: &[u8; 32], data: &[u8]) -> [u8; 32] {
    let mut mac =
        Blake2bMac::<U32>::new_from_slice(key).expect("32-byte key is always valid for Blake2bMac");
    mac.update(data);
    mac.finalize_fixed().into()
}

/// Render the `/admin` HTML, mirroring the TS markup (`relay-server.ts:477-508`).
/// Daemon id + every session id are HTML-escaped via [`escape_html`] (XSS guard,
/// `relay-server.ts:500/502`).
fn render_admin_html(clients: usize, uptime: u64, rows: &[AdminDaemonRow]) -> String {
    let table = if rows.is_empty() {
        "<p style=\"color:#666\">No daemons connected</p>".to_string()
    } else {
        let mut t = String::from(
            "\n<table><tr><th>ID</th><th>Status</th><th>Sessions</th><th>Last Seen</th></tr>\n",
        );
        for d in rows {
            let badge_class = if d.online { "badge-on" } else { "badge-off" };
            let status = if d.online { "online" } else { "offline" };
            let sessions = if d.sessions.is_empty() {
                "—".to_string()
            } else {
                d.sessions
                    .iter()
                    .map(|s| escape_html(s))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let _ = write!(
                t,
                "<tr><td style=\"font-family:monospace;font-size:.85rem\">{id}</td>\n\
<td><span class=\"badge {badge_class}\">{status}</span></td>\n\
<td>{sessions}</td>\n\
<td style=\"color:#888;font-size:.85rem\">{last_seen}</td></tr>",
                id = escape_html(&d.id),
                last_seen = d.last_seen_iso,
            );
        }
        t.push_str("\n</table>");
        t
    };
    format!(
        "<!DOCTYPE html>\n\
<html><head><title>Teleprompter Relay</title>\n\
<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\n\
<style>body{{font-family:system-ui;background:#111;color:#eee;padding:2rem;max-width:800px;margin:0 auto}}\n\
h1{{color:#fff;font-size:1.5rem}}table{{width:100%;border-collapse:collapse;margin:1rem 0}}\n\
td,th{{padding:.5rem;text-align:left;border-bottom:1px solid #333}}\n\
th{{color:#888;font-size:.75rem;text-transform:uppercase}}.ok{{color:#4ade80}}.off{{color:#666}}\n\
.badge{{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.75rem}}\n\
.badge-on{{background:#166534;color:#4ade80}}.badge-off{{background:#333;color:#888}}\n\
#refresh{{color:#60a5fa;cursor:pointer;font-size:.75rem}}</style></head>\n\
<body><h1>Teleprompter Relay</h1>\n\
<p>Clients: <b>{clients}</b> | Uptime: <b>{uptime}s</b>\n\
<span id=\"refresh\" onclick=\"location.reload()\"> ↻ refresh</span></p>\n\
<h2 style=\"font-size:1rem;color:#888\">Daemons ({daemon_count})</h2>\n\
{table}\n\
</body></html>",
        clients = clients,
        uptime = uptime,
        daemon_count = rows.len(),
        table = table,
    )
}

/// Escape the five HTML-significant characters before interpolating
/// attacker-controlled strings (daemon id, session ids) into the `/admin`
/// markup. Byte-exact port of `escapeHtml` (`relay-server.ts:60-67`): replaces
/// `&`, `<`, `>`, `"`, `'` (in that order).
#[must_use]
pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// JSON-escape a string's CONTENT (no surrounding quotes) for safe interpolation
/// into the hand-built `/health` body. Defers to `serde_json` (which produces a
/// quoted, fully-escaped string) and strips the surrounding quotes. Used only for
/// the two operator-controlled compile-time build constants, which are ASCII in
/// practice (git sha / RFC3339 timestamp / `"unknown"`).
fn json_escape(s: &str) -> String {
    let quoted = serde_json::Value::String(s.to_string()).to_string();
    // `to_string()` on a JSON string is always `"<escaped>"`; drop the quotes.
    quoted
        .strip_prefix('"')
        .and_then(|q| q.strip_suffix('"'))
        .unwrap_or(&quoted)
        .to_string()
}

/// Format an epoch-millis timestamp as an ISO-8601 / RFC-3339 UTC string with
/// millisecond precision and a `Z` suffix, matching JS
/// `new Date(ms).toISOString()` (`relay-server.ts:475`), e.g.
/// `2026-06-19T12:34:56.789Z`. Pure integer civil-calendar math (no chrono dep).
#[must_use]
#[allow(
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::many_single_char_names
)]
fn iso8601_millis(ms: u64) -> String {
    let total_secs = ms / 1000;
    let millis = ms % 1000;
    let secs = total_secs % 60;
    let total_mins = total_secs / 60;
    let mins = total_mins % 60;
    let total_hours = total_mins / 60;
    let hours = total_hours % 24;
    let days = total_hours / 24; // days since 1970-01-01

    // Civil-from-days (Howard Hinnant's algorithm), days are non-negative here.
    let z = days as i64 + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{secs:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::Metrics;

    fn zero_agg() -> CoreAggregate {
        CoreAggregate {
            clients: 0,
            pending_auth: 0,
            daemons_online: 0,
            sessions_total: 0,
            attached_total: 0,
        }
    }

    #[test]
    fn metrics_text_has_17_lines_in_ts_order_with_trailing_newline() {
        let body = render_metrics_text(&zero_agg(), &Metrics::new().snapshot(), 0);
        assert!(body.ends_with('\n'), "must end with a trailing newline");
        // Strip the single trailing newline, then split — 17 content lines.
        let trimmed = body.strip_suffix('\n').unwrap();
        let lines: Vec<&str> = trimmed.split('\n').collect();
        assert_eq!(lines.len(), 17, "exactly 17 metric lines");
        let names: Vec<&str> = lines.iter().map(|l| l.split(' ').next().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "relay_clients",
                "relay_pending_auth",
                "relay_daemons_online",
                "relay_sessions_total",
                "relay_frames_in",
                "relay_frames_out",
                "relay_rate_limited_drops",
                "relay_daemon_rate_limited_drops",
                "relay_backpressure_disconnects",
                "relay_auth_timeouts",
                "relay_oversized_drops",
                "relay_unknown_type_drops",
                "relay_evictions",
                "relay_resumes_attempted",
                "relay_resumes_accepted",
                "relay_resumes_rejected",
                "relay_uptime_seconds",
            ]
        );
    }

    #[test]
    fn metrics_text_values_reflect_snapshot() {
        let m = Metrics::new();
        m.inc_frames_in();
        m.inc_frames_in();
        m.inc_oversized_drops();
        let agg = CoreAggregate {
            clients: 5,
            pending_auth: 2,
            daemons_online: 3,
            sessions_total: 7,
            attached_total: 4,
        };
        let body = render_metrics_text(&agg, &m.snapshot(), 99);
        assert!(body.contains("relay_clients 5\n"));
        assert!(body.contains("relay_pending_auth 2\n"));
        assert!(body.contains("relay_daemons_online 3\n"));
        assert!(body.contains("relay_sessions_total 7\n"));
        assert!(body.contains("relay_frames_in 2\n"));
        assert!(body.contains("relay_oversized_drops 1\n"));
        assert!(body.ends_with("relay_uptime_seconds 99\n"));
    }

    #[test]
    fn health_json_key_order_matches_ts() {
        let body = render_health_json(&zero_agg(), &Metrics::new().snapshot(), 0);
        // Assert the exact key order on the serialized string (positions only).
        let order = [
            "\"status\"",
            "\"buildSha\"",
            "\"buildTime\"",
            "\"protocolVersion\"",
            "\"clients\"",
            "\"pendingAuth\"",
            "\"daemons\"",
            "\"sessions\"",
            "\"attached\"",
            "\"uptime\"",
            "\"metrics\"",
            // nested metrics object keys, in RelayMetrics order
            "\"framesIn\"",
            "\"framesOut\"",
            "\"rateLimitedDrops\"",
            "\"daemonRateLimitedDrops\"",
            "\"backpressureDisconnects\"",
            "\"authTimeouts\"",
            "\"oversizedDrops\"",
            "\"unknownTypeDrops\"",
            "\"evictions\"",
            "\"resumesAttempted\"",
            "\"resumesAccepted\"",
            "\"resumesRejected\"",
        ];
        let mut last = 0usize;
        for key in order {
            let pos = body
                .find(key)
                .unwrap_or_else(|| panic!("missing key {key}"));
            assert!(pos >= last, "key {key} out of order in {body}");
            last = pos;
        }
        // And the literal "ok" status + protocolVersion 2 are present.
        assert!(body.contains("\"status\":\"ok\""));
        assert!(body.contains("\"protocolVersion\":2"));
        // The body must be valid JSON (parse round-trip).
        let _: serde_json::Value = serde_json::from_str(&body).expect("health body is valid JSON");
    }

    #[test]
    fn health_json_is_valid_and_parses_to_expected_values() {
        let agg = CoreAggregate {
            clients: 11,
            pending_auth: 4,
            daemons_online: 2,
            sessions_total: 9,
            attached_total: 3,
        };
        let m = Metrics::new();
        m.inc_resumes_rejected();
        let body = render_health_json(&agg, &m.snapshot(), 42);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["protocolVersion"], 2);
        assert_eq!(v["clients"], 11);
        assert_eq!(v["pendingAuth"], 4);
        assert_eq!(v["daemons"], 2);
        assert_eq!(v["sessions"], 9);
        assert_eq!(v["attached"], 3);
        assert_eq!(v["uptime"], 42);
        assert_eq!(v["metrics"]["resumesRejected"], 1);
        assert_eq!(v["metrics"]["framesIn"], 0);
    }

    #[test]
    fn escape_html_ports_the_five_replacements() {
        assert_eq!(
            escape_html("<img src=x onerror=alert('xss')>&\"y\""),
            "&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;&amp;&quot;y&quot;"
        );
        // Ordering matters: an already-escaped `&` must not be double-escaped.
        assert_eq!(escape_html("&lt;"), "&amp;lt;");
    }

    #[test]
    fn admin_html_escapes_daemon_and_session_ids() {
        let rows = vec![AdminDaemonRow {
            id: "<evil>".to_string(),
            online: true,
            sessions: vec!["s<1>".to_string(), "s&2".to_string()],
            last_seen_iso: "2026-06-19T00:00:00.000Z".to_string(),
        }];
        let html = render_admin_html(1, 5, &rows);
        assert!(html.contains("&lt;evil&gt;"), "daemon id escaped");
        assert!(html.contains("s&lt;1&gt;"), "session id escaped");
        assert!(html.contains("s&amp;2"), "session ampersand escaped");
        assert!(!html.contains("<evil>"), "raw daemon id must not leak");
        assert!(html.contains("badge-on"), "online badge");
        assert!(html.contains("Daemons (1)"));
    }

    #[test]
    fn admin_html_empty_state() {
        let html = render_admin_html(0, 0, &[]);
        assert!(html.contains("No daemons connected"));
        assert!(html.contains("Daemons (0)"));
    }

    #[test]
    fn bearer_ok_constant_time_match() {
        let mut headers = HeaderMap::new();
        headers.insert(header::AUTHORIZATION, "Bearer s3cr3t".parse().unwrap());
        assert!(bearer_ok(&headers, "s3cr3t"));
        assert!(!bearer_ok(&headers, "wrong"));
        // Differing-length tokens still reject (and the keyed-digest compare runs
        // over equal-length 32-byte digests, so length no longer short-circuits).
        assert!(!bearer_ok(&headers, "s3cr3"));
        assert!(!bearer_ok(&headers, "s3cr3tXX"));
        assert!(!bearer_ok(&headers, ""));
    }

    #[test]
    fn keyed_digest_is_deterministic_and_fixed_length() {
        let key = bearer_hash_key();
        // Same input → same digest; different-length inputs → same 32-byte width.
        assert_eq!(keyed_digest(key, b"abc"), keyed_digest(key, b"abc"));
        assert_ne!(keyed_digest(key, b"abc"), keyed_digest(key, b"abcd"));
        assert_eq!(keyed_digest(key, b"x").len(), 32);
        assert_eq!(keyed_digest(key, b"a much longer token value").len(), 32);
    }

    #[test]
    fn bearer_ok_rejects_missing_and_wrong_scheme() {
        let empty = HeaderMap::new();
        assert!(!bearer_ok(&empty, "tok"));
        let mut basic = HeaderMap::new();
        basic.insert(header::AUTHORIZATION, "Basic dXNlcjpwYXNz".parse().unwrap());
        assert!(!bearer_ok(&basic, "tok"));
        // Bearer prefix is exact: a different scheme spelling is rejected.
        let mut lower = HeaderMap::new();
        lower.insert(header::AUTHORIZATION, "bearer tok".parse().unwrap());
        assert!(!bearer_ok(&lower, "tok"));
    }

    #[test]
    fn iso8601_matches_known_epochs() {
        assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
        // Values cross-checked against JS `new Date(x).toISOString()`.
        assert_eq!(
            iso8601_millis(1_781_181_296_789),
            "2026-06-11T12:34:56.789Z"
        );
        // Leap-year day: 2024-02-29.
        assert_eq!(
            iso8601_millis(1_709_208_000_000),
            "2024-02-29T12:00:00.000Z"
        );
    }

    #[test]
    fn build_constants_are_non_empty() {
        assert!(!BUILD_SHA.is_empty(), "TP_BUILD_SHA must be injected");
        assert!(!BUILD_TIME.is_empty(), "TP_BUILD_TIME must be injected");
    }

    #[test]
    fn aggregate_clients_counts_authenticated_only() {
        use std::collections::HashSet;

        use tokio::sync::mpsc;
        use tp_proto::relay_client::Role;

        use crate::server::{AuthState, ConnHandle, SharedState};

        // Byte-parity guard for the TS `clients` (authenticated Map) vs the
        // Rust conn table (authed + pre-auth). `clients` must reflect ONLY
        // `h.auth.is_some()`; `pendingAuth` the complement. See
        // `relay-server.ts:240/427/443` (clients) + `:268/428/444` (pendingAuth).
        let state = SharedState::from_env();
        {
            let mut core = state.core.lock().unwrap();
            let authed = |daemon: &str| AuthState {
                role: Role::Frontend,
                daemon_id: daemon.to_string(),
                frontend_id: Some("f".to_string()),
                subscriptions: HashSet::new(),
            };
            // Insert 2 authenticated + 3 pending-auth conns.
            for (id, auth) in [
                (1u64, Some(authed("d1"))),
                (2u64, Some(authed("d2"))),
                (3u64, None),
                (4u64, None),
                (5u64, None),
            ] {
                let (tx, rx) = mpsc::channel(8);
                let (ctx, crx) = mpsc::channel(4);
                let mut h = ConnHandle::new(tx, ctx, 500);
                h.auth = auth;
                core.conns.insert(id, h);
                std::mem::forget(rx);
                std::mem::forget(crx);
            }
        }
        let agg = aggregate(&state, true);
        assert_eq!(agg.clients, 2, "clients = authenticated conns only");
        assert_eq!(agg.pending_auth, 3, "pendingAuth = unauthenticated conns");
        // Partition invariant: clients + pendingAuth == total conns.
        assert_eq!(agg.clients + agg.pending_auth, 5);
    }
}
