//! Framed-JSON codec — byte-exact port of `packages/protocol/src/codec.ts`.
//!
//! Wire format v2:
//! ```text
//!   u32_be jsonLen
//!   u32_be binLen   (0 for plain JSON frames)
//!   utf-8 JSON
//!   binLen bytes of raw binary payload (only when binLen > 0)
//! ```
//!
//! `HEADER_SIZE = 8`, `MAX_FRAME_SIZE = 64 MiB`. The binary-sidecar path lets
//! high-throughput streams (PTY io) avoid base64-encoding the payload.

use crate::error::{Result, TpError};

pub const HEADER_SIZE: usize = 8;
/// 64 MiB — matches codec.ts. Rejects poison headers (e.g. binLen=0xFFFFFFFF)
/// before any allocation.
pub const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

/// A decoded frame. `binary` is `None` for plain JSON frames; `Some` when the
/// sender attached a binary sidecar (binLen > 0).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedFrame {
    /// The JSON payload bytes (UTF-8), exactly as they appeared on the wire.
    pub json: Vec<u8>,
    pub binary: Option<Vec<u8>>,
}

/// Encode `json` (raw UTF-8 JSON bytes) plus optional `binary` sidecar into a
/// single framed buffer. Byte-identical to `encodeFrame(JSON.parse(json), binary)`
/// in codec.ts (the caller is responsible for producing the JSON exactly as the
/// TS `JSON.stringify` would — see `serialize_envelope`).
pub fn encode_frame(json: &[u8], binary: Option<&[u8]>) -> Vec<u8> {
    let bin_len = binary.map(|b| b.len()).unwrap_or(0);
    let mut frame = Vec::with_capacity(HEADER_SIZE + json.len() + bin_len);
    frame.extend_from_slice(&(json.len() as u32).to_be_bytes());
    frame.extend_from_slice(&(bin_len as u32).to_be_bytes());
    frame.extend_from_slice(json);
    if let Some(b) = binary {
        if bin_len > 0 {
            frame.extend_from_slice(b);
        }
    }
    frame
}

/// Incremental frame decoder mirroring `FrameDecoder` in codec.ts. Feed it
/// arbitrary byte chunks; it returns every complete frame contained in the
/// accumulated buffer and carries over any partial tail.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Consume `chunk`, returning every complete frame now available. Errors
    /// (oversized frame, malformed JSON length) are unrecoverable protocol
    /// violations — the buffer is advanced past the offending frame where
    /// possible, but the caller should tear down the connection.
    pub fn decode(&mut self, chunk: &[u8]) -> Result<Vec<DecodedFrame>> {
        self.buf.extend_from_slice(chunk);
        let mut results = Vec::new();

        let mut offset = 0usize;
        while self.buf.len() - offset >= HEADER_SIZE {
            let json_len = u32::from_be_bytes(
                self.buf[offset..offset + 4].try_into().unwrap(),
            ) as usize;
            let bin_len = u32::from_be_bytes(
                self.buf[offset + 4..offset + 8].try_into().unwrap(),
            ) as usize;

            // H1: reject oversized frames before attempting to buffer the body.
            if json_len + bin_len > MAX_FRAME_SIZE {
                return Err(TpError::Frame(format!(
                    "Frame too large: {} bytes exceeds max {}",
                    json_len + bin_len,
                    MAX_FRAME_SIZE
                )));
            }

            let total_len = HEADER_SIZE + json_len + bin_len;
            if self.buf.len() - offset < total_len {
                break;
            }

            let json_start = offset + HEADER_SIZE;
            let json = self.buf[json_start..json_start + json_len].to_vec();
            let binary = if bin_len > 0 {
                let bin_start = json_start + json_len;
                Some(self.buf[bin_start..bin_start + bin_len].to_vec())
            } else {
                None
            };

            offset += total_len;
            results.push(DecodedFrame { json, binary });
        }

        // Drop consumed bytes from the front, keep any partial tail.
        if offset > 0 {
            self.buf.drain(0..offset);
        }
        Ok(results)
    }

    pub fn reset(&mut self) {
        self.buf.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_json_only_header() {
        let json = br#"{"t":"x"}"#;
        let frame = encode_frame(json, None);
        assert_eq!(&frame[0..4], &(json.len() as u32).to_be_bytes());
        assert_eq!(&frame[4..8], &0u32.to_be_bytes());
        assert_eq!(&frame[8..], json);
    }

    #[test]
    fn round_trip_with_binary() {
        let json = br#"{"k":"io"}"#;
        let bin = [1u8, 2, 3, 4, 5];
        let frame = encode_frame(json, Some(&bin));
        let mut dec = FrameDecoder::new();
        let frames = dec.decode(&frame).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].json, json);
        assert_eq!(frames[0].binary.as_deref(), Some(&bin[..]));
    }

    #[test]
    fn split_chunks_reassemble() {
        let json = br#"{"hi":1}"#;
        let frame = encode_frame(json, None);
        let mut dec = FrameDecoder::new();
        assert!(dec.decode(&frame[0..3]).unwrap().is_empty());
        assert!(dec.decode(&frame[3..6]).unwrap().is_empty());
        let frames = dec.decode(&frame[6..]).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].json, json);
    }

    #[test]
    fn two_frames_in_one_chunk() {
        let mut buf = encode_frame(br#"{"a":1}"#, None);
        buf.extend_from_slice(&encode_frame(br#"{"b":2}"#, None));
        let mut dec = FrameDecoder::new();
        let frames = dec.decode(&buf).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].json, br#"{"a":1}"#);
        assert_eq!(frames[1].json, br#"{"b":2}"#);
    }

    #[test]
    fn rejects_oversized_frame() {
        // jsonLen = 0xFFFFFFFF poison header.
        let mut poison = vec![0xFFu8, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0];
        poison.extend_from_slice(b"x");
        let mut dec = FrameDecoder::new();
        assert!(matches!(dec.decode(&poison), Err(TpError::Frame(_))));
    }
}
