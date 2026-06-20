//! Framed-JSON codec — encode and decode the wire transport shared by all tp
//! components (IPC, relay WS).
//!
//! Wire format v2 (`packages/protocol/src/codec.ts:30-57`):
//!
//! ```text
//!   [u32_be jsonLen][u32_be binLen=0][utf-8 JSON]
//! ```
//!
//! For IPC ctrl frames `binLen` is always 0 (no binary sidecar). The 8-byte
//! header is followed immediately by `jsonLen` bytes of UTF-8 JSON. One frame
//! per connection-lifetime on the CLI side (connect → write request → read one
//! response → close).
//!
//! `MAX_FRAME_SIZE` mirrors the TS 64 MiB ceiling so a poison header is
//! rejected before we attempt to buffer anything.

use std::io::{self, Read};

/// Maximum allowed JSON payload size. Mirrors `MAX_FRAME_SIZE` in
/// `packages/protocol/src/codec.ts:15` (64 MiB), which is also the combined
/// jsonLen+binLen ceiling for the TS decoder.
pub const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

const HEADER_SIZE: usize = 8;

/// Encode a JSON byte slice into a complete wire frame.
///
/// Layout: `[u32_be json.len()][u32_be 0][json bytes]`.
/// The caller must pass pre-serialized UTF-8 JSON (e.g. from
/// `serde_json::to_vec`).
pub fn encode_frame(json: &[u8]) -> Vec<u8> {
    let json_len = json.len();
    let mut frame = Vec::with_capacity(HEADER_SIZE + json_len);
    // u32_be jsonLen — payloads larger than u32::MAX are rejected by callers
    // before this point (MAX_FRAME_SIZE = 64 MiB << 4 GiB). The cast is safe
    // in practice; suppress the pedantic truncation lint explicitly.
    #[allow(clippy::cast_possible_truncation)]
    let json_len_u32 = json_len as u32;
    frame.extend_from_slice(&json_len_u32.to_be_bytes());
    // u32_be binLen = 0  (IPC ctrl frames never carry a binary sidecar)
    frame.extend_from_slice(&0u32.to_be_bytes());
    // UTF-8 JSON payload
    frame.extend_from_slice(json);
    frame
}

/// Read one complete frame from `reader`. Returns the decoded JSON bytes.
///
/// Protocol:
/// 1. Read the 8-byte header.
/// 2. Parse `jsonLen` (bytes 0-3, big-endian) and `binLen` (bytes 4-7).
/// 3. Reject if `jsonLen + binLen > MAX_FRAME_SIZE` (mirrors the TS H1 guard).
/// 4. Read exactly `jsonLen` bytes → return them.
///    The `binLen` bytes (if any) are consumed and discarded — the CLI never
///    uses binary sidecars.
///
/// Returns `Err` on any I/O error (including EOF mid-frame) or an oversized
/// payload.
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0u8; HEADER_SIZE];
    reader.read_exact(&mut header)?;

    let json_len = u32::from_be_bytes(header[0..4].try_into().unwrap()) as usize;
    let bin_len = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;

    if json_len + bin_len > MAX_FRAME_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Frame too large: {} bytes exceeds max {}",
                json_len + bin_len,
                MAX_FRAME_SIZE
            ),
        ));
    }

    let mut json = vec![0u8; json_len];
    reader.read_exact(&mut json)?;

    // Consume and discard any binary sidecar (IPC ctrl never sends one, but
    // we handle it defensively so the decoder stays correct for any response
    // the daemon might attach binary to in the future).
    if bin_len > 0 {
        let mut discard = vec![0u8; bin_len];
        reader.read_exact(&mut discard)?;
    }

    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the exact 8-byte header layout (bytes 0-3 = jsonLen big-endian,
    /// bytes 4-7 = binLen = 0). Ground truth: codec.ts:47-55.
    #[test]
    fn header_layout_is_exact() {
        let json = b"{}";
        let frame = encode_frame(json);
        // Byte 0-3: jsonLen = 2, big-endian
        assert_eq!(&frame[0..4], &[0, 0, 0, 2], "jsonLen bytes");
        // Byte 4-7: binLen = 0, big-endian
        assert_eq!(&frame[4..8], &[0, 0, 0, 0], "binLen bytes");
        // Byte 8+: the JSON payload
        assert_eq!(&frame[8..], b"{}", "JSON payload");
    }

    /// Verify that an empty JSON body (len=0) produces a valid frame.
    #[test]
    fn empty_json_frame() {
        let frame = encode_frame(b"");
        assert_eq!(frame.len(), HEADER_SIZE);
        assert_eq!(&frame[0..4], &[0, 0, 0, 0]);
        assert_eq!(&frame[4..8], &[0, 0, 0, 0]);
    }

    /// Round-trip: encode then decode recovers the original bytes.
    #[test]
    fn encode_decode_round_trip() {
        let payload =
            br#"{"t":"session.prune","age":{"kind":"all"},"includeRunning":false,"dryRun":true}"#;
        let frame = encode_frame(payload);
        let decoded = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!(decoded, payload);
    }

    /// The header's jsonLen field maps to the 4-byte big-endian integer in the
    /// first 4 bytes. Assert the value for a known payload.
    #[test]
    fn json_len_encoded_correctly() {
        let json = b"hello";
        let frame = encode_frame(json);
        let json_len = u32::from_be_bytes(frame[0..4].try_into().unwrap());
        assert_eq!(json_len as usize, json.len());
    }

    /// Oversized frame is rejected by `read_frame` (H1 guard).
    #[test]
    fn oversized_frame_rejected() {
        // Craft a header claiming jsonLen = MAX + 1 bytes.
        let mut poison = Vec::with_capacity(HEADER_SIZE);
        poison.extend_from_slice(&((MAX_FRAME_SIZE + 1) as u32).to_be_bytes());
        poison.extend_from_slice(&0u32.to_be_bytes());
        let result = read_frame(&mut poison.as_slice());
        assert!(result.is_err(), "read_frame must reject oversized jsonLen");
    }

    /// A header with a non-zero binLen is consumed and discarded correctly.
    #[test]
    fn binary_sidecar_discarded() {
        let json = b"{}";
        let bin = b"BINARY";
        let mut frame = Vec::new();
        frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
        frame.extend_from_slice(&(bin.len() as u32).to_be_bytes());
        frame.extend_from_slice(json);
        frame.extend_from_slice(bin);
        let result = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!(result, json);
    }
}
