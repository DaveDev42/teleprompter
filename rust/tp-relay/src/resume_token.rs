//! Resume-token issue/verify — pure logic, relay-internal, wire-opaque.
//!
//! The TS reference (`packages/relay/src/resume-token.ts`) uses HMAC-SHA-256
//! over a dot-separated text payload. This Rust redesign (ADR A1.3 #2) uses:
//!
//! * **BLAKE2b keyed-hash (32-byte key, 32-byte output)** — already available
//!   in `blake2` 0.10 (same version that `tp-core` pins); no length-extension
//!   concern, no SHA-2 dependency.
//! * **Binary 5-part encoding** — `[version u8, role u8, daemonId utf8-len-prefixed,
//!   frontendId utf8-len-prefixed, expiresAtMs u64 BE]` eliminates the dot-in-ID
//!   ambiguity present in the TS `split(".")` approach.
//! * **Base64url (no padding)** for the wire token — the payload half and the
//!   MAC half are each base64url-encoded and joined by `.` exactly as the TS
//!   version does, so the split-on-last-dot logic is preserved at the wire layer.
//!
//! The byte layout is **NOT** compatible with the TS HMAC-SHA-256 format.  That
//! is intentional and acceptable: tokens are opaque to the relay's own relay;
//! they are issued and verified by the same `ResumeTokenSigner` instance, so
//! wire-format identity is not required — only semantic equivalence (same
//! issue/verify contract, same rejection branches, same security level).
//!
//! ## Secret loading
//!
//! `ResumeTokenSigner::new()` reads `TP_RELAY_RESUME_SECRET` from the process
//! environment.  If the value is absent, empty, or shorter than
//! `SECRET_MIN_BYTES` (32 bytes), a random 32-byte secret is generated and
//! `ephemeral = true` is set.  Ephemeral secrets do not survive a relay restart;
//! all connected clients must fall back to full `relay.auth` on reconnect.
//!
//! ## Payload binary layout (version 2)
//!
//! ```text
//! [0]         version:    u8  = 2
//! [1]         role:       u8  = 0 (daemon) | 1 (frontend)
//! [2..6]      daemonId:   u32-BE length-prefix + UTF-8 bytes
//! [6+dlen..+4] frontendId: u32-BE length-prefix + UTF-8 bytes  ("" for daemon)
//! [end-8..end] expiresAtMs: u64 BE
//! ```
//!
//! Wire token:  `<base64url(payload_bytes)>.<base64url(blake2b_keyed_32)>`
//! The MAC is computed over the **raw payload bytes**, not the base64url form.
//! Split on the **last** `.` during verify (payload b64url never contains `.`
//! because standard base64url alphabet excludes it).

use blake2::digest::generic_array::typenum::U32;
use blake2::digest::{FixedOutput, Mac};
use blake2::Blake2bMac;
use rand_core::{OsRng, RngCore};

/// Current payload version tag.
const VERSION: u8 = 2;

/// Minimum secret length in bytes (mirrors TS `SECRET_MIN_BYTES = 32`).
const SECRET_MIN_BYTES: usize = 32;

/// Default TTL: 1 hour in milliseconds (mirrors `DEFAULT_TTL_MS = 60 * 60_000`).
const DEFAULT_TTL_MS: u64 = 60 * 60_000;

/// Role discriminant byte in the binary payload.
const ROLE_DAEMON: u8 = 0;
const ROLE_FRONTEND: u8 = 1;

// ── Payload type ─────────────────────────────────────────────────────────────

/// Decoded resume-token payload. Mirrors `ResumeTokenPayload` in the TS source.
///
/// The daemon variant carries **no** `frontend_id` — the field is structurally
/// absent, not merely an empty string.  This is enforced by the enum shape.
#[derive(Debug, Clone, PartialEq)]
pub enum ResumePayload {
    Daemon {
        daemon_id: String,
        expires_at: u64,
    },
    Frontend {
        daemon_id: String,
        /// Non-empty (enforced by `verify`).
        frontend_id: String,
        expires_at: u64,
    },
}

impl ResumePayload {
    /// Return the `daemonId` regardless of role.
    pub fn daemon_id(&self) -> &str {
        match self {
            Self::Daemon { daemon_id, .. } | Self::Frontend { daemon_id, .. } => daemon_id,
        }
    }

    /// Return the `expiresAt` epoch-ms value regardless of role.
    pub fn expires_at(&self) -> u64 {
        match self {
            Self::Daemon { expires_at, .. } | Self::Frontend { expires_at, .. } => *expires_at,
        }
    }
}

// ── ResumeTokenSigner ────────────────────────────────────────────────────────

/// Issues and verifies resume tokens. A single instance per relay server.
pub struct ResumeTokenSigner {
    /// 32-byte BLAKE2b keyed-hash key.
    key: [u8; 32],
    /// `true` when the key was randomly generated (no stable env secret).
    pub ephemeral: bool,
    /// Token TTL in milliseconds (default 1 hour).
    pub ttl_ms: u64,
}

impl ResumeTokenSigner {
    /// Construct from an explicit secret and TTL override.  Pass `None` for
    /// `secret` to fall back to `TP_RELAY_RESUME_SECRET` → ephemeral random.
    pub fn new(secret: Option<&[u8]>, ttl_ms: Option<u64>) -> Self {
        let (key, ephemeral) = resolve_key(secret);
        Self {
            key,
            ephemeral,
            ttl_ms: ttl_ms.unwrap_or(DEFAULT_TTL_MS),
        }
    }

    /// Construct from the environment (`TP_RELAY_RESUME_SECRET`).
    pub fn from_env() -> Self {
        let env_val = std::env::var("TP_RELAY_RESUME_SECRET").unwrap_or_default();
        let secret = if env_val.len() >= SECRET_MIN_BYTES {
            Some(env_val.as_bytes().to_vec())
        } else {
            None
        };
        let (key, ephemeral) = resolve_key(secret.as_deref());
        Self {
            key,
            ephemeral,
            ttl_ms: DEFAULT_TTL_MS,
        }
    }

    /// Issue a resume token.
    ///
    /// `expires_at_override` lets callers set an explicit expiry (epoch-ms);
    /// when `None`, the expiry is `now_ms + self.ttl_ms`.
    ///
    /// Returns `(token_string, expires_at_ms)`.
    pub fn issue(
        &self,
        payload: &ResumePayload,
        now_ms: u64,
        expires_at_override: Option<u64>,
    ) -> (String, u64) {
        let expires_at = expires_at_override.unwrap_or(now_ms + self.ttl_ms);

        // Rebuild payload with the resolved expires_at.
        let effective = match payload {
            ResumePayload::Daemon { daemon_id, .. } => ResumePayload::Daemon {
                daemon_id: daemon_id.clone(),
                expires_at,
            },
            ResumePayload::Frontend {
                daemon_id,
                frontend_id,
                ..
            } => ResumePayload::Frontend {
                daemon_id: daemon_id.clone(),
                frontend_id: frontend_id.clone(),
                expires_at,
            },
        };

        let body = encode_payload(&effective);
        let mac = blake2b_keyed_32(&self.key, &body);

        let token = format!("{}.{}", b64url_encode(&body), b64url_encode(&mac));
        (token, expires_at)
    }

    /// Verify a resume token.
    ///
    /// Returns `None` (reject) for every branch documented in the survey:
    ///
    /// 1. No dot in `token` (or leading dot).
    /// 2. Base64url decode failure in either half.
    /// 3. MAC length mismatch (fast-path guard).
    /// 4. Constant-time MAC comparison failure.
    /// 5. Payload binary decode failure (bad version, bad role, truncated).
    /// 6. `expires_at <= now_ms` (strict: equal-to-now is rejected).
    /// 7. Empty `daemon_id`.
    /// 8. `role == frontend` with empty `frontend_id`.
    pub fn verify(&self, token: &str, now_ms: u64) -> Option<ResumePayload> {
        // 1. Split on the LAST dot.
        let dot = token.rfind('.')?;
        if dot == 0 {
            return None; // leading-dot → reject (survey: dot <= 0)
        }
        let body_b64 = &token[..dot];
        let sig_b64 = &token[dot + 1..];

        // 2. Base64url decode both halves.
        let body = b64url_decode(body_b64)?;
        let sig = b64url_decode(sig_b64)?;

        // 3. MAC length fast-path guard.
        let expected = blake2b_keyed_32(&self.key, &body);
        if sig.len() != expected.len() {
            return None;
        }

        // 4. Constant-time MAC comparison.
        if !ct_eq(&sig, &expected) {
            return None;
        }

        // 5. Decode the payload binary.
        let payload = decode_payload(&body)?;

        // 6. Expiry check (strict: <= rejects).
        if payload.expires_at() <= now_ms {
            return None;
        }

        // 7. Non-empty daemonId.
        if payload.daemon_id().is_empty() {
            return None;
        }

        // 8. Frontend role requires non-empty frontendId.
        if let ResumePayload::Frontend { frontend_id, .. } = &payload {
            if frontend_id.is_empty() {
                return None;
            }
        }

        Some(payload)
    }
}

// ── Binary payload codec ──────────────────────────────────────────────────────

/// Encode a `ResumePayload` to its binary wire form.
///
/// Layout:
/// ```text
/// [0]              version u8 = 2
/// [1]              role    u8 = 0 (daemon) | 1 (frontend)
/// [2..6]           daemonId length: u32 BE
/// [6..6+dlen]      daemonId UTF-8
/// [6+dlen..+4]     frontendId length: u32 BE
/// [10+dlen..+flen] frontendId UTF-8 ("" for daemon → 4-byte zero length)
/// [end-8..end]     expiresAtMs u64 BE
/// ```
fn encode_payload(p: &ResumePayload) -> Vec<u8> {
    let (role_byte, daemon_id, frontend_id_str, expires_at) = match p {
        ResumePayload::Daemon {
            daemon_id,
            expires_at,
        } => (ROLE_DAEMON, daemon_id.as_str(), "", *expires_at),
        ResumePayload::Frontend {
            daemon_id,
            frontend_id,
            expires_at,
        } => (
            ROLE_FRONTEND,
            daemon_id.as_str(),
            frontend_id.as_str(),
            *expires_at,
        ),
    };

    let d_bytes = daemon_id.as_bytes();
    let f_bytes = frontend_id_str.as_bytes();

    // Pre-compute size: 1 + 1 + 4 + dlen + 4 + flen + 8
    let mut buf = Vec::with_capacity(1 + 1 + 4 + d_bytes.len() + 4 + f_bytes.len() + 8);
    buf.push(VERSION);
    buf.push(role_byte);
    buf.extend_from_slice(&(d_bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(d_bytes);
    buf.extend_from_slice(&(f_bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(f_bytes);
    buf.extend_from_slice(&expires_at.to_be_bytes());
    buf
}

/// Decode the binary payload.  Returns `None` on any structural error.
fn decode_payload(b: &[u8]) -> Option<ResumePayload> {
    let mut cur = 0usize;

    // Version byte.
    let version = *b.get(cur)?;
    cur += 1;
    if version != VERSION {
        return None;
    }

    // Role byte.
    let role_byte = *b.get(cur)?;
    cur += 1;

    // daemonId (length-prefixed).
    let (daemon_id, new_cur) = read_lp_string(b, cur)?;
    cur = new_cur;

    // frontendId (length-prefixed; "" for daemon).
    let (frontend_id_str, new_cur) = read_lp_string(b, cur)?;
    cur = new_cur;

    // expiresAtMs: u64 BE — must be exactly 8 bytes at the end.
    if cur + 8 != b.len() {
        return None;
    }
    let expires_at = u64::from_be_bytes(b[cur..cur + 8].try_into().ok()?);

    match role_byte {
        ROLE_DAEMON => Some(ResumePayload::Daemon {
            daemon_id,
            expires_at,
        }),
        ROLE_FRONTEND => Some(ResumePayload::Frontend {
            daemon_id,
            frontend_id: frontend_id_str,
            expires_at,
        }),
        _ => None, // unknown role
    }
}

/// Read a u32-BE length-prefixed UTF-8 string from `b` starting at `offset`.
/// Returns `(string, new_offset)` or `None` on truncation/bad UTF-8.
fn read_lp_string(b: &[u8], offset: usize) -> Option<(String, usize)> {
    if offset + 4 > b.len() {
        return None;
    }
    let len = u32::from_be_bytes(b[offset..offset + 4].try_into().ok()?) as usize;
    let start = offset + 4;
    let end = start + len;
    if end > b.len() {
        return None;
    }
    let s = std::str::from_utf8(&b[start..end]).ok()?.to_string();
    Some((s, end))
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

type Blake2bMac32 = Blake2bMac<U32>;

/// BLAKE2b keyed-hash with a 32-byte key, producing 32-byte output.
fn blake2b_keyed_32(key: &[u8; 32], data: &[u8]) -> Vec<u8> {
    let mut mac = Blake2bMac32::new_from_slice(key).expect("32-byte key is always valid");
    blake2::digest::Update::update(&mut mac, data);
    mac.finalize_fixed().to_vec()
}

/// Constant-time byte-slice equality.  Both slices must be the same length
/// (the caller checks this first with the length guard).  Uses XOR accumulation
/// to avoid short-circuit evaluation — equivalent to Node.js `timingSafeEqual`.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

/// Base64url encode (no padding, URL-safe alphabet).
fn b64url_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Base64url decode.  Returns `None` on any invalid character.
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
}

// ── Secret resolution ─────────────────────────────────────────────────────────

/// Resolve the BLAKE2b key from an explicit byte slice.
///
/// Rules (mirrors TS constructor lines 64-78):
/// - `provided` present AND `len >= SECRET_MIN_BYTES` → use it (truncated to 32
///   bytes if longer, padded with zeros if shorter-but-still-≥32 is not possible
///   because min=32; in practice we take the first 32 bytes when > 32 bytes are
///   supplied, consistent with a fixed-size key).
/// - Otherwise → `OsRng::fill_bytes(32)`, `ephemeral = true`.
///
/// Note: BLAKE2b keyed-hash requires exactly 32 bytes for a U32 output size.
/// We derive a 32-byte key from the provided secret via a simple truncate/copy
/// into a fixed array.
fn resolve_key(provided: Option<&[u8]>) -> ([u8; 32], bool) {
    if let Some(bytes) = provided {
        if bytes.len() >= SECRET_MIN_BYTES {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes[..32]);
            return (key, false);
        }
    }
    // Ephemeral random.
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    (key, true)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn signer_with_key(key: [u8; 32]) -> ResumeTokenSigner {
        ResumeTokenSigner {
            key,
            ephemeral: false,
            ttl_ms: DEFAULT_TTL_MS,
        }
    }

    fn stable_key() -> [u8; 32] {
        [b's'; 32] // a fixed 32-byte key for deterministic tests
    }

    // ── Round-trip: daemon role ───────────────────────────────────────────────

    #[test]
    fn round_trip_daemon() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "daemon-abc".into(),
            expires_at: 9_999_999_999_999,
        };
        let now = 1_000_000_000_000u64;
        let (token, expires) = s.issue(&payload, now, Some(9_999_999_999_999));
        assert_eq!(expires, 9_999_999_999_999);

        let result = s.verify(&token, now).expect("round-trip should verify");
        assert_eq!(
            result,
            ResumePayload::Daemon {
                daemon_id: "daemon-abc".into(),
                expires_at: 9_999_999_999_999,
            }
        );
        // Daemon variant must NOT be a Frontend.
        assert!(matches!(result, ResumePayload::Daemon { .. }));
    }

    // ── Round-trip: frontend role ─────────────────────────────────────────────

    #[test]
    fn round_trip_frontend() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Frontend {
            daemon_id: "d-1".into(),
            frontend_id: "fe-1".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, Some(9_999_999_999_999));
        let result = s.verify(&token, 1_000).unwrap();
        assert_eq!(
            result,
            ResumePayload::Frontend {
                daemon_id: "d-1".into(),
                frontend_id: "fe-1".into(),
                expires_at: 9_999_999_999_999,
            }
        );
    }

    // ── expiresAt default = now + ttl ─────────────────────────────────────────

    #[test]
    fn expires_at_default_is_now_plus_ttl() {
        let s = ResumeTokenSigner {
            key: stable_key(),
            ephemeral: false,
            ttl_ms: 3_600_000, // 1 hour
        };
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at: 0, // will be overridden
        };
        let now = 1_000_000_000_000u64;
        let (_, expires) = s.issue(&payload, now, None); // no override
        assert_eq!(expires, now + 3_600_000);
    }

    // ── Expiry boundary: strict less-than ─────────────────────────────────────

    #[test]
    fn expiry_boundary_strict() {
        let s = signer_with_key(stable_key());
        let expires_at = 5_000u64;
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at,
        };
        let (token, _) = s.issue(&payload, 0, Some(expires_at));

        // now == expires_at → rejected (strict <=)
        assert!(s.verify(&token, expires_at).is_none());
        // now == expires_at - 1 → accepted
        assert!(s.verify(&token, expires_at - 1).is_some());
        // now == expires_at + 1 → rejected
        assert!(s.verify(&token, expires_at + 1).is_none());
    }

    // ── Wrong secret rejects ──────────────────────────────────────────────────

    #[test]
    fn wrong_secret_rejects() {
        let key_a = [b'a'; 32];
        let key_b = [b'b'; 32];
        let s_a = signer_with_key(key_a);
        let s_b = signer_with_key(key_b);
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s_a.issue(&payload, 0, None);
        assert!(s_b.verify(&token, 0).is_none());
    }

    // ── Tampered signature rejects ────────────────────────────────────────────

    #[test]
    fn tampered_sig_rejects() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);
        let dot = token.rfind('.').unwrap();
        let mut sig_bytes = b64url_decode(&token[dot + 1..]).unwrap();
        sig_bytes[0] ^= 0xFF; // flip a byte
        let tampered = format!("{}.{}", &token[..dot], b64url_encode(&sig_bytes));
        assert!(s.verify(&tampered, 0).is_none());
    }

    // ── Tampered payload rejects ──────────────────────────────────────────────

    #[test]
    fn tampered_payload_rejects() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);
        let dot = token.rfind('.').unwrap();
        let mut body_bytes = b64url_decode(&token[..dot]).unwrap();
        body_bytes[2] ^= 0x01; // flip a bit in daemonId length field
        let tampered = format!("{}.{}", b64url_encode(&body_bytes), &token[dot + 1..]);
        assert!(s.verify(&tampered, 0).is_none());
    }

    // ── No-dot token rejects ─────────────────────────────────────────────────

    #[test]
    fn no_dot_rejects() {
        let s = signer_with_key(stable_key());
        assert!(s.verify("nodottoken", 0).is_none());
    }

    // ── Leading-dot token rejects ─────────────────────────────────────────────

    #[test]
    fn leading_dot_rejects() {
        let s = signer_with_key(stable_key());
        assert!(s.verify(".abc", 0).is_none());
        assert!(s.verify(".abc.def", 0).is_none()); // last dot position > 0, but the
                                                    // content before first dot is empty — after split-on-last-dot
                                                    // body_b64 = ".abc" which b64url-decodes to err or invalid
    }

    // ── Bad base64url rejects ─────────────────────────────────────────────────

    #[test]
    fn bad_b64url_rejects() {
        let s = signer_with_key(stable_key());
        // Invalid base64url chars in the payload half.
        assert!(s.verify("this is not base64!.also-not", 0).is_none());
        // Invalid base64url chars in the sig half.
        assert!(s.verify("dGVzdA.this is not base64!", 0).is_none());
    }

    // ── Unknown role byte rejects ─────────────────────────────────────────────

    #[test]
    fn unknown_role_byte_rejects() {
        let s = signer_with_key(stable_key());
        // Craft a payload with role byte = 255.
        let mut buf = vec![VERSION, 0xFF]; // version=2, role=unknown
        let daemon_bytes = b"d";
        buf.extend_from_slice(&(daemon_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(daemon_bytes);
        let fe_bytes = b"";
        buf.extend_from_slice(&(fe_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(fe_bytes);
        buf.extend_from_slice(&9_999_999_999_999u64.to_be_bytes());

        let mac = blake2b_keyed_32(&stable_key(), &buf);
        let token = format!("{}.{}", b64url_encode(&buf), b64url_encode(&mac));
        assert!(s.verify(&token, 0).is_none());
    }

    // ── Bad version byte rejects ──────────────────────────────────────────────

    #[test]
    fn wrong_version_byte_rejects() {
        let s = signer_with_key(stable_key());
        // Valid payload structure but version = 1 (not 2).
        let mut buf = vec![1u8, ROLE_DAEMON]; // version=1
        let daemon_bytes = b"d";
        buf.extend_from_slice(&(daemon_bytes.len() as u32).to_be_bytes());
        buf.extend_from_slice(daemon_bytes);
        buf.extend_from_slice(&0u32.to_be_bytes());
        buf.extend_from_slice(&9_999_999_999_999u64.to_be_bytes());

        let mac = blake2b_keyed_32(&stable_key(), &buf);
        let token = format!("{}.{}", b64url_encode(&buf), b64url_encode(&mac));
        assert!(s.verify(&token, 0).is_none());
    }

    // ── Empty daemonId rejects ────────────────────────────────────────────────

    #[test]
    fn empty_daemon_id_rejects() {
        let s = signer_with_key(stable_key());
        // Issue with an empty daemon_id.
        let payload = ResumePayload::Daemon {
            daemon_id: String::new(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);
        assert!(s.verify(&token, 0).is_none());
    }

    // ── Empty frontendId rejects for frontend role ────────────────────────────

    #[test]
    fn empty_frontend_id_rejects_for_frontend_role() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Frontend {
            daemon_id: "d".into(),
            frontend_id: String::new(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);
        assert!(s.verify(&token, 0).is_none());
    }

    // ── Daemon role's empty frontendId slot does NOT cause reject ─────────────

    #[test]
    fn daemon_role_ignores_frontend_id_slot() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "d-real".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);
        // Must accept — daemon always serialises "" in slot[2].
        assert!(s.verify(&token, 0).is_some());
    }

    // ── Short secret → ephemeral key ─────────────────────────────────────────

    #[test]
    fn short_secret_falls_back_to_ephemeral() {
        let short = b"short"; // < 32 bytes
        let signer = ResumeTokenSigner::new(Some(short), None);
        assert!(signer.ephemeral, "short secret must produce ephemeral=true");
    }

    // ── 32-byte secret → non-ephemeral ───────────────────────────────────────

    #[test]
    fn stable_secret_is_not_ephemeral() {
        let secret = [b'x'; 32];
        let signer = ResumeTokenSigner::new(Some(&secret), None);
        assert!(
            !signer.ephemeral,
            "stable secret must produce ephemeral=false"
        );
    }

    // ── Timing-safe: constant-time helper returns correct results ─────────────

    #[test]
    fn ct_eq_correctness() {
        assert!(ct_eq(b"hello", b"hello"));
        assert!(!ct_eq(b"hello", b"world"));
        assert!(!ct_eq(b"a", b"ab")); // different lengths
        assert!(ct_eq(b"", b"")); // both empty
    }

    // ── Wire compat: daemon token double-dot structure ────────────────────────

    #[test]
    fn wire_compat_daemon_token_round_trip() {
        // Mirrors the TS wire-compat test with stable IDs.
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "d-wire".into(),
            expires_at: 9_999_999_999_999,
        };
        let (token, _) = s.issue(&payload, 0, None);

        // Token must contain exactly one `.` (last-dot split).
        let dot_count = token.chars().filter(|&c| c == '.').count();
        assert_eq!(
            dot_count, 1,
            "token must have exactly one dot (payload.mac)"
        );

        let verified = s.verify(&token, 0).unwrap();
        assert_eq!(verified.daemon_id(), "d-wire");
    }

    // ── Wire compat: frontend token round-trip ────────────────────────────────

    #[test]
    fn wire_compat_frontend_token_round_trip() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Frontend {
            daemon_id: "d-wire".into(),
            frontend_id: "fe-wire".into(),
            expires_at: 9_999_999_999_999,
        };
        // Pass the explicit expiry so it is preserved (not overridden by now+ttl).
        let (token, _) = s.issue(&payload, 0, Some(9_999_999_999_999));
        let verified = s.verify(&token, 0).unwrap();
        assert_eq!(
            verified,
            ResumePayload::Frontend {
                daemon_id: "d-wire".into(),
                frontend_id: "fe-wire".into(),
                expires_at: 9_999_999_999_999,
            }
        );
    }

    // ── Expired token rejected ────────────────────────────────────────────────

    #[test]
    fn expired_token_rejected() {
        let s = signer_with_key(stable_key());
        let payload = ResumePayload::Daemon {
            daemon_id: "d".into(),
            expires_at: 999,
        };
        let (token, _) = s.issue(&payload, 0, Some(999));
        assert!(s.verify(&token, 1000).is_none()); // now > expires_at
    }

    // ── Truncated payload rejects ─────────────────────────────────────────────

    #[test]
    fn truncated_payload_rejects() {
        let s = signer_with_key(stable_key());
        // 2 bytes — way too short.
        let buf = vec![VERSION, ROLE_DAEMON];
        let mac = blake2b_keyed_32(&stable_key(), &buf);
        let token = format!("{}.{}", b64url_encode(&buf), b64url_encode(&mac));
        assert!(s.verify(&token, 0).is_none());
    }
}
