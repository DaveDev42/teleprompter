//! HTTP surface integration tests — drive the real axum `Router` (the SAME one
//! that serves the WS `/` route) via `tower::ServiceExt::oneshot`, no TCP
//! listener. Asserts the `/health` + `/metrics` + `/admin` parity contract:
//!
//! * `/metrics` — 17 lines in TS order, trailing newline, `text/plain;
//!   version=0.0.4` content type.
//! * `/health` — JSON key order matches the TS `Response.json` literal.
//! * `/admin` — bearer gate matrix: env unset → 404, wrong/absent → 401, correct
//!   → 200 with HTML-escaped daemon/session ids.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt; // for `oneshot`

use tp_relay::server::SharedState;
use tp_relay::RelayServer;

fn router() -> axum::Router {
    let state = SharedState::from_env();
    RelayServer::with_state(state).router()
}

async fn get(router: axum::Router, uri: &str) -> (StatusCode, Vec<(String, String)>, String) {
    let resp = router
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

async fn get_with_auth(
    router: axum::Router,
    uri: &str,
    authorization: Option<&str>,
) -> (StatusCode, String) {
    let mut req = Request::builder().uri(uri);
    if let Some(a) = authorization {
        req = req.header("authorization", a);
    }
    let resp = router
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn metrics_endpoint_17_lines_trailing_newline_content_type() {
    let (status, headers, body) = get(router(), "/metrics").await;
    assert_eq!(status, StatusCode::OK);
    let ct = headers
        .iter()
        .find(|(k, _)| k == "content-type")
        .map(|(_, v)| v.as_str())
        .unwrap();
    assert_eq!(ct, "text/plain; version=0.0.4");
    assert!(body.ends_with('\n'), "trailing newline required");

    let trimmed = body.strip_suffix('\n').unwrap();
    let names: Vec<&str> = trimmed
        .split('\n')
        .map(|l| l.split(' ').next().unwrap())
        .collect();
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

#[tokio::test]
async fn health_endpoint_json_key_order_and_values() {
    let (status, headers, body) = get(router(), "/health").await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers
        .iter()
        .any(|(k, v)| k == "content-type" && v.contains("application/json")));

    // Top-level key order on the raw serialized string.
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
    ];
    let mut last = 0usize;
    for key in order {
        let pos = body.find(key).unwrap_or_else(|| panic!("missing {key}"));
        assert!(pos >= last, "{key} out of order");
        last = pos;
    }

    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["status"], "ok");
    assert_eq!(v["protocolVersion"], 2);
    assert_eq!(v["clients"], 0);
    assert_eq!(v["daemons"], 0);
    assert!(v["metrics"].is_object());
}

/// The full `/admin` bearer-gate matrix in ONE test. `TP_RELAY_ADMIN_TOKEN` is
/// process-global, so all of its set/unset transitions live here (rather than
/// across several `#[tokio::test]` functions that would race on the env var and
/// force a `MutexGuard`-across-await). Env mutation happens between awaits, never
/// while a lock is held.
#[tokio::test]
async fn admin_bearer_gate_matrix() {
    // 1. Env UNSET → 404 (closed by default).
    std::env::remove_var("TP_RELAY_ADMIN_TOKEN");
    let (status, _) = get_with_auth(router(), "/admin", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "unset token → 404");

    // 2. Env set, header absent → 401.
    std::env::set_var("TP_RELAY_ADMIN_TOKEN", "correct-horse");
    let (status, _) = get_with_auth(router(), "/admin", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "absent header → 401");

    // 3. Env set, wrong token → 401.
    let (status, _) = get_with_auth(router(), "/admin", Some("Bearer wrong")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "wrong token → 401");

    // 4. Env set, correct token → 200 + escaped HTML. Seed a daemon with an
    //    XSS-bait id + session so the escaping path runs.
    let state = SharedState::from_env();
    {
        let mut core = state.core.lock().unwrap();
        core.registry.valid_tokens.insert("tk".into(), "<x>".into());
        core.registry.handle_auth("<x>", "tk", true, 0).unwrap();
        core.registry.daemon_pub("<x>", "s<1>".into(), 0);
    }
    let seeded = RelayServer::with_state(state).router();
    let (status, body) = get_with_auth(seeded, "/admin", Some("Bearer correct-horse")).await;
    assert_eq!(status, StatusCode::OK, "correct token → 200");
    assert!(body.contains("Teleprompter Relay"));
    assert!(body.contains("&lt;x&gt;"), "daemon id escaped");
    assert!(body.contains("s&lt;1&gt;"), "session id escaped");
    assert!(!body.contains("<x>"), "raw daemon id must not leak");

    std::env::remove_var("TP_RELAY_ADMIN_TOKEN");
}
