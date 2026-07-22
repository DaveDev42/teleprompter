//! Vendored blocking IPC transport — framed-JSON codec + duplex session.
//!
//! Provenance: `rust/tp-cli/src/codec.rs` + `rust/tp-cli/src/ipc_session.rs`
//! (tp-cli is bin-only, so nothing is importable). Wire format v2:
//!
//! ```text
//!   [u32_be jsonLen][u32_be binLen=0][utf-8 JSON]
//! ```
//!
//! ONE deliberate delta vs the tp-cli session: malformed JSON on a frame is
//! dropped with a WARN instead of tearing the session down. The holder is a
//! long-lived harness peer that must survive anything short of a framing-level
//! error; unknown discriminants are dropped silently (Bun `if (!msg) continue`
//! parity), exactly like tp-cli.
//!
//! Split shape (vs tp-cli's single struct): the write half is a clonable
//! [`IpcWriter`] handed to the detached claude-driver and push threads, while
//! the reader thread feeds an `mpsc::Receiver` kept by main (pairing wait).
//! Reader termination (clean EOF or I/O error) drops the sender — main's
//! `recv()` erroring IS the "IPC closed" signal.

use std::io::{self, Cursor, Read, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tp_proto::ipc::{parse_ipc_message, IpcMessage};

use crate::out::log;

/// Maximum allowed frame payload — mirrors the TS/tp-cli 64 MiB ceiling so a
/// poison header is rejected before buffering.
pub const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

const HEADER_SIZE: usize = 8;

/// Encode pre-serialized UTF-8 JSON into a complete wire frame
/// (`[u32_be jsonLen][u32_be 0][json]`).
pub fn encode_frame(json: &[u8]) -> Vec<u8> {
    let json_len = json.len();
    let mut frame = Vec::with_capacity(HEADER_SIZE + json_len);
    // Payloads larger than u32::MAX are impossible under MAX_FRAME_SIZE.
    #[allow(clippy::cast_possible_truncation)]
    let json_len_u32 = json_len as u32;
    frame.extend_from_slice(&json_len_u32.to_be_bytes());
    frame.extend_from_slice(&0u32.to_be_bytes());
    frame.extend_from_slice(json);
    frame
}

/// Read one complete frame; returns the JSON bytes. Any binary sidecar is
/// consumed and discarded (the holder never uses one).
fn read_frame<R: Read>(reader: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0u8; HEADER_SIZE];
    reader.read_exact(&mut header)?;

    let json_len = u32::from_be_bytes(header[0..4].try_into().expect("4-byte slice")) as usize;
    let bin_len = u32::from_be_bytes(header[4..8].try_into().expect("4-byte slice")) as usize;

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

    if bin_len > 0 {
        let mut discard = vec![0u8; bin_len];
        reader.read_exact(&mut discard)?;
    }

    Ok(json)
}

/// Read one frame, distinguishing a clean close (`Ok(None)` — zero bytes at a
/// frame boundary) from a truncated frame (`Err(UnexpectedEof)`).
fn read_frame_eof_aware<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut first = [0u8; 1];
    if reader.read(&mut first)? == 0 {
        return Ok(None); // clean EOF — normal daemon-shutdown path
    }
    let mut chained = Cursor::new(first).chain(reader);
    read_frame(&mut chained).map(Some)
}

/// Clonable write half — serialize + frame + write under a shared lock.
#[derive(Clone)]
pub struct IpcWriter {
    inner: Arc<Mutex<UnixStream>>,
}

impl IpcWriter {
    /// Send a typed `IpcMessage` (pairing, input frames).
    pub fn send(&self, msg: &IpcMessage) -> Result<(), String> {
        let json = serde_json::to_vec(msg).map_err(|e| format!("serialize: {e}"))?;
        self.write_frame(&json)
    }

    /// Send a raw JSON value (the synthetic Notification `rec` — hand-built so
    /// `ts` serializes as an integer, not the typed variant's f64 `.0`).
    pub fn send_value(&self, value: &Value) -> Result<(), String> {
        let json = serde_json::to_vec(value).map_err(|e| format!("serialize: {e}"))?;
        self.write_frame(&json)
    }

    fn write_frame(&self, json: &[u8]) -> Result<(), String> {
        let frame = encode_frame(json);
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "writer mutex poisoned".to_string())?;
        guard.write_all(&frame).map_err(|e| format!("write: {e}"))?;
        guard.flush().map_err(|e| format!("flush: {e}"))?;
        Ok(())
    }
}

/// Connect to the daemon socket and spawn the detached reader thread.
pub fn connect(path: &Path) -> io::Result<(IpcWriter, Receiver<IpcMessage>)> {
    let stream = UnixStream::connect(path)?;
    let reader_stream = stream.try_clone()?;

    let (tx, rx) = mpsc::channel::<IpcMessage>();
    std::thread::Builder::new()
        .name("tp-e2e-ipc-reader".to_string())
        .spawn(move || reader_loop(reader_stream, &tx))?;

    Ok((
        IpcWriter {
            inner: Arc::new(Mutex::new(stream)),
        },
        rx,
    ))
}

/// Reader thread: frames → parsed messages → channel. Terminates (dropping the
/// sender) on clean EOF or any framing-level I/O error; per-frame JSON garbage
/// is WARNed and skipped (see module docs).
fn reader_loop(mut reader: UnixStream, tx: &Sender<IpcMessage>) {
    loop {
        match read_frame_eof_aware(&mut reader) {
            Ok(None) => {
                log("IPC reader: daemon closed the socket");
                return;
            }
            Ok(Some(bytes)) => {
                let raw: Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(err) => {
                        log(&format!("WARN — dropping malformed IPC JSON frame: {err}"));
                        continue;
                    }
                };
                if let Some(msg) = parse_ipc_message(&raw) {
                    if tx.send(msg).is_err() {
                        return; // receiver gone (main exited its wait)
                    }
                }
                // Unknown discriminant → drop and keep reading (Bun parity).
            }
            Err(err) => {
                log(&format!("IPC reader: read error: {err}"));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn header_layout_is_exact() {
        let frame = encode_frame(b"{}");
        assert_eq!(&frame[0..4], &[0, 0, 0, 2], "jsonLen bytes");
        assert_eq!(&frame[4..8], &[0, 0, 0, 0], "binLen bytes");
        assert_eq!(&frame[8..], b"{}", "JSON payload");
    }

    #[test]
    fn encode_decode_round_trip() {
        let payload = br#"{"t":"pair.begin","relayUrl":"ws://localhost:1"}"#;
        let frame = encode_frame(payload);
        let decoded = read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!(decoded, payload);
    }

    /// End-to-end over a real Unix socket: a stub "daemon" accepts, receives
    /// our `pair.begin`, replies `pair.begin.ok` + one malformed frame + one
    /// unknown-discriminant frame + `pair.completed`, then closes. The session
    /// must surface exactly the two known messages (garbage tolerated), then
    /// signal closure by dropping the channel.
    #[test]
    fn session_tolerates_garbage_frames() {
        let dir = std::env::temp_dir().join(format!("tp-e2e-holder-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("ipc-test.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();

        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let inbound = read_frame_eof_aware(&mut conn).unwrap().unwrap();
            let v: Value = serde_json::from_slice(&inbound).unwrap();
            assert_eq!(v["t"], "pair.begin");

            let ok = br#"{"t":"pair.begin.ok","pairingId":"p1","qrString":"tp://p?d=x","daemonId":"daemon-test"}"#;
            conn.write_all(&encode_frame(ok)).unwrap();
            conn.write_all(&encode_frame(b"this is not json")).unwrap();
            conn.write_all(&encode_frame(br#"{"t":"totally.unknown"}"#))
                .unwrap();
            let done =
                br#"{"t":"pair.completed","pairingId":"p1","daemonId":"daemon-test","label":{"set":false}}"#;
            conn.write_all(&encode_frame(done)).unwrap();
            // Drop conn → clean EOF for the reader.
        });

        let (writer, rx) = connect(&sock).unwrap();
        writer
            .send(&IpcMessage::PairBegin {
                relay_url: "ws://localhost:1".to_string(),
                daemon_id: None,
                label: None,
            })
            .unwrap();

        match rx.recv().unwrap() {
            IpcMessage::PairBeginOk {
                pairing_id,
                daemon_id,
                ..
            } => {
                assert_eq!(pairing_id, "p1");
                assert_eq!(daemon_id, "daemon-test");
            }
            other => panic!("expected pair.begin.ok, got {other:?}"),
        }
        match rx.recv().unwrap() {
            IpcMessage::PairCompleted { daemon_id, .. } => assert_eq!(daemon_id, "daemon-test"),
            other => panic!("expected pair.completed, got {other:?}"),
        }
        // Reader exits on the stub's close → sender drops → recv errors.
        assert!(rx.recv().is_err(), "channel should close after clean EOF");

        server.join().unwrap();
        let _ = std::fs::remove_file(&sock);
    }
}
