//! Error type shared across tp-core, surfaced to Swift via UniFFI.

use thiserror::Error;

/// All fallible tp-core operations return this. UniFFI maps each variant to a
/// Swift `enum TpError: Error` case, so Swift `catch` clauses can match on the
/// specific failure (decode vs. crypto-auth vs. bad-input).
#[derive(Debug, Error, uniffi::Error)]
#[uniffi(flat_error)]
pub enum TpError {
    /// A frame header declared a size beyond the 64 MiB ceiling, or the buffer
    /// was malformed. Unrecoverable — the caller must tear down the connection.
    #[error("frame error: {0}")]
    Frame(String),

    /// JSON (de)serialization failed.
    #[error("codec error: {0}")]
    Codec(String),

    /// An input had the wrong length (e.g. a key that was not 32 bytes).
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// AEAD authentication failed (wrong key/nonce/AAD, or tampered ciphertext),
    /// or base64 decoding of the sealed blob failed.
    #[error("crypto error: {0}")]
    Crypto(String),

    /// A pairing deep-link could not be parsed.
    #[error("pairing error: {0}")]
    Pairing(String),
}

pub type Result<T> = std::result::Result<T, TpError>;
