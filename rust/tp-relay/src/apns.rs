//! APNs HTTP/2 delivery client — reqwest H2 + bounded retry with backoff.
//!
//! Parity port of `packages/relay/src/apns.ts` with a REDESIGN-NOW addition:
//! **APNs 429 / 5xx retry** (the TS source has no retry at all).
//!
//! ## Parity mapping
//!
//! | TS source | Rust equivalent |
//! |-----------|-----------------|
//! | `APNS_DEAD_TOKEN_REASONS` (`apns.ts:37-40`) | [`APNS_DEAD_TOKEN_REASONS`] (`HashSet`) |
//! | `ApnsDeliveryResult` (`apns.ts:42-45`) | [`ApnsDeliveryResult`] |
//! | `ApnsPayload` (`apns.ts:47-58`) | [`ApnsPayload`] |
//! | `ApnsClientOptions` (`apns.ts:60-69`) | [`ApnsClientConfig`] (renamed; typed not stringly) |
//! | `resolveApnsHost(env)` (`apns.ts:76-80`) | [`resolve_apns_host`] |
//! | `ApnsClient.send(payload)` (`apns.ts:91-155`) | [`ApnsClient::send`] |
//! | `fetchFn` injection (`apns.ts:67-68`) | [`Transport`] trait + [`ReqwestTransport`] |
//!
//! ## Retry policy (REDESIGN-NOW — TS has none)
//!
//! * **Retried**: HTTP 429, HTTP 5xx, and transport/network errors (connection
//!   refused, TLS failure, timeout — these are transient at the connection layer
//!   and a fresh attempt commonly succeeds).
//! * **Not retried**: 4xx responses other than 429 (includes dead-token 400/410),
//!   which are permanent client errors.
//! * **Max retries**: `APNS_MAX_RETRIES` env (default 3).  After exhaustion:
//!   `Err { dead_token: false, reason }`.
//! * **Backoff**: exponential with jitter — `base_ms * 2^attempt + jitter`.
//!   Base = `APNS_RETRY_BASE_MS` env (default 500 ms).
//!   Jitter range = `[0, base_ms)` (uniform, seeded from the attempt count in
//!   tests via a no-op sleeper that captures calls instead of sleeping).
//! * **Retry-After**: when the response carries a `Retry-After` header the value
//!   is parsed as an integer number of seconds (`Retry-After: 60`) and used
//!   **in place of** the exponential backoff for that attempt.
//!   HTTP-date form (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`) is NOT parsed;
//!   the exponential-backoff delay is used as a safe fallback.
//!
//! ## Injection seams
//!
//! * **Transport**: callers supply a `Box<dyn Transport>` (or use
//!   [`ReqwestTransport`] which wraps an `Arc<reqwest::Client>` built with
//!   `http2_prior_knowledge()`).  Tests use [`FakeTransport`] (cfg test),
//!   which captures every [`TransportRequest`] and returns pre-programmed
//!   [`TransportResponse`] values — no network involved.
//! * **Sleeper**: callers supply a `Box<dyn Sleeper>` (default
//!   [`TokioSleeper`]).  Tests use [`NoopSleeper`] which records call counts
//!   and durations without actually sleeping.
//!
//! ## Security
//!
//! No device tokens, JWT secrets, or bearer tokens appear in log output.
//! Log lines use `tracing` targets and include only daemonId/status codes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand_core::{OsRng, RngCore};

use crate::apns_jwt::ApnsSigner;

// ── Dead-token reasons ────────────────────────────────────────────────────────

/// APNs error reason codes that indicate a permanently-dead device token.
///
/// Mirrors `APNS_DEAD_TOKEN_REASONS` (`apns.ts:37-40`).
///
/// - `Unregistered` (410): app uninstalled or push disabled by the user.
/// - `BadDeviceToken` (400): token is malformed or from the wrong environment.
#[must_use]
pub fn apns_dead_token_reasons() -> HashSet<&'static str> {
    ["Unregistered", "BadDeviceToken"].into()
}

// ── Result type ───────────────────────────────────────────────────────────────

/// Outcome of a single APNs delivery attempt (including retries).
///
/// Mirrors `ApnsDeliveryResult` (`apns.ts:42-45`).
#[derive(Debug, Clone, PartialEq)]
pub enum ApnsDeliveryResult {
    /// APNs accepted the push (HTTP 200).
    Ok,
    /// APNs rejected the push.
    Err {
        /// `true` for `BadDeviceToken` / `Unregistered` — the caller should
        /// evict the token from the store.
        dead_token: bool,
        /// APNs reason string or `"HTTP <status>"` fallback.
        reason: String,
    },
}

// ── Payload ───────────────────────────────────────────────────────────────────

/// Optional interruption level — mirrors `PushInterruptionLevel` from the
/// TypeScript protocol package (`@teleprompter/protocol`).
///
/// APNs uses `"interruption-level": "time-sensitive"` to break through Focus/DND.
/// Other values are passed through verbatim.
#[derive(Debug, Clone)]
pub struct ApnsPayload {
    /// Hex-encoded APNs device token.
    /// Mirrors `deviceToken` (`apns.ts:49`).
    pub device_token: String,
    /// Push title.
    /// Mirrors `title` (`apns.ts:51`).
    pub title: String,
    /// Push body.
    /// Mirrors `body` (`apns.ts:53`).
    pub body: String,
    /// Optional iOS interruption level.  `None` → APNs default ("active").
    /// Mirrors `interruptionLevel?: PushInterruptionLevel` (`apns.ts:55`).
    pub interruption_level: Option<String>,
    /// Optional navigation payload forwarded verbatim to the app.
    /// Mirrors `data?: { sid, daemonId, event }` (`apns.ts:57`).
    pub data: Option<HashMap<String, String>>,
}

// ── Transport trait ───────────────────────────────────────────────────────────

/// A single POST request to APNs as seen by the [`Transport`] layer.
///
/// This is the capture type used by [`FakeTransport`] in tests to assert
/// the request shape (URL, headers, body) without touching the network.
#[derive(Debug, Clone)]
pub struct TransportRequest {
    pub url: String,
    pub headers: HashMap<String, String>,
    /// JSON-serialized APNs body.
    pub body: String,
}

/// Response returned by the [`Transport`] layer.
#[derive(Debug, Clone)]
pub struct TransportResponse {
    /// HTTP status code.
    pub status: u16,
    /// Optional `Retry-After` header value (seconds as a string).
    pub retry_after: Option<String>,
    /// Response body bytes (may be empty on success).
    pub body: Vec<u8>,
}

/// Async function pointer type for transport.
/// Returns `Pin<Box<Future<Output=Result<TransportResponse, String>> + Send>>`.
type PostFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<TransportResponse, String>> + Send>>;

/// Object-safe async transport (hand-rolled to avoid the `async_trait` dep).
///
/// Callers implement `post_dyn` which returns a pinned boxed future.  This is
/// the same pattern the [`SleeperDyn`] uses below.
pub trait TransportDyn: Send + Sync {
    fn post_dyn(&self, req: TransportRequest) -> PostFuture;
}

/// Real HTTP/2 transport backed by a shared `reqwest::Client`.
///
/// The client is built with `http2_prior_knowledge()` so every POST goes over
/// HTTP/2 without an HTTP/1.1 Upgrade round-trip.
///
/// Mirrors the implicit `fetchFn = fetch` default in `apns.ts:88`.
pub struct ReqwestTransport {
    client: Arc<reqwest::Client>,
}

impl ReqwestTransport {
    /// Build with a fresh `reqwest::Client` (HTTP/2 prior knowledge + rustls).
    ///
    /// Mirrors the TS `fetch` default — one shared client for connection pooling.
    ///
    /// # Panics
    ///
    /// Panics if `reqwest::Client::builder().http2_prior_knowledge().build()` fails.
    /// This should never happen with the chosen feature set.
    #[must_use]
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .http2_prior_knowledge()
            .build()
            .expect("reqwest client with http2_prior_knowledge must build");
        Self {
            client: Arc::new(client),
        }
    }

    /// Build from an existing `Arc<reqwest::Client>` (for sharing across callers).
    #[must_use]
    pub fn from_client(client: Arc<reqwest::Client>) -> Self {
        Self { client }
    }
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportDyn for ReqwestTransport {
    fn post_dyn(&self, req: TransportRequest) -> PostFuture {
        let client = Arc::clone(&self.client);
        Box::pin(async move {
            let mut builder = client.post(&req.url);
            for (k, v) in &req.headers {
                builder = builder.header(k.as_str(), v.as_str());
            }
            builder = builder.body(req.body);
            let response = builder.send().await.map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(ToString::to_string);
            let body = response.bytes().await.map_err(|e| e.to_string())?.to_vec();
            Ok(TransportResponse {
                status,
                retry_after,
                body,
            })
        })
    }
}

// ── Sleeper trait ─────────────────────────────────────────────────────────────

/// Abstraction over async sleep — injected so tests can run without real delays.
pub trait SleeperDyn: Send + Sync {
    fn sleep_dyn(&self, duration: Duration) -> PostFuture;
}

/// Real tokio-backed sleeper.
pub struct TokioSleeper;

impl SleeperDyn for TokioSleeper {
    fn sleep_dyn(&self, duration: Duration) -> PostFuture {
        Box::pin(async move {
            tokio::time::sleep(duration).await;
            Ok(TransportResponse {
                status: 0,
                retry_after: None,
                body: vec![],
            })
        })
    }
}

// ── Retry config ──────────────────────────────────────────────────────────────

/// Maximum number of retries after the first attempt.
///
/// Configurable via `APNS_MAX_RETRIES` env (default 3).
const DEFAULT_MAX_RETRIES: u32 = 3;

/// Base backoff in milliseconds.
///
/// Configurable via `APNS_RETRY_BASE_MS` env (default 500 ms).
const DEFAULT_RETRY_BASE_MS: u64 = 500;

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

// ── ApnsClientConfig ──────────────────────────────────────────────────────────

/// Configuration for [`ApnsClient`].
///
/// Mirrors `ApnsClientOptions` (`apns.ts:60-69`) but typed: `fetchFn` becomes
/// a [`TransportDyn`] trait object.
pub struct ApnsClientConfig {
    /// APNs hostname (e.g. `api.sandbox.push.apple.com`).
    /// Mirrors `host` (`apns.ts:62`).
    pub host: String,
    /// APNs bundle ID — used as the `apns-topic` header.
    /// Mirrors `bundleId` (`apns.ts:64`).
    pub bundle_id: String,
    /// Maximum number of retries after the initial attempt (0 = no retry).
    /// Default: `APNS_MAX_RETRIES` env or [`DEFAULT_MAX_RETRIES`].
    pub max_retries: u32,
    /// Base backoff in milliseconds (doubles each retry, plus jitter).
    /// Default: `APNS_RETRY_BASE_MS` env or [`DEFAULT_RETRY_BASE_MS`].
    pub retry_base_ms: u64,
}

impl ApnsClientConfig {
    /// Build from env with given `host` and `bundle_id`.
    #[must_use]
    pub fn from_env(host: String, bundle_id: String) -> Self {
        Self {
            host,
            bundle_id,
            max_retries: env_u32("APNS_MAX_RETRIES", DEFAULT_MAX_RETRIES),
            retry_base_ms: env_u64("APNS_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS),
        }
    }
}

// ── Host resolver ─────────────────────────────────────────────────────────────

/// Resolve the APNs hostname from the `APNS_ENV` environment variable.
///
/// - `"sandbox"` → `api.sandbox.push.apple.com`
/// - anything else / `"prod"` → `api.push.apple.com`
///
/// Mirrors `resolveApnsHost(env)` (`apns.ts:76-80`).
#[must_use]
pub fn resolve_apns_host(env: Option<&str>) -> &'static str {
    if env.is_some_and(|e| e.eq_ignore_ascii_case("sandbox")) {
        "api.sandbox.push.apple.com"
    } else {
        "api.push.apple.com"
    }
}

// ── ApnsClient ────────────────────────────────────────────────────────────────

/// APNs HTTP/2 delivery client with retry.
///
/// Mirrors `ApnsClient` (`apns.ts:82-155`).
///
/// ## Construction
///
/// ```rust,ignore
/// let transport = Box::new(ReqwestTransport::new());
/// let sleeper   = Box::new(TokioSleeper);
/// let client = ApnsClient::new(
///     ApnsClientConfig::from_env("api.push.apple.com".into(), "dev.tpmt.app".into()),
///     signer,          // ApnsSigner
///     transport,
///     sleeper,
/// );
/// ```
pub struct ApnsClient {
    config: ApnsClientConfig,
    signer: Mutex<ApnsSigner>,
    transport: Box<dyn TransportDyn>,
    sleeper: Box<dyn SleeperDyn>,
    /// Dead-token reason set — pre-built at construction time.
    dead_reasons: HashSet<&'static str>,
}

impl ApnsClient {
    /// Create a new client.
    ///
    /// Mirrors `new ApnsClient(opts)` (`apns.ts:86-89`).
    #[must_use]
    pub fn new(
        config: ApnsClientConfig,
        signer: ApnsSigner,
        transport: Box<dyn TransportDyn>,
        sleeper: Box<dyn SleeperDyn>,
    ) -> Self {
        Self {
            config,
            signer: Mutex::new(signer),
            transport,
            sleeper,
            dead_reasons: apns_dead_token_reasons(),
        }
    }

    /// Send a push notification to APNs, with retry on 429 / 5xx.
    ///
    /// Mirrors `ApnsClient.send(payload)` (`apns.ts:91-155`).
    ///
    /// Returns [`ApnsDeliveryResult::Ok`] on HTTP 200.
    /// Returns [`ApnsDeliveryResult::Err`] on unrecoverable failure or retry
    /// exhaustion.
    ///
    /// # Errors
    ///
    /// Returns the last error after all retry attempts are exhausted.
    pub async fn send(&self, payload: &ApnsPayload) -> ApnsDeliveryResult {
        let max_attempts = self.config.max_retries.saturating_add(1); // first attempt + N retries

        let mut last_err: ApnsDeliveryResult = ApnsDeliveryResult::Err {
            dead_token: false,
            reason: "no attempts made".into(),
        };

        for attempt in 0..max_attempts {
            let result = self.send_once(payload).await;

            match &result {
                ApnsDeliveryResult::Ok => return ApnsDeliveryResult::Ok,

                ApnsDeliveryResult::Err { dead_token, reason } => {
                    // Dead tokens and non-retryable 4xx errors — do NOT retry.
                    if *dead_token || is_non_retryable_reason(reason) {
                        return result;
                    }

                    last_err = result.clone();

                    // If this was the last attempt, stop.
                    if attempt + 1 >= max_attempts {
                        break;
                    }

                    // Compute backoff delay.
                    let delay = self.backoff_delay(attempt, reason);
                    // Sleep (no-op in tests).
                    let _ = self.sleeper.sleep_dyn(delay).await;
                }
            }
        }

        last_err
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Single delivery attempt — no retry logic here.
    ///
    /// Closely mirrors the `ApnsClient.send` body from `apns.ts:91-155`.
    async fn send_once(&self, payload: &ApnsPayload) -> ApnsDeliveryResult {
        // ── JWT ───────────────────────────────────────────────────────────────
        let now_ms = epoch_ms_now();
        let jwt = {
            let mut signer = self.signer.lock().expect("ApnsSigner mutex poisoned");
            match signer.get_token(now_ms) {
                Ok(t) => t.to_owned(),
                Err(e) => {
                    return ApnsDeliveryResult::Err {
                        dead_token: false,
                        reason: format!("jwt-error: {e}"),
                    };
                }
            }
        };

        // ── Build APNs JSON body ──────────────────────────────────────────────
        // Mirrors apns.ts:96-107.
        let is_time_sensitive = payload
            .interruption_level
            .as_deref()
            .is_some_and(|l| l.eq_ignore_ascii_case("time-sensitive"));

        let mut aps = serde_json::json!({
            "alert": { "title": payload.title, "body": payload.body },
            "sound": "default",
        });
        if let Some(level) = &payload.interruption_level {
            aps["interruption-level"] = serde_json::Value::String(level.clone());
        }

        let mut body_obj = if let Some(data) = &payload.data {
            let mut m = serde_json::Map::new();
            for (k, v) in data {
                m.insert(k.clone(), serde_json::Value::String(v.clone()));
            }
            serde_json::Value::Object(m)
        } else {
            serde_json::Value::Object(serde_json::Map::new())
        };
        body_obj["aps"] = aps;

        let body_str = serde_json::to_string(&body_obj)
            .unwrap_or_else(|e| format!(r#"{{"aps":{{"alert":"serialization error: {e}"}}}}"#));

        // ── Validate device token (path injection guard) ──────────────────────
        // APNs device tokens must be exactly 64 lowercase hex characters.
        // Reject anything else to prevent URL path injection.
        if !is_valid_device_token(&payload.device_token) {
            return ApnsDeliveryResult::Err {
                dead_token: false,
                reason: format!(
                    "invalid-device-token: expected 64 lowercase hex chars, got {:?}",
                    payload.device_token
                ),
            };
        }

        // ── Build request ─────────────────────────────────────────────────────
        // Mirrors apns.ts:109-126.
        let url = format!(
            "https://{}/3/device/{}",
            self.config.host, payload.device_token
        );

        let mut headers = HashMap::new();
        headers.insert("authorization".into(), format!("bearer {jwt}"));
        headers.insert("apns-topic".into(), self.config.bundle_id.clone());
        headers.insert("apns-push-type".into(), "alert".into());
        headers.insert("content-type".into(), "application/json".into());

        // apns-priority: only for time-sensitive (mirrors apns.ts:123-125).
        if is_time_sensitive {
            headers.insert("apns-priority".into(), "10".into());
        }

        // ── Send ──────────────────────────────────────────────────────────────
        let req = TransportRequest {
            url,
            headers,
            body: body_str,
        };

        let resp = match self.transport.post_dyn(req).await {
            Ok(r) => r,
            Err(e) => {
                // Network error — mirrors `catch (err)` (`apns.ts:134-136`).
                return ApnsDeliveryResult::Err {
                    dead_token: false,
                    reason: e,
                };
            }
        };

        // ── Interpret response ────────────────────────────────────────────────
        // Mirrors apns.ts:138-154.
        if resp.status == 200 {
            return ApnsDeliveryResult::Ok;
        }

        // Non-200: parse APNs error body for the reason code.
        //
        // We keep the HTTP status in the reason string so that
        // `is_non_retryable_reason` and `backoff_delay` can inspect it without
        // needing a separate field.  The parsed JSON reason (if any) is appended
        // as a suffix after ": " so callers can still read the APNs reason code.
        //
        // Special case — dead-token detection: we check the *raw* JSON reason
        // string against `dead_reasons` (e.g. "BadDeviceToken", "Unregistered")
        // before composing the full reason string, so dead_token is set correctly.
        let http_status = resp.status;
        let json_reason: Option<String> = serde_json::from_slice::<serde_json::Value>(&resp.body)
            .ok()
            .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_owned));

        // Dead-token check uses the raw APNs reason code (e.g. "BadDeviceToken").
        let dead_token = json_reason
            .as_deref()
            .is_some_and(|r| self.dead_reasons.contains(r));

        // For dead-token responses, expose the raw reason code so the caller can
        // log/match it directly (matches TS parity: `reason = json.reason`).
        let reason = if dead_token {
            json_reason.unwrap_or_else(|| format!("HTTP {http_status}"))
        } else if http_status == 429 {
            // Retry-After: encode the header value into the reason string so
            // `backoff_delay` can read it without storing extra state.
            // Convention: "HTTP 429 retry-after:<secs>" triggers Retry-After
            // backoff; plain "HTTP 429" falls through to exponential backoff.
            if let Some(secs) = resp
                .retry_after
                .as_deref()
                .and_then(|s| s.parse::<u64>().ok())
            {
                format!("HTTP 429 retry-after:{secs}")
            } else {
                // No parseable Retry-After — plain 429 for exponential backoff.
                if let Some(jr) = json_reason {
                    format!("HTTP {http_status}: {jr}")
                } else {
                    format!("HTTP {http_status}")
                }
            }
        } else {
            // For all other non-200 responses keep "HTTP <status>" as the
            // primary prefix (so `is_non_retryable_reason` can parse the status
            // code), appending the APNs JSON reason as an informational suffix.
            if let Some(jr) = json_reason {
                format!("HTTP {http_status}: {jr}")
            } else {
                format!("HTTP {http_status}")
            }
        };

        ApnsDeliveryResult::Err { dead_token, reason }
    }

    /// Compute backoff delay for a given attempt (0-indexed).
    ///
    /// Uses:
    /// 1. `Retry-After` header seconds value if the reason encodes one (via a
    ///    special `"HTTP 429 retry-after:<secs>"` convention set by `send_once`
    ///    — see below).
    /// 2. Otherwise: `base_ms * 2^attempt + jitter` where jitter ∈ `[0, base_ms)`.
    fn backoff_delay(&self, attempt: u32, reason: &str) -> Duration {
        // Check for Retry-After seconds encoded in the reason string.
        // Convention: if `send_once` returns `"HTTP 429 retry-after:<secs>"`,
        // we parse the seconds and use them directly.
        if let Some(secs) = parse_retry_after_reason(reason) {
            return Duration::from_secs(secs);
        }

        // Exponential backoff: base_ms * 2^attempt.
        // 2^attempt shift, clamped to avoid overflow on large attempt counts.
        let multiplier: u64 = 1_u64.checked_shl(attempt).unwrap_or(u64::MAX);
        let exp: u64 = self.config.retry_base_ms.saturating_mul(multiplier);

        // Jitter: [0, base_ms) from OsRng (deterministic-in-test via NoopSleeper
        // which never calls this code path; in tests we inject a FakeTransport that
        // returns deterministic responses so jitter is irrelevant).
        let jitter = {
            let base = self.config.retry_base_ms.max(1);
            let mut buf = [0u8; 8];
            OsRng.fill_bytes(&mut buf);
            u64::from_le_bytes(buf) % base
        };

        Duration::from_millis(exp.saturating_add(jitter))
    }
}

/// Parse `Retry-After: <seconds>` from the special encoded reason string.
///
/// Convention: `send_once` encodes a Retry-After header as
/// `"HTTP 429 retry-after:<secs>"` in the reason so `backoff_delay` can read
/// it without storing extra state.
fn parse_retry_after_reason(reason: &str) -> Option<u64> {
    reason
        .strip_prefix("HTTP 429 retry-after:")
        .and_then(|s| s.parse::<u64>().ok())
}

/// Determine whether a reason string indicates a non-retryable error.
///
/// 4xx errors other than 429 must NOT be retried (permanent client errors).
/// 429, 5xx, and transport/network errors ARE retryable.
///
/// The reason string may carry an informational APNs-reason suffix, e.g.
/// `"HTTP 400: PayloadTooLarge"` — we parse only the status code portion.
fn is_non_retryable_reason(reason: &str) -> bool {
    // Transport/network errors carry no "HTTP " prefix (they are `String(err)`
    // from the transport). These are transient — return false so the retry loop
    // re-attempts. (Dead-token responses are handled separately: they always
    // carry dead_token=true and the loop returns early on that flag, never
    // reaching this status parse.)
    let Some(rest) = reason.strip_prefix("HTTP ") else {
        return false; // network error → RETRYABLE
    };
    // Parse the status code — stop at the first non-digit character so that
    // both "HTTP 400" and "HTTP 400: PayloadTooLarge" parse to 400.
    let status: u16 = rest
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .unwrap_or(0);

    // 429 → retryable.  5xx → retryable.  Other 4xx → not retryable.
    if status == 429 || (500..600).contains(&status) {
        return false;
    }
    // 4xx (other than 429) → non-retryable.
    (400..500).contains(&status)
}

/// Validate an APNs device token: must be exactly 64 lowercase ASCII hex digits.
/// Any other value (path components, slashes, wrong length) is rejected to
/// prevent URL path injection into the APNs endpoint.
fn is_valid_device_token(token: &str) -> bool {
    token.len() == 64 && token.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// Current epoch-milliseconds from the system clock.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
fn epoch_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    // ── FakeTransport ─────────────────────────────────────────────────────────

    /// A fake transport that returns a pre-programmed sequence of responses
    /// and captures every request for assertion.
    ///
    /// Mirrors the `fetchFn` stub approach from `apns.ts:67-68`.
    pub struct FakeTransport {
        /// Responses returned in order; last element is repeated once exhausted.
        responses: Mutex<Vec<TransportResponse>>,
        /// All captured requests (for shape assertions).
        pub captured: Mutex<Vec<TransportRequest>>,
    }

    impl FakeTransport {
        #[must_use]
        pub fn new(responses: Vec<TransportResponse>) -> Self {
            Self {
                responses: Mutex::new(responses),
                captured: Mutex::new(vec![]),
            }
        }
    }

    impl TransportDyn for FakeTransport {
        fn post_dyn(&self, req: TransportRequest) -> PostFuture {
            let resp = {
                let mut queue = self.responses.lock().unwrap();
                if queue.len() > 1 {
                    queue.remove(0)
                } else {
                    // Use first().cloned() to avoid an index-out-of-bounds panic
                    // on an empty queue (#22 fix). The expect surfaces the
                    // misconfigured test clearly rather than crashing silently.
                    queue
                        .first()
                        .cloned()
                        .expect("FakeTransport response queue is empty")
                }
            };
            self.captured.lock().unwrap().push(req);
            Box::pin(async move { Ok(resp) })
        }
    }

    // ── NoopSleeper ───────────────────────────────────────────────────────────

    /// A sleeper that records calls but never actually sleeps.
    pub struct NoopSleeper {
        pub call_count: AtomicU32,
        pub total_ms: Mutex<u64>,
    }

    impl NoopSleeper {
        #[must_use]
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                call_count: AtomicU32::new(0),
                total_ms: Mutex::new(0),
            })
        }
    }

    impl SleeperDyn for Arc<NoopSleeper> {
        fn sleep_dyn(&self, duration: Duration) -> PostFuture {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            // as_millis() returns u128; truncation to u64 is safe for any realistic duration.
            #[allow(clippy::cast_possible_truncation)]
            {
                *self.total_ms.lock().unwrap() += duration.as_millis() as u64;
            }
            Box::pin(async {
                Ok(TransportResponse {
                    status: 0,
                    retry_after: None,
                    body: vec![],
                })
            })
        }
    }

    // ── CapturingTransport — shared by tests that assert request shape ─────────

    /// A transport that captures every request and always returns HTTP 200.
    ///
    /// Defined at module level to avoid the `items_after_statements` pedantic
    /// lint that fires when a struct is defined inside a function body.
    pub struct CapturingTransport {
        pub captured: Arc<Mutex<Vec<TransportRequest>>>,
    }

    impl TransportDyn for CapturingTransport {
        fn post_dyn(&self, req: TransportRequest) -> PostFuture {
            self.captured.lock().unwrap().push(req);
            Box::pin(async {
                Ok(TransportResponse {
                    status: 200,
                    retry_after: None,
                    body: vec![],
                })
            })
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePrivateKey;

    fn throwaway_pem() -> String {
        let sk = SigningKey::random(&mut rand_core::OsRng);
        sk.to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .expect("p256 to_pkcs8_pem must succeed")
            .to_string()
    }

    fn make_signer() -> ApnsSigner {
        let pem = throwaway_pem();
        ApnsSigner::new(
            crate::apns_jwt::ApnsKey::Pem(pem),
            "KID123".into(),
            "TEAM456".into(),
        )
    }

    fn make_payload() -> ApnsPayload {
        ApnsPayload {
            // 64 lowercase hex chars (valid APNs device token format — #8 fix
            // requires exactly this format; the old 12-char token was invalid).
            device_token: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2".into(),
            title: "Hello".into(),
            body: "World".into(),
            interruption_level: None,
            data: None,
        }
    }

    fn ok_resp() -> TransportResponse {
        TransportResponse {
            status: 200,
            retry_after: None,
            body: vec![],
        }
    }

    fn err_resp(status: u16, reason: &str) -> TransportResponse {
        TransportResponse {
            status,
            retry_after: None,
            body: serde_json::to_vec(&serde_json::json!({ "reason": reason })).unwrap(),
        }
    }

    fn make_client(
        transport: Box<dyn TransportDyn>,
        sleeper: Box<dyn SleeperDyn>,
        max_retries: u32,
    ) -> ApnsClient {
        ApnsClient::new(
            ApnsClientConfig {
                host: "api.push.apple.com".into(),
                bundle_id: "dev.tpmt.app".into(),
                max_retries,
                retry_base_ms: 10, // tiny for tests
            },
            make_signer(),
            transport,
            sleeper,
        )
    }

    // ── Test: success → Ok ────────────────────────────────────────────────────

    #[tokio::test]
    async fn success_returns_ok() {
        let transport = Box::new(FakeTransport::new(vec![ok_resp()]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        assert_eq!(result, ApnsDeliveryResult::Ok);
        assert_eq!(sleeper.call_count.load(Ordering::SeqCst), 0);
    }

    // ── Test: 410 Unregistered → dead_token true, no retry ───────────────────

    #[tokio::test]
    async fn unregistered_dead_token_no_retry() {
        let transport = Box::new(FakeTransport::new(vec![err_resp(410, "Unregistered")]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        assert!(
            matches!(result, ApnsDeliveryResult::Err { dead_token: true, ref reason } if reason == "Unregistered"),
            "expected dead_token=true Unregistered, got: {result:?}"
        );
        // No sleep — no retry.
        assert_eq!(sleeper.call_count.load(Ordering::SeqCst), 0);
    }

    // ── Test: 400 BadDeviceToken → dead_token true, no retry ─────────────────

    #[tokio::test]
    async fn bad_device_token_dead_token_no_retry() {
        let transport = Box::new(FakeTransport::new(vec![err_resp(400, "BadDeviceToken")]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        assert!(
            matches!(result, ApnsDeliveryResult::Err { dead_token: true, ref reason } if reason == "BadDeviceToken"),
            "expected dead_token=true BadDeviceToken, got: {result:?}"
        );
        assert_eq!(sleeper.call_count.load(Ordering::SeqCst), 0);
    }

    // ── Test: 429 then 200 → retried → Ok, backoff invoked once ──────────────

    #[tokio::test]
    async fn retry_on_429_then_success() {
        let transport = Box::new(FakeTransport::new(vec![
            TransportResponse {
                status: 429,
                retry_after: None,
                body: serde_json::to_vec(&serde_json::json!({"reason":"TooManyRequests"})).unwrap(),
            },
            ok_resp(),
        ]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        assert_eq!(result, ApnsDeliveryResult::Ok);
        // Sleep was called once (before the retry).
        assert_eq!(sleeper.call_count.load(Ordering::SeqCst), 1);
    }

    // ── Test: persistent 503 → exhausts retries → Err ────────────────────────

    #[tokio::test]
    async fn persistent_503_exhausts_retries() {
        let transport = Box::new(FakeTransport::new(vec![TransportResponse {
            status: 503,
            retry_after: None,
            body: serde_json::to_vec(&serde_json::json!({"reason":"ServiceUnavailable"})).unwrap(),
        }]));
        let sleeper = NoopSleeper::new();
        let max_retries = 3u32;
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), max_retries);

        let result = client.send(&make_payload()).await;
        assert!(
            matches!(
                result,
                ApnsDeliveryResult::Err {
                    dead_token: false,
                    ..
                }
            ),
            "expected Err with dead_token=false, got: {result:?}"
        );
        // Sleep called max_retries times (once before each retry).
        assert_eq!(sleeper.call_count.load(Ordering::SeqCst), max_retries);
    }

    // ── Test: time-sensitive sets apns-priority 10 ───────────────────────────

    #[tokio::test]
    async fn time_sensitive_sets_priority_10() {
        let captured = Arc::new(Mutex::new(vec![]));
        let client = ApnsClient::new(
            ApnsClientConfig {
                host: "api.push.apple.com".into(),
                bundle_id: "dev.tpmt.app".into(),
                max_retries: 0,
                retry_base_ms: 10,
            },
            make_signer(),
            Box::new(CapturingTransport {
                captured: Arc::clone(&captured),
            }),
            Box::new(NoopSleeper::new()),
        );
        let payload = ApnsPayload {
            // 64 lowercase hex chars (valid APNs device token — #8 fix requires this).
            device_token: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2".into(),
            title: "t".into(),
            body: "b".into(),
            interruption_level: Some("time-sensitive".into()),
            data: None,
        };
        let r = client.send(&payload).await;
        assert_eq!(r, ApnsDeliveryResult::Ok);
        let reqs = captured.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(
            reqs[0].headers.get("apns-priority").map(String::as_str),
            Some("10"),
            "time-sensitive must set apns-priority: 10"
        );
    }

    // ── Test: non-time-sensitive omits apns-priority ─────────────────────────

    #[tokio::test]
    async fn non_time_sensitive_omits_priority() {
        let captured = Arc::new(Mutex::new(vec![]));
        let client = ApnsClient::new(
            ApnsClientConfig {
                host: "api.push.apple.com".into(),
                bundle_id: "dev.tpmt.app".into(),
                max_retries: 0,
                retry_base_ms: 10,
            },
            make_signer(),
            Box::new(CapturingTransport {
                captured: Arc::clone(&captured),
            }),
            Box::new(NoopSleeper::new()),
        );
        let result = client.send(&make_payload()).await;
        assert_eq!(result, ApnsDeliveryResult::Ok);
        let reqs = captured.lock().unwrap();
        assert!(
            !reqs[0].headers.contains_key("apns-priority"),
            "non-time-sensitive must NOT set apns-priority"
        );
    }

    // ── Test: request URL / headers / body shape ──────────────────────────────

    #[tokio::test]
    async fn request_shape() {
        let captured = Arc::new(Mutex::new(vec![]));
        let client = ApnsClient::new(
            ApnsClientConfig {
                host: "api.sandbox.push.apple.com".into(),
                bundle_id: "dev.tpmt.app".into(),
                max_retries: 0,
                retry_base_ms: 10,
            },
            make_signer(),
            Box::new(CapturingTransport {
                captured: Arc::clone(&captured),
            }),
            Box::new(NoopSleeper::new()),
        );
        // 64 lowercase hex chars (valid APNs device token — #8 fix requires this).
        let token = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let payload = ApnsPayload {
            device_token: token.into(),
            title: "Test Title".into(),
            body: "Test Body".into(),
            interruption_level: None,
            data: Some({
                let mut m = HashMap::new();
                m.insert("sid".into(), "sess-abc".into());
                m.insert("daemonId".into(), "daemon-xyz".into());
                m.insert("event".into(), "tool_result".into());
                m
            }),
        };
        let result = client.send(&payload).await;
        assert_eq!(result, ApnsDeliveryResult::Ok);

        let reqs = captured.lock().unwrap();
        let req = &reqs[0];

        // URL shape.
        assert_eq!(
            req.url,
            format!("https://api.sandbox.push.apple.com/3/device/{token}"),
            "URL must be POST /3/device/<token>"
        );

        // Required headers.
        assert!(
            req.headers
                .get("authorization")
                .is_some_and(|v| v.starts_with("bearer ")),
            "authorization must be 'bearer <jwt>'"
        );
        assert_eq!(
            req.headers.get("apns-topic").map(String::as_str),
            Some("dev.tpmt.app")
        );
        assert_eq!(
            req.headers.get("apns-push-type").map(String::as_str),
            Some("alert")
        );
        assert_eq!(
            req.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );

        // Body must be valid JSON with aps.alert.title/body + aps.sound.
        let body: serde_json::Value = serde_json::from_str(&req.body).expect("body must be JSON");
        assert_eq!(body["aps"]["alert"]["title"], "Test Title");
        assert_eq!(body["aps"]["alert"]["body"], "Test Body");
        assert_eq!(body["aps"]["sound"], "default");
        // Data fields forwarded at top level alongside aps.
        assert_eq!(body["sid"], "sess-abc");
    }

    // ── Test: resolve_apns_host ───────────────────────────────────────────────

    #[test]
    fn resolve_host_sandbox() {
        assert_eq!(
            resolve_apns_host(Some("sandbox")),
            "api.sandbox.push.apple.com"
        );
        assert_eq!(
            resolve_apns_host(Some("SANDBOX")),
            "api.sandbox.push.apple.com"
        );
    }

    #[test]
    fn resolve_host_prod() {
        assert_eq!(resolve_apns_host(Some("prod")), "api.push.apple.com");
        assert_eq!(resolve_apns_host(None), "api.push.apple.com");
        assert_eq!(resolve_apns_host(Some("")), "api.push.apple.com");
    }

    // ── Test: dead_token reasons set ─────────────────────────────────────────

    #[test]
    fn dead_token_reasons_contents() {
        let reasons = apns_dead_token_reasons();
        assert!(reasons.contains("Unregistered"));
        assert!(reasons.contains("BadDeviceToken"));
        assert!(!reasons.contains("TooManyRequests"));
        assert!(!reasons.contains("ServiceUnavailable"));
    }

    // ── Test: is_non_retryable_reason ────────────────────────────────────────

    #[test]
    fn non_retryable_reason_semantics() {
        // 4xx other than 429 → non-retryable (bare status).
        assert!(is_non_retryable_reason("HTTP 400"));
        assert!(is_non_retryable_reason("HTTP 410"));
        assert!(is_non_retryable_reason("HTTP 403"));
        // 4xx other than 429 → non-retryable WITH suffix (Bug 2 regression guard).
        // send_once now produces "HTTP 400: PayloadTooLarge" for non-dead 4xx.
        assert!(is_non_retryable_reason("HTTP 400: PayloadTooLarge"));
        assert!(is_non_retryable_reason("HTTP 403: Forbidden"));
        // 429 → retryable (with or without retry-after suffix).
        assert!(!is_non_retryable_reason("HTTP 429"));
        assert!(!is_non_retryable_reason("HTTP 429 retry-after:60"));
        // 5xx → retryable.
        assert!(!is_non_retryable_reason("HTTP 500"));
        assert!(!is_non_retryable_reason("HTTP 503"));
        // Transport/network errors (no "HTTP " prefix) → false = RETRYABLE.
        // A genuine connection failure is transient; the retry loop re-attempts.
        assert!(!is_non_retryable_reason("connection refused"));
        assert!(!is_non_retryable_reason("error sending request: timed out"));
        // Bare APNs reason codes also have no "HTTP " prefix → false here, but in
        // practice a dead-token reason carries dead_token=true and the retry loop
        // returns early on that flag before this status parse is reached.
        assert!(!is_non_retryable_reason("Unregistered"));
        assert!(!is_non_retryable_reason("BadDeviceToken"));
    }

    // ── Test: Retry-After reason encoding ────────────────────────────────────

    #[test]
    fn parse_retry_after_reason_semantics() {
        assert_eq!(
            parse_retry_after_reason("HTTP 429 retry-after:60"),
            Some(60)
        );
        assert_eq!(parse_retry_after_reason("HTTP 429"), None);
        assert_eq!(parse_retry_after_reason("HTTP 503"), None);
    }

    // ── Test: Retry-After header propagates to sleeper (Bug 1 regression guard) ─

    /// When APNs returns HTTP 429 with a `Retry-After: 60` header and then 200,
    /// the NoopSleeper must be called with exactly Duration::from_secs(60).
    ///
    /// Before the fix, `send_once` never encoded `retry_after` into the reason
    /// string, so `backoff_delay` always fell through to exponential backoff.
    #[tokio::test]
    async fn retry_after_header_propagates_to_sleeper() {
        let transport = Box::new(FakeTransport::new(vec![
            TransportResponse {
                status: 429,
                retry_after: Some("60".to_string()),
                body: serde_json::to_vec(&serde_json::json!({"reason":"TooManyRequests"})).unwrap(),
            },
            ok_resp(),
        ]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        assert_eq!(result, ApnsDeliveryResult::Ok, "should succeed on retry");
        // Sleep was called once with the Retry-After value (60 s = 60_000 ms).
        assert_eq!(
            sleeper.call_count.load(Ordering::SeqCst),
            1,
            "sleeper must be called once"
        );
        assert_eq!(
            *sleeper.total_ms.lock().unwrap(),
            60_000,
            "sleeper duration must equal Retry-After: 60 (= 60_000 ms)"
        );
    }

    // ── Test: non-dead 4xx with JSON reason is NOT retried (Bug 2 regression guard) ─

    /// When APNs returns HTTP 400 with JSON body {"reason":"PayloadTooLarge"}
    /// (a non-dead-token 4xx), the send loop must NOT retry — it must return
    /// immediately with dead_token=false.
    ///
    /// Before the fix, send_once overwrote reason from "HTTP 400" to
    /// "PayloadTooLarge", causing is_non_retryable_reason to return false
    /// (no "HTTP " prefix), which allowed the retry loop to run up to
    /// max_retries times before giving up.
    #[tokio::test]
    async fn non_dead_4xx_with_json_reason_not_retried() {
        let transport = Box::new(FakeTransport::new(vec![TransportResponse {
            status: 400,
            retry_after: None,
            body: serde_json::to_vec(&serde_json::json!({"reason":"PayloadTooLarge"})).unwrap(),
        }]));
        let sleeper = NoopSleeper::new();
        let client = make_client(transport, Box::new(Arc::clone(&sleeper)), 3);

        let result = client.send(&make_payload()).await;
        // Must return error immediately — no retry.
        assert!(
            matches!(result, ApnsDeliveryResult::Err { dead_token: false, ref reason }
                if reason.starts_with("HTTP 400")),
            "expected non-dead Err with HTTP 400 prefix, got: {result:?}"
        );
        // No sleep — no retry should have occurred.
        assert_eq!(
            sleeper.call_count.load(Ordering::SeqCst),
            0,
            "sleeper must not be called for non-retryable 4xx"
        );
    }

    // ── #8: device-token path injection guard ─────────────────────────────────

    #[test]
    fn is_valid_device_token_rejects_bad_tokens() {
        use super::is_valid_device_token;
        // Valid: exactly 64 lowercase hex chars.
        assert!(is_valid_device_token(
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
        ));
        // Too short.
        assert!(!is_valid_device_token("a1b2c3"));
        // Too long.
        assert!(!is_valid_device_token(
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2xx"
        ));
        // Uppercase hex — rejected (APNs tokens are lowercase).
        assert!(!is_valid_device_token(
            "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2"
        ));
        // Path traversal attempt.
        assert!(!is_valid_device_token(
            "../../etc/passwd/00000000000000000000000000000000000000000000000000"
        ));
        // Slash injection.
        assert!(!is_valid_device_token(
            "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1/x"
        ));
        // Empty string.
        assert!(!is_valid_device_token(""));
    }

    #[tokio::test]
    async fn send_rejects_invalid_device_token() {
        let fake = Arc::new(FakeTransport::new(vec![TransportResponse {
            status: 200,
            retry_after: None,
            body: vec![],
        }]));
        // Wrap in a newtype that implements TransportDyn by forwarding to the Arc.
        struct SharedFake(Arc<FakeTransport>);
        impl TransportDyn for SharedFake {
            fn post_dyn(&self, req: TransportRequest) -> PostFuture {
                self.0.post_dyn(req)
            }
        }
        let captured = Arc::clone(&fake);
        let sleeper = NoopSleeper::new();
        let client = make_client(
            Box::new(SharedFake(fake)),
            Box::new(Arc::clone(&sleeper)),
            0,
        );

        let bad_payload = ApnsPayload {
            device_token: "../../bad".to_string(),
            title: "T".to_string(),
            body: "B".to_string(),
            interruption_level: None,
            data: None,
        };
        let result = client.send(&bad_payload).await;
        assert!(
            matches!(result, ApnsDeliveryResult::Err { dead_token: false, ref reason }
                if reason.starts_with("invalid-device-token")),
            "expected invalid-device-token error, got: {result:?}"
        );
        // No transport call should have been made.
        assert!(
            captured.captured.lock().unwrap().is_empty(),
            "transport must not be called for invalid device token"
        );
    }
}
