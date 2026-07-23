//! Multi-frame streaming IPC session for the long-lived `tp pair new` flow.
//!
//! The single-shot [`crate::ipc_client::request`] is a request→one-response
//! round-trip with a 30s read timeout. `pair new` is different: it sends one
//! `pair.begin`, then receives an arbitrary number of frames over an unbounded
//! window (`pair.begin.ok`, possibly later `pair.completed` / `pair.cancelled` /
//! `pair.error`) while ALSO needing to write a `pair.cancel` on Ctrl+C. That
//! demands a duplex, no-timeout session.
//!
//! Design (no tokio — the rest of the CLI is blocking std I/O):
//!
//! ```text
//!   UnixStream::connect(socket_path)
//!     ├─ reader fd = stream.try_clone()  → reader thread
//!     │     loop { read_frame_eof_aware → parse_ipc_message → mpsc::Sender }
//!     │           Ok(None)   → send Err(IpcError::Closed); break  (clean EOF)
//!     │           Err(e)     → send Err(IpcError::Io(e)); break   (mid-frame EOF or I/O)
//!     │           unknown discriminant → drop (mirrors Bun `if(!msg) continue`)
//!     └─ writer = Arc<Mutex<UnixStream>>  (main thread + Ctrl+C handler share)
//! ```
//!
//! The reader thread blocks indefinitely (no `set_read_timeout`) — exactly the
//! Bun event-loop socket model for a long-lived pairing. The main thread drains
//! `recv()`; the Ctrl+C handler grabs `writer_handle()` to frame a `pair.cancel`
//! (or, pre-begin, shuts the socket down so the daemon's `onDisconnect` cancels
//! the half-begun `PendingPairing`).

use std::io::Write as _;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::mpsc::{self, Receiver, RecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tp_proto::ipc::{parse_ipc_message, IpcMessage};

#[cfg(test)]
use crate::codec::read_frame;
use crate::codec::{encode_frame, read_frame_eof_aware};
use crate::ipc_client::IpcError;

/// A live duplex IPC session: a background reader thread feeds an mpsc channel
/// while the caller writes through a shared `Arc<Mutex<UnixStream>>`.
pub struct IpcSession {
    /// Write half (the same fd the reader cloned from). Shared with the Ctrl+C
    /// handler so a SIGINT can frame a `pair.cancel` or shut the socket down.
    writer: Arc<Mutex<UnixStream>>,
    /// Inbound frames decoded by the reader thread.
    rx: Receiver<Result<IpcMessage, IpcError>>,
    /// Reader thread handle, joined on `shutdown`.
    reader: Option<JoinHandle<()>>,
}

impl IpcSession {
    /// Connect to the daemon socket and spawn the reader thread.
    ///
    /// Errors with [`IpcError::Io`] if the connect or the `try_clone` fails.
    /// The daemon-up gate (so we surface the friendly "not running" message)
    /// is the caller's responsibility — `pair new` checks `is_daemon_running`
    /// first, consistent with `pair delete`/`rename`.
    pub fn connect(path: &std::path::Path) -> Result<Self, IpcError> {
        let stream = UnixStream::connect(path).map_err(IpcError::Io)?;
        let reader_stream = stream.try_clone().map_err(IpcError::Io)?;

        let (tx, rx) = mpsc::channel::<Result<IpcMessage, IpcError>>();

        let reader = std::thread::Builder::new()
            .name("tp-ipc-reader".to_string())
            .spawn(move || reader_loop(reader_stream, &tx))
            .map_err(IpcError::Io)?;

        Ok(Self {
            writer: Arc::new(Mutex::new(stream)),
            rx,
            reader: Some(reader),
        })
    }

    /// Serialize and write one framed IPC message to the daemon.
    pub fn send(&self, msg: &IpcMessage) -> Result<(), IpcError> {
        let json = serde_json::to_vec(msg)
            .map_err(|e| IpcError::Decode(format!("serialize request: {e}")))?;
        let frame = encode_frame(&json);
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| IpcError::Io(std::io::Error::other("writer mutex poisoned")))?;
        guard.write_all(&frame).map_err(IpcError::Io)?;
        guard.flush().map_err(IpcError::Io)?;
        Ok(())
    }

    /// Block until the next frame arrives. Returns:
    /// - `Ok(msg)` — a decoded `IpcMessage`,
    /// - `Err(IpcError::Closed)` — clean EOF (daemon closed the socket),
    /// - `Err(other)` — an I/O / decode failure from the reader, OR a clean
    ///   `Closed` synthesized when the channel's sender has dropped (reader
    ///   thread exited) without an explicit terminal message.
    pub fn recv(&self) -> Result<IpcMessage, IpcError> {
        match self.rx.recv() {
            Ok(result) => result,
            // Sender dropped (reader thread ended) with no pending item — treat
            // as a clean close so the caller's loop terminates deterministically.
            Err(RecvError) => Err(IpcError::Closed),
        }
    }

    /// A clone of the writer handle, for the Ctrl+C signal handler to grab so it
    /// can frame a `pair.cancel` or shut the socket down out-of-band.
    pub fn writer_handle(&self) -> Arc<Mutex<UnixStream>> {
        Arc::clone(&self.writer)
    }

    /// Shut the write half down (so the reader's `read_frame` returns EOF) and
    /// join the reader thread. Idempotent — safe to call once on the way out.
    pub fn shutdown(&mut self) {
        if let Ok(guard) = self.writer.lock() {
            // Shutdown::Both forces the blocked reader to observe EOF promptly.
            let _ = guard.shutdown(Shutdown::Both);
        }
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for IpcSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Reader thread body: loop reading frames and forwarding parsed messages.
///
/// Mirrors the retired Bun CLI's `onMessage` transport boundary: a frame that
/// parses to an unknown discriminant (`parse_ipc_message` → `None`) is dropped
/// silently (Bun's `if (!msg) continue`), never surfaced as an error.
///
/// Uses `read_frame_eof_aware` to distinguish a clean connection close (daemon
/// shut down gracefully at a frame boundary → `IpcError::Closed`) from a
/// truncated frame where the daemon crashed mid-transfer (`IpcError::Io` with
/// `UnexpectedEof`).  The old `read_frame` + `UnexpectedEof` guard could not
/// make this distinction.
fn reader_loop(mut reader: UnixStream, tx: &mpsc::Sender<Result<IpcMessage, IpcError>>) {
    loop {
        match read_frame_eof_aware(&mut reader) {
            Ok(None) => {
                // Clean EOF — daemon closed the socket at a frame boundary.
                let _ = tx.send(Err(IpcError::Closed));
                return;
            }
            Ok(Some(bytes)) => {
                let raw: serde_json::Value = match serde_json::from_slice(&bytes) {
                    Ok(v) => v,
                    Err(e) => {
                        // Malformed JSON on the IPC boundary: surface as a decode
                        // error and stop (the daemon should never send this).
                        let _ = tx.send(Err(IpcError::Decode(format!("parse JSON: {e}"))));
                        return;
                    }
                };
                if let Some(msg) = parse_ipc_message(&raw) {
                    if tx.send(Ok(msg)).is_err() {
                        // Receiver gone (session dropped) — nothing to do but exit.
                        return;
                    }
                }
                // Unknown discriminant → drop and keep reading (Bun parity).
            }
            Err(e) => {
                // Includes UnexpectedEof from a mid-frame truncation — not a
                // clean close, so map to IpcError::Io (not Closed).
                let _ = tx.send(Err(IpcError::Io(e)));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// End-to-end over a real socketpair-style listener: a stub "daemon" thread
    /// accepts, reads one framed request, replies with two frames, then closes.
    /// The session must receive both replies, then observe `Closed`.
    #[test]
    fn streams_multiple_frames_then_closes() {
        let dir = std::env::temp_dir().join(format!("tp-ipcsess-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("test.sock");
        let _ = std::fs::remove_file(&sock);

        let listener = UnixListener::bind(&sock).expect("bind");
        let sock_for_thread = sock.clone();

        let server = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            // Read the one framed request the client sends.
            let _req = read_frame(&mut conn).expect("read request");
            // Reply with two pair-shaped frames.
            let ok = serde_json::to_vec(&IpcMessage::PairBeginOk {
                pairing_id: "pid-1".into(),
                qr_string: "tp://p?d=AA".into(),
                daemon_id: "daemon-test".into(),
            })
            .unwrap();
            conn.write_all(&encode_frame(&ok)).unwrap();
            let done = serde_json::to_vec(&IpcMessage::PairCompleted {
                pairing_id: "pid-1".into(),
                daemon_id: "daemon-test".into(),
                label: tp_proto::label::make_label(Some("My Mac")),
            })
            .unwrap();
            conn.write_all(&encode_frame(&done)).unwrap();
            // Close.
            drop(conn);
            let _ = std::fs::remove_file(&sock_for_thread);
        });

        let mut session = IpcSession::connect(&sock).expect("connect");
        // Send a begin request (content irrelevant to the stub).
        session
            .send(&IpcMessage::PairBegin {
                relay_url: "ws://x".into(),
                daemon_id: None,
                label: None,
            })
            .expect("send");

        // First frame: pair.begin.ok.
        match session.recv() {
            Ok(IpcMessage::PairBeginOk { pairing_id, .. }) => assert_eq!(pairing_id, "pid-1"),
            other => panic!("expected PairBeginOk, got {other:?}"),
        }
        // Second frame: pair.completed.
        match session.recv() {
            Ok(IpcMessage::PairCompleted { daemon_id, .. }) => {
                assert_eq!(daemon_id, "daemon-test");
            }
            other => panic!("expected PairCompleted, got {other:?}"),
        }
        // Then a clean close.
        match session.recv() {
            Err(IpcError::Closed) => {}
            other => panic!("expected Closed, got {other:?}"),
        }

        session.shutdown();
        let _ = server.join();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
