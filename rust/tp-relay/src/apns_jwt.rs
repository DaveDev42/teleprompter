//! APNs token-based authentication — ES256 JWT signer.
//!
//! Parity port of `packages/relay/src/apns-jwt.ts`.
//!
//! Apple requires a fresh ES256 JWT signed with the `.p8` private key for each
//! APNs HTTP/2 request. Tokens are valid for up to 60 minutes; we cache the
//! signed token for ~50 minutes and re-sign when it approaches expiry. This
//! avoids the overhead of signing on every push while staying well within the
//! 60-minute Apple limit.
//!
//! References:
//! - <https://developer.apple.com/documentation/usernotifications/establishing_a_token-based_connection_to_apns>
//! - <https://datatracker.ietf.org/doc/html/rfc7519> (JWT)
//! - <https://datatracker.ietf.org/doc/html/rfc7518#section-3.4> (ES256)
//!
//! ## DER → P1363 note
//!
//! The TypeScript source (`apns-jwt.ts:137-179`) hand-rolls a `derToP1363`
//! conversion because Node.js `createSign("SHA256")` emits DER-encoded ECDSA
//! signatures. This conversion is **intentionally not ported** here: the `p256`
//! crate's `signature::Signer` yields the IEEE P1363 raw `r ‖ s` format (64
//! bytes) directly via `Signature::to_bytes()`. No DER parsing needed.
//!
//! ## Key input model
//!
//! [`ApnsKey`] models the two ways callers supply the `.p8` private key:
//! - `ApnsKey::Pem(String)` — an inline PKCS#8 PEM string
//!   (`-----BEGIN PRIVATE KEY-----`).
//! - `ApnsKey::Path(PathBuf)` — file path to a `.p8` file; resolved on first
//!   call to [`ApnsSigner::get_token`].
//!
//! Apple's `.p8` format is PKCS#8 DER-in-PEM wrapped with
//! `-----BEGIN PRIVATE KEY-----` (not the older SEC1
//! `-----BEGIN EC PRIVATE KEY-----`). The `p256` crate's
//! `SigningKey::from_pkcs8_pem` handles this directly.
//!
//! ## Time injection
//!
//! [`ApnsSigner`] does **not** call a clock internally. Every method that
//! requires the current time accepts `now_ms: u64` (milliseconds since the Unix
//! epoch) from the caller. This mirrors `resume_token.rs` and makes cache
//! arithmetic deterministically testable without mocking.
//!
//! At the WebSocket layer (where a real clock is needed) callers pass
//! `std::time::SystemTime::now()` converted to epoch-ms.

use std::path::PathBuf;

use base64::Engine;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey;

// ── Constants (mirrors apns-jwt.ts:28-30) ────────────────────────────────────

/// How long an APNs JWT token is valid (Apple limit: 60 min).
/// Mirrors `TOKEN_VALID_MS = 60 * 60 * 1000` (`apns-jwt.ts:28`).
const TOKEN_VALID_MS: u64 = 60 * 60 * 1_000;

/// How long before expiry we proactively re-sign.
/// Mirrors `TOKEN_REFRESH_AFTER_MS = 50 * 60 * 1000` (`apns-jwt.ts:30`).
/// Cache is valid while `now_ms - cached_at < TOKEN_REFRESH_AFTER_MS`.
const TOKEN_REFRESH_AFTER_MS: u64 = 50 * 60 * 1_000;

// ── Key input model ───────────────────────────────────────────────────────────

/// Input key model for [`ApnsSigner`].
///
/// Mirrors the `keyPemOrPath` string field in `ApnsJwtOptions`
/// (`apns-jwt.ts:43-48`) but uses a typed enum so the caller cannot
/// accidentally pass the wrong kind of string.
///
/// Both variants carry a PKCS#8 PEM P-256 private key — the format Apple
/// exports as `.p8` files from the Developer Console.
#[derive(Debug, Clone)]
pub enum ApnsKey {
    /// Inline PKCS#8 PEM string (`-----BEGIN PRIVATE KEY-----` …).
    Pem(String),
    /// Path to a `.p8` file on disk; read on first use.
    Path(PathBuf),
}

// ── ApnsSigner ────────────────────────────────────────────────────────────────

/// ES256 JWT signer for APNs token-based authentication.
///
/// Mirrors `ApnsJwtSigner` in `apns-jwt.ts:50-126`.
///
/// ## Usage
///
/// ```rust,ignore
/// let signer = ApnsSigner::new(
///     ApnsKey::Path("/path/to/AuthKey_KEYID10.p8".into()),
///     "KEYID10ABC".into(),
///     "TEAM0ABCDE".into(),
/// );
/// let now_ms = /* current epoch-ms */;
/// let token = signer.get_token(now_ms)?;
/// // token: "eyJhbGciOiJFUzI1NiIsImtpZCI6Ii4uLiJ9.eyJpc3MiOiIuLi4iLCJpYXQiOjE3MDAwMDAwMDB9.<sig>"
/// ```
pub struct ApnsSigner {
    key: ApnsKey,
    key_id: String,
    team_id: String,
    /// Resolved `SigningKey` (populated on first use). Cached so we only parse
    /// the PEM once per signer lifetime.
    signing_key: Option<SigningKey>,
    /// Cached signed token string. `None` until the first `get_token` call.
    cached_token: Option<String>,
    /// `now_ms` value when `cached_token` was last produced.
    /// Mirrors `cachedAt` (`apns-jwt.ts:53`).
    cached_at: u64,
}

impl ApnsSigner {
    /// Create a new signer. No I/O is performed at construction time.
    ///
    /// Mirrors `new ApnsJwtSigner(opts)` (`apns-jwt.ts:57-59`).
    #[must_use]
    pub fn new(key: ApnsKey, key_id: String, team_id: String) -> Self {
        Self {
            key,
            key_id,
            team_id,
            signing_key: None,
            cached_token: None,
            cached_at: 0,
        }
    }

    /// Return a cached or freshly-signed APNs JWT.
    ///
    /// - Returns the cached token if `now_ms - cached_at < TOKEN_REFRESH_AFTER_MS`
    ///   (50 min cache — mirrors `apns-jwt.ts:66-71`).
    /// - Otherwise signs a new JWT with `iat = now_ms / 1000` and caches it.
    ///
    /// `now_ms` — current epoch-milliseconds. **Not read from a clock here.**
    ///
    /// # Errors
    ///
    /// Returns an error if the PEM cannot be parsed or the key file cannot be
    /// read.
    ///
    /// # Panics
    ///
    /// Does not panic in practice: the `unwrap()` in the cache-hit fast path
    /// is guarded by `is_some()` on the same field in the condition above it,
    /// and the `expect("just resolved")` succeeds because `ensure_signing_key`
    /// either returns `Ok` (key is `Some`) or propagates an `Err`.
    pub fn get_token(&mut self, now_ms: u64) -> Result<&str, ApnsJwtError> {
        // Cache check — mirrors apns-jwt.ts:67-71.
        // Guard `now_ms >= self.cached_at` prevents a backward clock step from
        // returning 0 via saturating_sub and treating a stale cache as fresh
        // (0 < TOKEN_REFRESH_AFTER_MS is always true → stale token returned).
        if self.cached_token.is_some()
            && now_ms >= self.cached_at
            && now_ms.saturating_sub(self.cached_at) < TOKEN_REFRESH_AFTER_MS
        {
            // Safety: guarded by `is_some()` above.
            return Ok(self.cached_token.as_deref().unwrap());
        }

        // Ensure the signing key is resolved.
        self.ensure_signing_key()?;

        let signing_key = self.signing_key.as_ref().expect("just resolved");

        // iat: unix seconds — mirrors `Math.floor(now / 1000)` (apns-jwt.ts:75).
        let iat = now_ms / 1_000;

        // JWT header: {alg:"ES256", kid:keyId} — mirrors apns-jwt.ts:77.
        // JWT claims: {iss:teamId, iat} — mirrors apns-jwt.ts:78.
        //
        // Key order is FIXED to match the TS `JSON.stringify` insertion order
        // (alg,kid / iss,iat) byte-for-byte. `serde_json::json!` builds a Map
        // that, without the `preserve_order` feature, serializes keys in BTreeMap
        // (alphabetical) order — which would emit `{"iat":…,"iss":…}` and produce
        // a JWT whose signed bytes differ from the TS signer. We assemble the
        // object strings explicitly so the signing input is byte-identical to
        // `apns-jwt.ts`. ES256 signing is deterministic (RFC 6979), so identical
        // claims bytes ⇒ identical JWT.
        let header = b64url_obj(&[
            ("alg", JsonVal::Str("ES256")),
            ("kid", JsonVal::Str(&self.key_id)),
        ]);
        let claims = b64url_obj(&[
            ("iss", JsonVal::Str(&self.team_id)),
            ("iat", JsonVal::Num(iat)),
        ]);
        // Signing input — mirrors apns-jwt.ts:79.
        let signing_input = format!("{header}.{claims}");

        // Sign with p256 ECDSA (SHA-256 hash applied internally by the `Signer`
        // impl). `Signature::to_bytes()` yields the 64-byte IEEE P1363 r‖s
        // representation directly — no DER → P1363 conversion needed.
        //
        // This replaces the TS `createSign("SHA256")` + `derToP1363` path
        // (apns-jwt.ts:84-87, 137-179).
        let sig: Signature = signing_key.sign(signing_input.as_bytes());
        let sig_b64 = b64url_bytes(&sig.to_bytes());

        // Final JWT — mirrors apns-jwt.ts:89.
        let token = format!("{signing_input}.{sig_b64}");
        self.cached_token = Some(token);
        self.cached_at = now_ms;

        Ok(self.cached_token.as_deref().unwrap())
    }

    /// Invalidate the token cache, forcing a re-sign on the next `get_token`.
    ///
    /// Mirrors `invalidate()` (`apns-jwt.ts:95-98`).
    pub fn invalidate(&mut self) {
        self.cached_token = None;
        self.cached_at = 0;
    }

    /// How old the cached token is in milliseconds, measured from `now_ms`.
    /// Returns `0` if no token is cached OR if `now_ms` is before `cached_at`
    /// (backward clock step — treat as age 0 / unknown, not as negative).
    ///
    /// Mirrors `cachedAgeMs()` (`apns-jwt.ts:102-104`).
    #[must_use]
    pub fn cached_age_ms(&self, now_ms: u64) -> u64 {
        if self.cached_token.is_some() {
            // saturating_sub returns 0 on backward clock step (same as checked_sub
            // + unwrap_or(0) but satisfies clippy::manual_saturating_arithmetic).
            // The critical backward-clock guard is in get_token / is_cache_valid.
            now_ms.saturating_sub(self.cached_at)
        } else {
            0
        }
    }

    /// Whether a cached token exists and is still within the 50-min refresh window.
    /// Returns `false` on backward clock step (`now_ms < cached_at`) so that a
    /// stale token is never silently reused after CLOCK_REALTIME jumps backward.
    #[must_use]
    pub fn is_cache_valid(&self, now_ms: u64) -> bool {
        self.cached_token.is_some()
            && now_ms >= self.cached_at
            && now_ms.saturating_sub(self.cached_at) < TOKEN_REFRESH_AFTER_MS
    }

    /// The raw `TOKEN_VALID_MS` constant (60 min). Exposed for callers that need
    /// to reason about Apple's hard limit.
    #[must_use]
    pub fn token_valid_ms() -> u64 {
        TOKEN_VALID_MS
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Resolve and parse the signing key exactly once.
    ///
    /// Mirrors `resolvePem()` (`apns-jwt.ts:106-125`): reads the file if
    /// `ApnsKey::Path`, otherwise uses the inline PEM.
    fn ensure_signing_key(&mut self) -> Result<(), ApnsJwtError> {
        if self.signing_key.is_some() {
            return Ok(());
        }

        let pem: String = match &self.key {
            ApnsKey::Pem(s) => s.clone(),
            ApnsKey::Path(p) => std::fs::read_to_string(p).map_err(|e| ApnsJwtError::KeyRead {
                path: p.display().to_string(),
                source: e,
            })?,
        };

        // `from_pkcs8_pem` handles "-----BEGIN PRIVATE KEY-----" (PKCS#8) — the
        // format Apple uses for .p8 files.
        let sk = SigningKey::from_pkcs8_pem(pem.trim())
            .map_err(|e| ApnsJwtError::KeyParse(e.to_string()))?;
        self.signing_key = Some(sk);
        Ok(())
    }
}

// ── Error type ────────────────────────────────────────────────────────────────

/// Errors that can occur in [`ApnsSigner::get_token`].
#[derive(Debug)]
pub enum ApnsJwtError {
    /// File read failed (only possible with `ApnsKey::Path`).
    KeyRead {
        path: String,
        source: std::io::Error,
    },
    /// PEM parsing failed.
    KeyParse(String),
}

impl std::fmt::Display for ApnsJwtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::KeyRead { path, source } => {
                write!(f, "failed to read APNs key from {path}: {source}")
            }
            Self::KeyParse(msg) => write!(f, "failed to parse APNs key PEM: {msg}"),
        }
    }
}

impl std::error::Error for ApnsJwtError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::KeyRead { source, .. } => Some(source),
            Self::KeyParse(_) => None,
        }
    }
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

/// A JWT object field value — string or unsigned integer. Just enough to encode
/// the ES256 header/claims byte-identically to the TS signer.
enum JsonVal<'a> {
    Str(&'a str),
    Num(u64),
}

/// Base64url-encode (no padding) a JSON object whose keys are emitted in the
/// exact order given — matching the TS `JSON.stringify` insertion order so the
/// signed JWT bytes are identical (`base64urlJson` in `apns-jwt.ts:37-39`,
/// where key order follows the object literal).
///
/// String values are serialized via `serde_json::to_string` so escaping (quotes,
/// backslashes, control chars in a teamId/keyId) matches `JSON.stringify`; the
/// object braces, `:` and `,` separators carry no spaces, exactly like
/// `JSON.stringify` with no replacer/space argument.
fn b64url_obj(fields: &[(&str, JsonVal<'_>)]) -> String {
    let mut json = String::from("{");
    for (i, (key, val)) in fields.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        // Key is always a plain ASCII identifier here, but serialize it the same
        // way for safety/consistency.
        json.push_str(&serde_json::to_string(key).expect("string is serializable"));
        json.push(':');
        match val {
            JsonVal::Str(s) => {
                json.push_str(&serde_json::to_string(s).expect("string is serializable"));
            }
            JsonVal::Num(n) => {
                json.push_str(&n.to_string());
            }
        }
    }
    json.push('}');
    b64url_bytes(json.as_bytes())
}

/// Base64url-encode (no padding) raw bytes.
///
/// Mirrors `base64url` in `apns-jwt.ts:32-35`.
fn b64url_bytes(data: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    use p256::pkcs8::EncodePrivateKey;

    /// Base64url-decode (no padding). Returns `None` on invalid input.
    /// Only needed in tests (for JWT segment decoding assertions).
    fn b64url_decode(s: &str) -> Option<Vec<u8>> {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .ok()
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Generate a throwaway P-256 PKCS#8 PEM key for tests.
    fn throwaway_pem() -> String {
        let sk = SigningKey::random(&mut rand_core::OsRng);
        sk.to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
            .expect("p256 to_pkcs8_pem must succeed")
            .to_string()
    }

    /// Build a signer from an inline PEM.
    fn signer_from_pem(pem: &str) -> ApnsSigner {
        ApnsSigner::new(
            ApnsKey::Pem(pem.to_string()),
            "TESTKEY1234".to_string(),
            "TEAMID5678".to_string(),
        )
    }

    // ── JWT structure shape ───────────────────────────────────────────────────

    /// Parse a JWT (header.claims.sig) and assert shape invariants.
    ///
    /// Mirrors the TS unit-test design from `apns-jwt.ts` header comment:
    /// "decode the JWT, and assert the header/claims shape — no network required."
    #[test]
    fn jwt_shape_header_claims_sig() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_000u64; // arbitrary fixed epoch-ms

        let token = signer.get_token(now_ms).expect("sign should succeed");

        // JWT must have exactly two dots — three segments.
        let parts: Vec<&str> = token.splitn(3, '.').collect();
        assert_eq!(parts.len(), 3, "JWT must have three dot-separated segments");

        let header_bytes = b64url_decode(parts[0]).expect("header must be valid base64url");
        let claims_bytes = b64url_decode(parts[1]).expect("claims must be valid base64url");
        let sig_bytes = b64url_decode(parts[2]).expect("signature must be valid base64url");

        // Header: {alg:"ES256", kid:keyId} — mirrors apns-jwt.ts:77.
        let header: serde_json::Value =
            serde_json::from_slice(&header_bytes).expect("header must be valid JSON");
        assert_eq!(header["alg"], "ES256", "header.alg must be ES256");
        assert_eq!(header["kid"], "TESTKEY1234", "header.kid must match keyId");

        // Claims: {iss:teamId, iat:unix_seconds} — mirrors apns-jwt.ts:78.
        let claims: serde_json::Value =
            serde_json::from_slice(&claims_bytes).expect("claims must be valid JSON");
        assert_eq!(claims["iss"], "TEAMID5678", "claims.iss must match teamId");
        let iat = claims["iat"].as_u64().expect("claims.iat must be a number");
        assert_eq!(iat, now_ms / 1_000, "claims.iat must be epoch-seconds");

        // Signature must be exactly 64 bytes (P-256 P1363 r‖s).
        assert_eq!(
            sig_bytes.len(),
            64,
            "P-256 P1363 signature must be 64 bytes"
        );
    }

    /// The signed header/claims bytes must be BYTE-IDENTICAL to what the TS
    /// signer produces via `JSON.stringify` — same key order, no whitespace.
    /// TS: header `{"alg":"ES256","kid":"<keyId>"}`, claims `{"iss":"<teamId>","iat":<n>}`
    /// (apns-jwt.ts:77-78). A divergent key order would still be a valid JWT but
    /// would defeat byte-exact cross-validation against the TS reference signer.
    #[test]
    fn jwt_header_claims_bytes_match_ts_key_order() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_123u64; // .123 ms is dropped from iat (floor to s)

        let token = signer.get_token(now_ms).expect("sign should succeed");
        let parts: Vec<&str> = token.splitn(3, '.').collect();

        let header_str =
            String::from_utf8(b64url_decode(parts[0]).expect("header must be valid base64url"))
                .expect("header must be utf-8");
        let claims_str =
            String::from_utf8(b64url_decode(parts[1]).expect("claims must be valid base64url"))
                .expect("claims must be utf-8");

        assert_eq!(
            header_str, r#"{"alg":"ES256","kid":"TESTKEY1234"}"#,
            "header bytes must match TS JSON.stringify key order (alg,kid)"
        );
        assert_eq!(
            claims_str, r#"{"iss":"TEAMID5678","iat":1700000000}"#,
            "claims bytes must match TS JSON.stringify key order (iss,iat)"
        );
    }

    // ── Cache returns same token before refresh window ─────────────────────────

    /// Mirrors `apns-jwt.ts:66-71`: if `now - cachedAt < TOKEN_REFRESH_AFTER_MS`,
    /// `getToken()` returns the cached token.
    #[test]
    fn cache_returns_same_token_before_refresh() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_000u64;

        let token1 = signer.get_token(now_ms).expect("first sign").to_string();

        // Advance by 1 ms — still well within the 50-min window.
        let token2 = signer
            .get_token(now_ms + 1)
            .expect("second get_token within window")
            .to_string();

        assert_eq!(
            token1, token2,
            "cached token must be returned within refresh window"
        );
    }

    // ── Cache returns NEW token after refresh window ───────────────────────────

    /// Mirrors `apns-jwt.ts:66-71`: if `now - cachedAt >= TOKEN_REFRESH_AFTER_MS`,
    /// `getToken()` re-signs and returns a fresh token.
    ///
    /// We also assert that the new `iat` differs from the original, showing the
    /// re-sign actually happened.
    #[test]
    fn cache_refreshes_after_50_minutes() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_000u64;

        let token1 = signer.get_token(now_ms).expect("first sign").to_string();

        // Advance time past the 50-min refresh window.
        let future_ms = now_ms + TOKEN_REFRESH_AFTER_MS + 1;
        let token2 = signer
            .get_token(future_ms)
            .expect("sign after window expired")
            .to_string();

        assert_ne!(
            token1, token2,
            "token must be refreshed after 50-minute window"
        );

        // The new token's iat must reflect the new time.
        let parts: Vec<&str> = token2.splitn(3, '.').collect();
        let claims_bytes = b64url_decode(parts[1]).expect("claims base64url");
        let claims: serde_json::Value = serde_json::from_slice(&claims_bytes).expect("claims JSON");
        let new_iat = claims["iat"].as_u64().expect("iat");
        assert_eq!(
            new_iat,
            future_ms / 1_000,
            "refreshed token iat must match new now"
        );
    }

    // ── invalidate() clears the cache ────────────────────────────────────────

    /// Mirrors `invalidate()` in `apns-jwt.ts:95-98`.
    ///
    /// Verifies two distinct things:
    /// 1. After `invalidate()`, `cached_token` is `None`.
    /// 2. A subsequent `get_token` with a different `iat` produces a new token.
    ///
    /// Note: p256 ECDSA (RFC 6979) is deterministic — same key + same message
    /// = same signature. To produce a distinguishably different token after
    /// invalidation we advance `now_ms` by 1 000 ms, changing `iat` (unix
    /// seconds), which changes the signing input, yielding a different token.
    #[test]
    fn invalidate_clears_cache() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_000u64;

        let token1 = signer.get_token(now_ms).expect("first sign").to_string();

        // Assert cache was populated.
        assert!(
            signer.cached_token.is_some(),
            "cache must be set after get_token"
        );

        signer.invalidate();

        // Assert cache is cleared.
        assert!(signer.cached_token.is_none(), "invalidate must clear cache");
        assert_eq!(signer.cached_at, 0, "invalidate must reset cached_at");

        // Advance by 1 000 ms so iat (unix seconds) changes → signing input
        // differs → RFC-6979-deterministic signature is different → token differs.
        let now_ms2 = now_ms + 1_000;
        let token2 = signer
            .get_token(now_ms2)
            .expect("sign after invalidate")
            .to_string();
        assert_ne!(
            token1, token2,
            "after invalidate with a new iat, a different token must be produced"
        );
    }

    // ── cached_age_ms returns 0 when no cache ─────────────────────────────────

    #[test]
    fn cached_age_ms_zero_when_no_cache() {
        let pem = throwaway_pem();
        let signer = signer_from_pem(&pem);
        assert_eq!(signer.cached_age_ms(1_700_000_000_000), 0);
    }

    // ── is_cache_valid / cached_age_ms after first sign ──────────────────────

    #[test]
    fn is_cache_valid_semantics() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 1_700_000_000_000u64;

        signer.get_token(now_ms).expect("sign");

        // At the exact same ms → valid (age = 0 < 50min).
        assert!(signer.is_cache_valid(now_ms));

        // At 50min - 1ms → still valid.
        assert!(signer.is_cache_valid(now_ms + TOKEN_REFRESH_AFTER_MS - 1));

        // At exactly 50min → no longer valid (>= threshold).
        assert!(!signer.is_cache_valid(now_ms + TOKEN_REFRESH_AFTER_MS));
    }

    // ── Bad PEM returns an error ──────────────────────────────────────────────

    #[test]
    fn bad_pem_returns_error() {
        let mut signer = ApnsSigner::new(
            ApnsKey::Pem("not a pem".to_string()),
            "KID".into(),
            "TEAM".into(),
        );
        assert!(signer.get_token(0).is_err(), "invalid PEM must return Err");
    }

    // ── Path variant reads from disk ──────────────────────────────────────────

    #[test]
    fn path_variant_reads_key_from_disk() {
        let pem = throwaway_pem();

        // Write to a temp file.
        let dir = std::env::temp_dir();
        let path = dir.join("tp_relay_apns_jwt_test_key.p8");
        std::fs::write(&path, pem.as_bytes()).expect("write temp key");

        let mut signer = ApnsSigner::new(
            ApnsKey::Path(path.clone()),
            "TESTKEY1234".into(),
            "TEAMID5678".into(),
        );

        let now_ms = 1_700_000_000_000u64;
        let token = signer.get_token(now_ms).expect("sign from path key");

        // Must be a valid 3-part JWT.
        assert_eq!(token.split('.').count(), 3, "JWT must have 3 parts");

        // Clean up.
        let _ = std::fs::remove_file(&path);
    }

    // ── Missing file returns KeyRead error ────────────────────────────────────

    #[test]
    fn missing_file_returns_key_read_error() {
        let mut signer = ApnsSigner::new(
            ApnsKey::Path("/nonexistent/path/key.p8".into()),
            "KID".into(),
            "TEAM".into(),
        );
        let err = signer.get_token(0).unwrap_err();
        assert!(
            matches!(err, ApnsJwtError::KeyRead { .. }),
            "missing file must return KeyRead error, got: {err}"
        );
    }

    // ── Signing key is cached (only parsed once) ──────────────────────────────

    #[test]
    fn signing_key_cached_across_calls() {
        let pem = throwaway_pem();
        let mut signer = signer_from_pem(&pem);
        let now_ms = 0u64;

        signer.get_token(now_ms).expect("first call");
        // After first call, signing_key must be populated.
        assert!(signer.signing_key.is_some(), "signing key must be cached");
    }

    // ── TOKEN_VALID_MS constant is accessible ─────────────────────────────────

    #[test]
    fn token_valid_ms_is_60_minutes() {
        assert_eq!(
            ApnsSigner::token_valid_ms(),
            60 * 60 * 1_000,
            "TOKEN_VALID_MS must be 60 minutes"
        );
    }
}
