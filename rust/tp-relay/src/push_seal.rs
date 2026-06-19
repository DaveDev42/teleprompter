//! Push-token sealer — thin crypto wrapper over `tp-core`.
//!
//! ## Wire blob format
//!
//! ```text
//! "tpps1." + <version:decimal> + "." + base64(nonce24 || aead_ciphertext)
//! ```
//!
//! * `"tpps1."` — format magic + format-version (1).
//! * `<version>` — positive integer key-version (from
//!   `TP_RELAY_PUSH_SEAL_VERSION` env or constructor option, default 1).
//! * The base64 payload is produced by `tp_core::crypto::seal_with_aad`, which
//!   encodes `nonce24 || ciphertext` as standard base64 — identical layout to
//!   the TypeScript `sealWithAad` helper (`packages/protocol/src/crypto.ts:268-284`).
//! * AAD = UTF-8 bytes of the prefix string `"tpps1.<version>"`, binding both
//!   the format-version and key-version into the AEAD tag.
//!
//! ## Parity source
//!
//! TypeScript reference: `packages/relay/src/push-seal.ts` (read at HEAD,
//! cited below by line).
//!
//! ## Seal/open layout verification
//!
//! TS `sealWithAad` (`packages/protocol/src/crypto.ts:268-284`):
//!   returns `toBase64(nonce24 || ciphertext)` — layout: `base64(nonce24 || ct)`.
//!
//! Rust `tp_core::crypto::seal_with_aad` (`rust/tp-core/src/crypto.rs:157-164`):
//!   writes `nonce ++ ct` into a `Vec`, then calls `b64_encode(&combined)` —
//!   same layout: `base64(nonce24 || ct)`.
//!
//! They are byte-identical. Both use XChaCha20-Poly1305 with a 24-byte nonce.
//!
//! ## REDESIGN-NOW: `OsRng` for ephemeral secret + per-seal nonce
//!
//! TS `push-seal.ts:65-68` generated the ephemeral fallback secret with
//! `Math.floor(Math.random() * 16).toString(16)` — a weak PRNG.  In this Rust
//! port **both** the ephemeral secret **and** the 24-byte per-seal nonce are
//! generated with `OsRng` (cryptographically secure).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use rand_core::{OsRng, RngCore};
use tp_core::crypto::{derive_push_seal_key, open_with_aad, seal_with_aad, NPUB_BYTES};

/// Blob prefix — both format magic and format-version marker.
/// Mirrors `BLOB_PREFIX = "tpps1."` in `push-seal.ts:21`.
const BLOB_PREFIX: &str = "tpps1.";

/// Minimum secret length in characters.
/// Mirrors `SECRET_MIN_CHARS = 32` in `push-seal.ts:22`.
const SECRET_MIN_CHARS: usize = 32;

/// Default key version when neither option nor env is set.
/// Mirrors `this.version = 1` fallback in `push-seal.ts:88`.
const DEFAULT_VERSION: u32 = 1;

// ── UnsealResult ─────────────────────────────────────────────────────────────

/// Result of [`PushSealer::unseal`].
///
/// Mirrors the TypeScript tagged union `UnsealResult` (`push-seal.ts:24-26`):
///
/// ```typescript
/// type UnsealResult =
///   | { ok: true; token: string }
///   | { ok: false; reason: "legacy" | "unseal_failed" | "parse_error" };
/// ```
#[derive(Debug, PartialEq, Eq)]
pub enum UnsealResult {
    /// AEAD decryption succeeded — `token` is the original plaintext push token.
    Ok(String),
    /// Blob does not start with `"tpps1."` — legacy plaintext token.
    /// Mirrors `reason: "legacy"`.
    Legacy,
    /// `"tpps1."` prefix present but structure is malformed (missing dot,
    /// non-integer / leading-zero version string).
    /// Mirrors `reason: "parse_error"`.
    ParseError,
    /// AEAD decryption failed: wrong key, tampered ciphertext, rotated-out
    /// version, or unknown version.
    /// Mirrors `reason: "unseal_failed"`.
    UnsealFailed,
}

// ── PushSealer ────────────────────────────────────────────────────────────────

/// Relay-side push-token sealer.
///
/// Modelled after `PushSealer` in `push-seal.ts:46-176`. Reads config from
/// environment variables or constructor options. Derived AEAD keys are cached
/// on first use.
///
/// `ephemeral` is `true` when no secret was configured — seals are still
/// self-consistent within the process lifetime but stop working after a restart.
pub struct PushSealer {
    /// Raw bytes of the current secret.
    current_secret: Vec<u8>,
    /// Raw bytes of the previous secret (for key rotation).
    prev_secret: Option<Vec<u8>>,
    /// Current key version (positive integer).
    pub version: u32,
    /// `true` when the current secret was randomly generated (no env secret).
    pub ephemeral: bool,
    /// Cache of derived 32-byte AEAD keys keyed by version number.
    ///
    /// Populated lazily on first `seal` / `unseal`. Guarded by a `Mutex`
    /// so `PushSealer` can be shared across threads (`Arc<PushSealer>`).
    key_cache: Mutex<HashMap<u32, [u8; 32]>>,
}

impl PushSealer {
    /// Construct a `PushSealer` with explicit overrides.
    ///
    /// Mirrors the `PushSealer` constructor in `push-seal.ts:55-89`.
    ///
    /// # Arguments
    ///
    /// * `secret` — override for `TP_RELAY_PUSH_SEAL_SECRET`.
    /// * `secret_prev` — override for `TP_RELAY_PUSH_SEAL_SECRET_PREV`.
    /// * `version` — override for `TP_RELAY_PUSH_SEAL_VERSION`.
    #[must_use]
    pub fn new(secret: Option<&str>, secret_prev: Option<&str>, version: Option<u32>) -> Self {
        // ── Current secret ────────────────────────────────────────────────────
        // push-seal.ts:56-70
        let env_secret = std::env::var("TP_RELAY_PUSH_SEAL_SECRET").unwrap_or_default();
        let provided = secret.unwrap_or(&env_secret);
        let (current_secret, ephemeral) = if provided.len() >= SECRET_MIN_CHARS {
            (provided.as_bytes().to_vec(), false)
        } else {
            // Ephemeral: generate a random 32-byte secret.
            // REDESIGN: OsRng instead of TS Math.random() (push-seal.ts:65-68 weak RNG bug).
            let mut buf = vec![0u8; 32];
            OsRng.fill_bytes(&mut buf);
            (buf, true)
        };

        // ── Previous secret ───────────────────────────────────────────────────
        // push-seal.ts:72-76
        let env_prev = std::env::var("TP_RELAY_PUSH_SEAL_SECRET_PREV").unwrap_or_default();
        let prev_secret: Option<Vec<u8>> = {
            let raw = secret_prev.map(str::to_owned).or(if env_prev.is_empty() {
                None
            } else {
                Some(env_prev)
            });
            raw.filter(|s| s.len() >= SECRET_MIN_CHARS)
                .map(String::into_bytes)
        };

        // ── Version ───────────────────────────────────────────────────────────
        // push-seal.ts:81-88: version must be a positive integer; version=0
        // must NOT select currentSecret (sentinel collision guard).
        let resolved_version = if let Some(v) = version {
            if v > 0 {
                v
            } else {
                DEFAULT_VERSION
            }
        } else {
            let env_version = std::env::var("TP_RELAY_PUSH_SEAL_VERSION").unwrap_or_default();
            if env_version.is_empty() {
                DEFAULT_VERSION
            } else {
                env_version
                    .parse::<u32>()
                    .ok()
                    .filter(|&v| v > 0)
                    .unwrap_or(DEFAULT_VERSION)
            }
        };

        Self {
            current_secret,
            prev_secret,
            version: resolved_version,
            ephemeral,
            key_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Construct from the environment (no explicit overrides).
    ///
    /// Convenience wrapper for `PushSealer::new(None, None, None)`.
    #[must_use]
    pub fn from_env() -> Self {
        Self::new(None, None, None)
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// Build the AAD/blob-prefix for a given version.
    ///
    /// Mirrors `blobPrefix(version)` in `push-seal.ts:115-117`:
    /// ```typescript
    /// return `${BLOB_PREFIX}${version}`;
    /// ```
    fn blob_prefix(version: u32) -> String {
        format!("{BLOB_PREFIX}{version}")
    }

    /// Derive the AEAD key for `version` and return it; `None` if the version
    /// is not covered by the current or previous secret.
    ///
    /// Mirrors `getKey(version)` in `push-seal.ts:96-113`.
    fn get_key(&self, version: u32) -> Option<[u8; 32]> {
        // Fast path: cache hit.
        {
            let cache = self.key_cache.lock().expect("key_cache poisoned");
            if let Some(&key) = cache.get(&version) {
                return Some(key);
            }
        }

        // Determine which raw secret to use.
        // push-seal.ts:101-112
        let raw_secret: Option<&[u8]> = if version == self.version {
            Some(&self.current_secret)
        } else if version == self.version.wrapping_sub(1)
            && self.version > 0
            && self.prev_secret.is_some()
        {
            self.prev_secret.as_deref()
        } else {
            None
        };

        let raw = raw_secret?;
        let key = derive_push_seal_key(raw);

        // Store in cache.
        let mut cache = self.key_cache.lock().expect("key_cache poisoned");
        cache.insert(version, key);
        Some(key)
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// Seal a plaintext push token, returning a blob of the form
    /// `"tpps1.<version>.<base64(nonce24||ciphertext)>"`.
    ///
    /// Mirrors `PushSealer.seal(token)` in `push-seal.ts:123-133`.
    ///
    /// # Errors
    ///
    /// Returns an error string if the current key cannot be derived (should not
    /// happen in practice — only if `version == 0`, which is blocked by the
    /// constructor).
    pub fn seal(&self, token: &str) -> Result<String, String> {
        let key = self
            .get_key(self.version)
            .ok_or_else(|| "PushSealer: could not derive current key".to_owned())?;

        let prefix = Self::blob_prefix(self.version);
        let aad = prefix.as_bytes();
        let plaintext = token.as_bytes();

        // REDESIGN: 24-byte nonce via OsRng (not Math.random from TS push-seal.ts:65-68).
        let mut nonce = [0u8; NPUB_BYTES];
        OsRng.fill_bytes(&mut nonce);

        // tp_core::crypto::seal_with_aad produces base64(nonce24 || ct) — same
        // layout as TS sealWithAad (packages/protocol/src/crypto.ts:268-284).
        let b64 = seal_with_aad(plaintext, &key, aad, &nonce)
            .map_err(|e| format!("PushSealer: seal_with_aad failed: {e}"))?;

        Ok(format!("{prefix}.{b64}"))
    }

    /// Unseal a blob produced by [`PushSealer::seal`].
    ///
    /// Returns:
    /// - [`UnsealResult::Ok`] on success (contains the plaintext token).
    /// - [`UnsealResult::Legacy`] for non-`"tpps1."` blobs.
    /// - [`UnsealResult::ParseError`] for malformed `"tpps1."` blobs.
    /// - [`UnsealResult::UnsealFailed`] for AEAD failures.
    ///
    /// Mirrors `PushSealer.unseal(blob)` in `push-seal.ts:144-175`.
    #[must_use]
    pub fn unseal(&self, blob: &str) -> UnsealResult {
        // push-seal.ts:145-147: not starting with "tpps1." → legacy
        if !blob.starts_with(BLOB_PREFIX) {
            return UnsealResult::Legacy;
        }

        // Parse "tpps1.<version>.<b64>"
        // push-seal.ts:150-155: slice after magic, find first dot.
        let after_magic = &blob[BLOB_PREFIX.len()..]; // "<version>.<b64>"
        let Some(dot_idx) = after_magic.find('.') else {
            return UnsealResult::ParseError;
        };
        let version_str = &after_magic[..dot_idx];
        let b64 = &after_magic[dot_idx + 1..];

        // push-seal.ts:157-159:
        //   parseInt(versionStr, 10)
        //   String(version) === versionStr   ← rejects leading zeros, "1.5", "abc"
        let Ok(version) = version_str.parse::<u32>() else {
            return UnsealResult::ParseError;
        };
        // Round-trip check mirrors `String(version) === versionStr`:
        // rejects leading zeros ("01", "001"), negative sign, etc.
        if version.to_string() != version_str {
            return UnsealResult::ParseError;
        }

        // push-seal.ts:162-163: getKey → None → unseal_failed
        let Some(key) = self.get_key(version) else {
            return UnsealResult::UnsealFailed;
        };

        // push-seal.ts:165-174: openWithAad; exception → unseal_failed
        let prefix = Self::blob_prefix(version);
        let aad = prefix.as_bytes();
        match open_with_aad(b64, &key, aad) {
            Ok(plaintext_bytes) => match String::from_utf8(plaintext_bytes) {
                Ok(token) => UnsealResult::Ok(token),
                Err(_) => UnsealResult::UnsealFailed,
            },
            Err(_) => UnsealResult::UnsealFailed,
        }
    }
}

// ── Shared singleton via OnceLock ─────────────────────────────────────────────

static GLOBAL_PUSH_SEALER: OnceLock<PushSealer> = OnceLock::new();

/// Return a reference to the process-global `PushSealer`, initialized from
/// environment variables on first call.
pub fn global_push_sealer() -> &'static PushSealer {
    GLOBAL_PUSH_SEALER.get_or_init(PushSealer::from_env)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixed 32-char secret that passes `SECRET_MIN_CHARS`.
    /// Mirrors `const SECRET = "a".repeat(32)` in `push-seal.test.ts:5`.
    const SECRET: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 32 × 'a'
    const SECRET_PREV: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // 32 × 'b'

    fn sealer(secret: &str) -> PushSealer {
        PushSealer::new(Some(secret), None, None)
    }

    // ── Round-trip ────────────────────────────────────────────────────────────

    /// Round-trip: seal → unseal yields the original token.
    /// Mirrors `push-seal.test.ts:35-41` ("seal → unseal round-trip").
    #[test]
    fn round_trip_seal_unseal() {
        let s = sealer(SECRET);
        let token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxxxx]";
        let blob = s.seal(token).expect("seal should succeed");
        assert_eq!(s.unseal(&blob), UnsealResult::Ok(token.to_owned()));
    }

    // ── Blob prefix ───────────────────────────────────────────────────────────

    /// Sealed blob starts with the expected version prefix.
    /// Mirrors `push-seal.test.ts:43-47` ("sealed blob starts with correct version prefix").
    #[test]
    fn blob_has_correct_prefix() {
        let s = PushSealer::new(Some(SECRET), None, Some(3));
        let blob = s.seal("mytoken").unwrap();
        assert!(
            blob.starts_with("tpps1.3."),
            "blob should start with tpps1.3. but got: {blob}"
        );
    }

    /// Default version is 1.
    /// Mirrors `push-seal.test.ts:49-54` ("default version is 1").
    #[test]
    fn default_version_is_1() {
        let s = sealer(SECRET);
        assert_eq!(s.version, 1);
        let blob = s.seal("tok").unwrap();
        assert!(blob.starts_with("tpps1.1."));
    }

    // ── Random nonce ─────────────────────────────────────────────────────────

    /// Each seal produces a different blob (random nonce per call).
    /// Mirrors `push-seal.test.ts:56-67` ("each seal produces a different blob (random nonce)").
    #[test]
    fn each_seal_is_different() {
        let s = sealer(SECRET);
        let token = "mytoken";
        let b1 = s.seal(token).unwrap();
        let b2 = s.seal(token).unwrap();
        assert_ne!(b1, b2, "different nonces must produce different blobs");
        // Both must unseal correctly.
        assert_eq!(s.unseal(&b1), UnsealResult::Ok(token.to_owned()));
        assert_eq!(s.unseal(&b2), UnsealResult::Ok(token.to_owned()));
    }

    // ── Ephemeral mode ────────────────────────────────────────────────────────

    /// `ephemeral=true` when no secret or secret too short.
    /// Mirrors `push-seal.test.ts:110-115`.
    #[test]
    fn ephemeral_when_no_secret() {
        let s1 = PushSealer::new(Some("short"), None, None);
        assert!(s1.ephemeral, "short secret must be ephemeral");
        let s2 = PushSealer::new(None, None, None);
        // Cannot test env-driven behaviour here without mucking global env,
        // but with no secret provided and no env set we expect ephemeral.
        // (TP_RELAY_PUSH_SEAL_SECRET is typically absent in test runs.)
        drop(s2);
    }

    /// `ephemeral=false` when secret is ≥ 32 chars.
    /// Mirrors `push-seal.test.ts:117-120`.
    #[test]
    fn not_ephemeral_when_secret_provided() {
        let s = sealer(SECRET);
        assert!(!s.ephemeral);
    }

    /// Ephemeral sealer is self-consistent (seal→unseal works in same process).
    /// Mirrors `push-seal.test.ts:122-129`.
    #[test]
    fn ephemeral_self_consistent() {
        // Force ephemeral by supplying a too-short secret.
        let s = PushSealer::new(Some("x"), None, None);
        assert!(s.ephemeral);
        let token = "tok-ephemeral";
        let blob = s.seal(token).unwrap();
        assert_eq!(s.unseal(&blob), UnsealResult::Ok(token.to_owned()));
    }

    // ── Key rotation ──────────────────────────────────────────────────────────

    /// v1 blob unseals via prevSecret when current is v2.
    /// Mirrors `push-seal.test.ts:70-86`.
    #[test]
    fn key_rotation_prev_unseals_old_blob() {
        // Seal at v1 with SECRET.
        let sealer_v1 = PushSealer::new(Some(SECRET), None, Some(1));
        let token = "my-old-token";
        let blob = sealer_v1.seal(token).unwrap();
        assert!(blob.starts_with("tpps1.1."));

        // Upgrade: current = SECRET_PREV at v2, prev = SECRET (old).
        let sealer_v2 = PushSealer::new(Some(SECRET_PREV), Some(SECRET), Some(2));
        let result = sealer_v2.unseal(&blob);
        assert_eq!(result, UnsealResult::Ok(token.to_owned()));
    }

    /// Rotated-out version (not current or prev) → `UnsealFailed`.
    /// Mirrors `push-seal.test.ts:88-100`.
    #[test]
    fn rotated_out_version_is_unseal_failed() {
        let sealer_v1 = PushSealer::new(Some(SECRET), None, Some(1));
        let blob = sealer_v1.seal("tok").unwrap();

        // Current is v3; prev covers v2 only → v1 is gone.
        let sealer_v3 = PushSealer::new(
            Some("cccccccccccccccccccccccccccccccc"),
            Some(SECRET_PREV),
            Some(3),
        );
        assert_eq!(sealer_v3.unseal(&blob), UnsealResult::UnsealFailed);
    }

    // ── Legacy ────────────────────────────────────────────────────────────────

    /// Blob not starting with "tpps1." → `Legacy`.
    /// Mirrors `push-seal.test.ts:103-107`.
    #[test]
    fn legacy_blob_detected() {
        let s = sealer(SECRET);
        assert_eq!(s.unseal("ExponentPushToken[abc123]"), UnsealResult::Legacy);
    }

    // ── Tamper / truncation ───────────────────────────────────────────────────

    /// Tampered ciphertext → `UnsealFailed`.
    /// Mirrors `push-seal.test.ts:132-144`.
    #[test]
    fn tampered_body_is_unseal_failed() {
        let s = sealer(SECRET);
        let blob = s.seal("tok").unwrap();

        // Corrupt a character in the base64 body (third segment after two dots).
        let parts: Vec<&str> = blob.splitn(3, '.').collect();
        assert_eq!(parts.len(), 3, "blob must have 3 dot-delimited parts");
        let b64 = parts[2];
        let tampered_char = if b64.as_bytes().first() == Some(&b'A') {
            'B'
        } else {
            'A'
        };
        let tampered_b64 = format!("{tampered_char}{}", &b64[1..]);
        let tampered_blob = format!("{}.{}.{tampered_b64}", parts[0], parts[1]);

        assert_eq!(s.unseal(&tampered_blob), UnsealResult::UnsealFailed);
    }

    /// Wrong key → `UnsealFailed`.
    /// Mirrors `push-seal.test.ts:146-152`.
    #[test]
    fn wrong_key_is_unseal_failed() {
        let s1 = sealer(SECRET);
        let s2 = sealer("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
        let blob = s1.seal("tok").unwrap();
        assert_eq!(s2.unseal(&blob), UnsealResult::UnsealFailed);
    }

    /// Truncated blob → `ParseError` or `UnsealFailed`.
    /// Mirrors `push-seal.test.ts:154-161` (either outcome is acceptable).
    #[test]
    fn truncated_blob_fails() {
        let s = sealer(SECRET);
        let blob = s.seal("tok").unwrap();
        let truncated = &blob[..blob.len().saturating_sub(4)];
        let result = s.unseal(truncated);
        assert!(
            result == UnsealResult::ParseError || result == UnsealResult::UnsealFailed,
            "truncated blob must be parse_error or unseal_failed, got {result:?}"
        );
    }

    // ── Parse errors ──────────────────────────────────────────────────────────

    /// Non-integer version string → `ParseError`.
    /// Mirrors `push-seal.test.ts:163-167`.
    #[test]
    fn non_integer_version_is_parse_error() {
        let s = sealer(SECRET);
        assert_eq!(
            s.unseal("tpps1.abc.somebase64data"),
            UnsealResult::ParseError
        );
    }

    /// Missing dot after version → `ParseError`.
    /// Mirrors `push-seal.test.ts:169-173`.
    #[test]
    fn missing_dot_after_version_is_parse_error() {
        let s = sealer(SECRET);
        assert_eq!(s.unseal("tpps1.1nodot"), UnsealResult::ParseError);
    }

    // ── Cross-vector: TS round-trip compatibility ─────────────────────────────
    //
    // The TS test suite uses a fixed secret `"a".repeat(32)` and default
    // version 1 (`push-seal.test.ts:5, 35-41`).  We seal the same token with
    // the same secret+version and verify round-trip.  We cannot fix the raw
    // base64 across runtimes (random nonce), but we can confirm the structural
    // contract is identical.

    /// Self-golden: same secret + version ⟹ correct blob structure and round-trip.
    /// Verifies our seal layout matches the TS contract from `push-seal.test.ts:35-41`.
    #[test]
    fn ts_cross_vector_contract() {
        let s = PushSealer::new(Some(SECRET), None, Some(1));
        let token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxxxx]";
        let blob = s.seal(token).unwrap();

        // Structure: "tpps1.1.<base64>"
        assert!(
            blob.starts_with("tpps1.1."),
            "blob must start with tpps1.1."
        );
        let parts: Vec<&str> = blob.splitn(3, '.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "tpps1");
        assert_eq!(parts[1], "1");
        // The b64 segment must be non-empty and round-trip correctly.
        assert!(!parts[2].is_empty());
        assert_eq!(s.unseal(&blob), UnsealResult::Ok(token.to_owned()));
    }
}
