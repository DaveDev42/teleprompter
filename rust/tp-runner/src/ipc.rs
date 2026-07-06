//! Async IPC client — tokio port of `packages/runner/src/ipc/client.ts`.
//!
//! Connects to the daemon's Unix socket, sends framed-JSON frames the runner
//! produces (`hello`/`rec`/`bye`), and delivers the inbound frames the daemon
//! sends back (`ack`/`input`/`resize`) to the owning [`crate::runner::Runner`]'s
//! select loop.
//!
//! # Invariants preserved from the Bun client
//!
//! - **decode-throw teardown**: a protocol-fatal frame (oversized length /
//!   malformed JSON) must tear the connection down, not wedge it. In Rust the
//!   decoder returns `Err` rather than panicking, but the *behaviour* is the
//!   same: on a decode error the reader resets the decoder and closes, which
//!   fires the close signal so the Runner tears down cleanly instead of silently
//!   dropping every subsequent io/hook frame.
//! - **inbound allowlist**: only `ack`/`input`/`resize` are forwarded. Anything
//!   else on this socket (a stray command reply, a malformed frame) is dropped —
//!   acting on an under-validated struct is how a bad write reaches the PTY.
//! - **overflow → close**: if the outbound channel is full (the writer task
//!   cannot keep up), the send fails and the client closes, surfacing the
//!   failure to the Runner rather than silently dropping records forever.

use std::sync::Arc;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Notify};
use tp_proto::ipc::IpcMessage;

use tp_core::codec::FrameDecoder;

/// The inbound messages the daemon sends a runner. Anything else is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// `{t:"ack", sid, seq}` — informational, no action.
    Ack { seq: u64 },
    /// `{t:"input", sid, data}` — base64 keystrokes to write to the PTY.
    Input { data: String },
    /// `{t:"resize", sid, cols, rows}` — PTY window resize.
    Resize { cols: u64, rows: u64 },
}

impl Inbound {
    /// Map a parsed `IpcMessage` to the inbound allowlist. `None` for any
    /// non-inbound variant (the runner has no handler for it).
    fn from_ipc(msg: IpcMessage) -> Option<Self> {
        match msg {
            IpcMessage::Ack { seq, .. } => Some(Inbound::Ack { seq }),
            IpcMessage::Input { data, .. } => Some(Inbound::Input { data }),
            IpcMessage::Resize { cols, rows, .. } => Some(Inbound::Resize { cols, rows }),
            _ => None,
        }
    }
}

/// Bounded outbound queue depth. When full, `send` reports failure and the
/// client closes (the Bun `QueuedWriter.isOverflowed` → `close()` analogue). A
/// generous depth absorbs bursty PTY output without unbounded memory growth.
const OUTBOUND_CAPACITY: usize = 4096;

/// A cheap, cloneable handle for sending frames to the daemon. Cloned into the
/// Runner's tasks (PTY reader → io records, hook receiver → event records).
#[derive(Clone)]
pub struct IpcHandle {
    tx: mpsc::Sender<Vec<u8>>,
    /// Fired when the connection tears down (writer error, reader EOF, decode
    /// error, or explicit close) so the Runner's select loop wakes.
    closed: Arc<Notify>,
}

impl IpcHandle {
    /// Encode `json` (+ optional binary sidecar) into a frame and enqueue it.
    /// Returns `false` if the outbound queue is full or the writer has gone —
    /// the caller (Runner) treats that as a teardown trigger, mirroring the Bun
    /// overflow → close path. Non-blocking (`try_send`) so a slow/dead daemon
    /// never stalls the PTY reader thread.
    #[must_use]
    pub fn send(&self, json: &[u8], binary: Option<&[u8]>) -> bool {
        let frame = tp_core::encode_frame(json.to_vec(), binary.map(<[u8]>::to_vec));
        match self.tx.try_send(frame) {
            Ok(()) => true,
            Err(_) => {
                // Full or closed — surface the failure by waking the owner.
                self.closed.notify_waiters();
                false
            }
        }
    }

    /// Wait until the connection has torn down.
    pub async fn closed(&self) {
        self.closed.notified().await;
    }

    /// Explicitly close the connection (Runner teardown). Idempotent.
    pub fn close(&self) {
        self.closed.notify_waiters();
    }
}

/// The connected IPC client: an [`IpcHandle`] for sending plus the receiver of
/// inbound daemon messages. The read/write halves run on spawned tasks.
pub struct IpcClient {
    pub handle: IpcHandle,
    pub inbound: mpsc::Receiver<Inbound>,
}

impl IpcClient {
    /// Connect to the daemon at `path`, spawning the reader + writer tasks.
    pub async fn connect(path: &std::path::Path) -> std::io::Result<Self> {
        let stream = UnixStream::connect(path).await?;
        let (mut read_half, mut write_half) = stream.into_split();

        let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_CAPACITY);
        let (in_tx, in_rx) = mpsc::channel::<Inbound>(OUTBOUND_CAPACITY);
        let closed = Arc::new(Notify::new());

        // Writer task: drain the outbound channel to the socket. Any write error
        // (daemon gone) tears down.
        let closed_w = closed.clone();
        tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if write_half.write_all(&frame).await.is_err() {
                    break;
                }
            }
            let _ = write_half.shutdown().await;
            closed_w.notify_waiters();
        });

        // Reader task: decode frames, forward the inbound allowlist. Decode error
        // or EOF tears down (the decode-throw teardown invariant).
        let closed_r = closed.clone();
        tokio::spawn(async move {
            let mut decoder = FrameDecoder::new();
            let mut buf = [0u8; 8192];
            loop {
                let n = match read_half.read(&mut buf).await {
                    Ok(0) => break, // EOF — daemon closed
                    Ok(n) => n,
                    Err(_) => break,
                };
                let frames = match decoder.decode(&buf[..n]) {
                    Ok(frames) => frames,
                    Err(_) => {
                        // Protocol-fatal frame — reset + tear down rather than
                        // wedge the stream (Bun decode-throw teardown parity).
                        decoder.reset();
                        break;
                    }
                };
                for frame in frames {
                    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.json) else {
                        continue; // malformed JSON in a well-framed frame — drop
                    };
                    let Some(msg) = tp_proto::ipc::parse_ipc_message(&value) else {
                        continue; // not a recognised IPC message — drop
                    };
                    let Some(inbound) = Inbound::from_ipc(msg) else {
                        continue; // recognised but not runner-inbound — drop
                    };
                    // If the Runner stopped consuming, tear down.
                    if in_tx.send(inbound).await.is_err() {
                        break;
                    }
                }
            }
            closed_r.notify_waiters();
        });

        Ok(IpcClient {
            handle: IpcHandle { tx: out_tx, closed },
            inbound: in_rx,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt as _;
    use tokio::net::UnixListener;

    /// A hello frame the runner sends round-trips to a listening daemon stub,
    /// and an inbound `input` frame the stub sends is delivered as `Inbound`.
    #[tokio::test]
    async fn send_and_receive_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        // Daemon stub: accept, read the runner's hello frame, then send an input
        // frame back.
        let sock2 = sock.clone();
        let server = tokio::spawn(async move {
            let _ = sock2;
            let (mut conn, _) = listener.accept().await.unwrap();
            // Read the first frame's 8-byte header, then its json.
            let mut header = [0u8; 8];
            conn.read_exact(&mut header).await.unwrap();
            let json_len = u32::from_be_bytes(header[0..4].try_into().unwrap()) as usize;
            let bin_len = u32::from_be_bytes(header[4..8].try_into().unwrap()) as usize;
            let mut json = vec![0u8; json_len];
            conn.read_exact(&mut json).await.unwrap();
            let mut bin = vec![0u8; bin_len];
            conn.read_exact(&mut bin).await.unwrap();
            let hello: serde_json::Value = serde_json::from_slice(&json).unwrap();

            // Reply with an input frame.
            let input = serde_json::json!({"t":"input","sid":"s","data":"aGk="});
            let ij = serde_json::to_vec(&input).unwrap();
            let frame = tp_core::encode_frame(ij, None);
            conn.write_all(&frame).await.unwrap();
            // Keep the connection open a moment so the client reads the reply.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            hello
        });

        let mut client = IpcClient::connect(&sock).await.unwrap();

        // Send a hello.
        let hello = crate::wire::Hello::new("s".into(), "/cwd".into(), None, 7);
        let hj = serde_json::to_vec(&hello).unwrap();
        assert!(client.handle.send(&hj, None));

        // Receive the input frame.
        let got = tokio::time::timeout(std::time::Duration::from_secs(2), client.inbound.recv())
            .await
            .expect("inbound within timeout")
            .expect("an inbound message");
        assert_eq!(
            got,
            Inbound::Input {
                data: "aGk=".into()
            }
        );

        let hello_seen = server.await.unwrap();
        assert_eq!(hello_seen["t"], "hello");
        assert_eq!(hello_seen["sid"], "s");
        assert_eq!(hello_seen["pid"], 7);
    }

    #[tokio::test]
    async fn closed_fires_on_daemon_disconnect() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        let server = tokio::spawn(async move {
            let (_conn, _) = listener.accept().await.unwrap();
            // Drop immediately → EOF on the client's reader.
        });

        let client = IpcClient::connect(&sock).await.unwrap();
        server.await.unwrap();

        // The reader hits EOF and fires closed.
        tokio::time::timeout(std::time::Duration::from_secs(2), client.handle.closed())
            .await
            .expect("closed should fire on disconnect");
    }
}
