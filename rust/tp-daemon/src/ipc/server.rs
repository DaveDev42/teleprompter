//! Daemon IPC listener — tokio port of `packages/daemon/src/ipc/server.ts`
//! (258 LOC). A Unix-domain socket server that accepts Runner connections,
//! decodes framed-JSON, and dispatches messages to an owner via callbacks.
//! **Async — tokio.**
//!
//! # Invariants preserved from the Bun server (verify each against
//! `server.ts`)
//!
//! - **Framed-JSON decode with teardown** (server.ts:90-103): on a decode
//!   error, log + close that one socket, never wedge. `tp_core::FrameDecoder`
//!   returns `Err` instead of throwing — same behavior, reused (not
//!   reimplemented) here.
//! - **hello-SID tracking** (server.ts:110-113): when `msg.t == "hello"`,
//!   record `runner.sid = msg.sid`.
//! - **onMessage throw-containment** (server.ts:114-132): a handler error
//!   must close only THAT socket, not crash the whole daemon. In Rust the
//!   dispatch callback returns nothing (infallible by construction — Rust
//!   has no unguarded-throw hazard the way a Bun socket `data` callback
//!   does), but a panic inside it is still caught with
//!   `std::panic::catch_unwind` so the *intent* (one runner's transient
//!   error never tears down the mux) is preserved even for a caller-supplied
//!   closure that panics.
//! - **30s socket-dirent self-heal timer** (server.ts:19,167-212,
//!   `SOCKET_HEAL_INTERVAL_MS`): the in-kernel listening socket survives a
//!   dirent unlink, but the PATH becomes unreachable by `connect()` (macOS
//!   AF_UNIX = VFS, no abstract namespace). Every ~30s, lstat the bound
//!   path; if it's missing or not a socket, re-bind a fresh listener at the
//!   same path (already-accepted connections are unaffected). This is
//!   split-brain prevention (a stale "not running" spawns a duplicate
//!   daemon). Ported via `tokio::time::interval` + `tokio::fs::symlink_metadata`,
//!   running as a task that exits on `stop()` (the TS `.unref()` analogue —
//!   the task is aborted, not merely unref'd, since tokio has no unref
//!   primitive; `IpcServer::stop` aborts it explicitly so it can't outlive
//!   the server).
//! - **QueuedWriter backpressure** (server.ts:135-138,214-224): the TS side
//!   queues writes and drains on the socket `drain` event. Here each
//!   connection owns an `mpsc` channel to a dedicated writer task (mirrors
//!   `tp-runner/src/ipc.rs`'s writer-task pattern) — `send()` is `try_send`
//!   (non-blocking); a full/closed channel surfaces as `false` rather than
//!   silently dropping (overflow surfaces, same semantics as the TS
//!   `QueuedWriter.isOverflowed → close()` path).
//! - **error-without-close cleanup**: a connection task ending (for ANY
//!   reason — EOF, decode error, or writer failure) covers both the Bun
//!   `close`/`error` paths, since Rust's per-connection task naturally
//!   terminates once. `onDisconnect` fires exactly once per connection (the
//!   TS `Set.delete()` return guards double-fire; here the task loop itself
//!   only reaches its single teardown point once).
//! - **`findRunnerBySid`/`send`/`stop`**: port the public surface
//!   (server.ts:214-243).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use tp_core::codec::FrameDecoder;
use tp_proto::ipc::{parse_ipc_message, IpcMessage};

/// How often the daemon re-checks that its IPC socket dirent still exists at
/// the bound path. Mirrors `SOCKET_HEAL_INTERVAL_MS` (server.ts:19).
const SOCKET_HEAL_INTERVAL_MS: u64 = 30_000;

/// Bounded outbound queue depth per connection. Mirrors the `IpcHandle`
/// `OUTBOUND_CAPACITY` pattern in `tp-runner/src/ipc.rs` — generous enough to
/// absorb bursty output without unbounded memory growth; a full queue means
/// the writer task cannot keep up and `send()` reports failure.
const OUTBOUND_CAPACITY: usize = 4096;

/// Process-wide connection identity counter, used only to give each
/// connection a distinct handle for `Arc::ptr_eq`-free equality in tests /
/// `HashSet`-style membership. `ConnectedRunner` itself does not implement
/// `Hash`/`Eq` by content (its `sid` mutates), so the registry keys on this id.
static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

/// Mirrors `ConnectedRunner` (server.ts:21-26). `sid` is populated once a
/// `hello` frame arrives; before that it's `None`.
pub struct ConnectedRunner {
    id: u64,
    outbound: mpsc::Sender<Vec<u8>>,
    sid: Mutex<Option<String>>,
}

impl ConnectedRunner {
    pub fn sid(&self) -> Option<String> {
        self.sid.lock().unwrap().clone()
    }

    /// A stable per-connection identity, distinct from `sid` (which is
    /// absent until the `hello` frame arrives, and — unlike a connection
    /// identity — is attacker-influenced wire input). Useful for a caller
    /// that needs to recognize "the same connection" across calls without
    /// waiting for `hello`.
    pub fn id(&self) -> u64 {
        self.id
    }
}

/// Callback fired for each decoded inbound frame. Mirrors `onMessage`
/// (`IpcServerEvents.onMessage`, server.ts:29-33).
pub type OnMessageFn =
    Arc<dyn Fn(&Arc<ConnectedRunner>, IpcMessage, Option<Vec<u8>>) + Send + Sync>;
/// Callback fired once per newly-accepted connection. Mirrors `onConnect`
/// (server.ts:34).
pub type OnConnectFn = Arc<dyn Fn(&Arc<ConnectedRunner>) + Send + Sync>;
/// Callback fired exactly once per connection teardown. Mirrors
/// `onDisconnect` (server.ts:35).
pub type OnDisconnectFn = Arc<dyn Fn(&Arc<ConnectedRunner>) + Send + Sync>;
/// The connection registry keyed by [`ConnectedRunner::id`].
type RunnerRegistry = Arc<Mutex<HashMap<u64, Arc<ConnectedRunner>>>>;

/// The owner-supplied callbacks. Mirrors `IpcServerEvents` (server.ts:28-36).
/// Each callback is `Fn` (not `FnMut`) so it can be shared across concurrently
/// running connection tasks via `Arc`.
pub struct IpcServerEvents {
    pub on_message: OnMessageFn,
    pub on_connect: OnConnectFn,
    pub on_disconnect: OnDisconnectFn,
}

/// The IPC server. Mirrors the `IpcServer` class (server.ts:40-258).
pub struct IpcServer {
    events: IpcServerEvents,
    runners: RunnerRegistry,
    bound_path: Arc<Mutex<Option<PathBuf>>>,
    accept_task: Option<tokio::task::JoinHandle<()>>,
    heal_task: Option<tokio::task::JoinHandle<()>>,
    stopped: Arc<std::sync::atomic::AtomicBool>,
}

impl IpcServer {
    pub fn new(events: IpcServerEvents) -> Self {
        IpcServer {
            events,
            runners: Arc::new(Mutex::new(HashMap::new())),
            bound_path: Arc::new(Mutex::new(None)),
            accept_task: None,
            heal_task: None,
            stopped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// Byte-exact port of `start()` (server.ts:52-59): bind at `socket_path`
    /// (or the daemon's default `tp_proto::socket_path()` if not given),
    /// start the heal timer, and return the bound path.
    ///
    /// # Errors
    /// Any bind failure (mirrors the TS `Bun.listen` throwing synchronously).
    pub fn start(&mut self, socket_path: Option<PathBuf>) -> std::io::Result<PathBuf> {
        let path = match socket_path {
            Some(p) => p,
            None => tp_proto::socket_path()?,
        };
        self.stopped.store(false, Ordering::SeqCst);
        self.listen(&path)?;
        *self.bound_path.lock().unwrap() = Some(path.clone());
        self.start_heal_timer();
        Ok(path)
    }

    /// Bind (or re-bind) the Unix listening socket at `path`. Extracted from
    /// `start()` so the heal timer can recreate the dirent after it is
    /// unlinked out from under a live daemon (restart races, a stray daemon
    /// start that pre-unlinks then early-exits on the lock, OS tmp churn).
    /// Re-binding creates a fresh listening socket + dirent;
    /// already-accepted runner connections live in the OS independent of the
    /// listener and are unaffected. Mirrors `listen()` (server.ts:69-165).
    fn listen(&mut self, path: &Path) -> std::io::Result<()> {
        // Clean up a stale socket file (ENOENT is fine — nothing to clean).
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }

        let listener = UnixListener::bind(path)?;

        // Abort any previous accept task before installing the new one — a
        // heal re-bind must not leave two accept loops racing on different
        // listeners (the old listener is already gone/replaced by this point
        // via the caller's `server.stop()` equivalent, but guard anyway).
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }

        let runners = Arc::clone(&self.runners);
        let events_on_connect = Arc::clone(&self.events.on_connect);
        let events_on_message = Arc::clone(&self.events.on_message);
        let events_on_disconnect = Arc::clone(&self.events.on_disconnect);

        self.accept_task = Some(tokio::spawn(accept_loop(
            listener,
            runners,
            events_on_connect,
            events_on_message,
            events_on_disconnect,
        )));

        Ok(())
    }

    /// Returns true if the dirent at `path` exists and is a Unix socket.
    /// Mirrors `socketDirentHealthy` (server.ts:172-179). A missing dirent
    /// (ENOENT) or a path replaced by a regular file/dir both mean the bound
    /// path can no longer accept `connect()` and must be re-bound.
    async fn socket_dirent_healthy(path: &Path) -> bool {
        match tokio::fs::symlink_metadata(path).await {
            Ok(meta) => {
                use std::os::unix::fs::FileTypeExt as _;
                meta.file_type().is_socket()
            }
            Err(_) => false,
        }
    }

    /// Periodically re-assert that the bound socket dirent still exists.
    /// Mirrors `startHealTimer` (server.ts:189-212). The task exits on
    /// `stop()` (checked each tick via `stopped`), the tokio analogue of the
    /// TS timer's `.unref()` — a stopped server's heal task does not keep
    /// the process alive or fire after teardown.
    fn start_heal_timer(&mut self) {
        if self.heal_task.is_some() {
            return;
        }
        let bound_path = Arc::clone(&self.bound_path);
        let stopped = Arc::clone(&self.stopped);
        // We cannot re-bind from inside this task without `&mut self`, so
        // the heal task signals via a re-bind channel back to a driver that
        // owns `&mut self`. To keep this self-contained (no extra plumbing
        // exposed to callers), the heal task performs the re-bind itself
        // using a raw std::fs remove + tokio UnixListener::bind + spawning a
        // fresh accept loop, mirroring `listen()`'s body directly rather than
        // calling back into `&mut self`.
        let runners = Arc::clone(&self.runners);
        let events_on_connect = Arc::clone(&self.events.on_connect);
        let events_on_message = Arc::clone(&self.events.on_message);
        let events_on_disconnect = Arc::clone(&self.events.on_disconnect);
        let accept_task_slot: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>> =
            Arc::new(Mutex::new(None));

        self.heal_task = Some(tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_millis(SOCKET_HEAL_INTERVAL_MS));
            // The first tick fires immediately; skip it so we don't
            // re-check right after bind (mirrors setInterval's first fire
            // being at the full interval, not immediately).
            interval.tick().await;
            loop {
                interval.tick().await;
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                let Some(path) = bound_path.lock().unwrap().clone() else {
                    continue;
                };
                if IpcServer::socket_dirent_healthy(&path).await {
                    continue;
                }
                if let Err(e) = rebind(
                    &path,
                    &runners,
                    &events_on_connect,
                    &events_on_message,
                    &events_on_disconnect,
                    &accept_task_slot,
                ) {
                    // Timer callback is fully guarded: a throw escaping a
                    // timer callback would be a far worse outcome than a
                    // missed heal (server.ts:186-187 rationale). Just log
                    // (stderr — this crate has no injected logger yet) and
                    // continue the loop.
                    eprintln!("[IpcServer] IPC socket heal failed: {e}");
                }
            }
        }));
    }

    /// Encode + enqueue a frame to `runner`. Byte-exact port of `send()`
    /// (server.ts:214-224). Returns `false` if the outbound queue is full or
    /// the connection has already torn down (mirrors the overflow → surfaced
    /// failure semantics of `QueuedWriter`).
    #[must_use]
    pub fn send(runner: &ConnectedRunner, json: &[u8], binary: Option<&[u8]>) -> bool {
        let frame = tp_core::codec::encode_frame(json, binary);
        runner.outbound.try_send(frame).is_ok()
    }

    /// Byte-exact port of `findRunnerBySid()` (server.ts:226-231).
    pub fn find_runner_by_sid(&self, sid: &str) -> Option<Arc<ConnectedRunner>> {
        let runners = self.runners.lock().unwrap();
        runners
            .values()
            .find(|r| r.sid().as_deref() == Some(sid))
            .cloned()
    }

    /// Snapshot of all currently connected runners (used by tests + callers
    /// that need to enumerate connections; the TS class exposes this only
    /// via the private `runners` Set, but Rust callers need an explicit
    /// accessor since there's no shared mutable class field to reach into).
    pub fn connected_runners(&self) -> Vec<Arc<ConnectedRunner>> {
        self.runners.lock().unwrap().values().cloned().collect()
    }

    /// Byte-exact port of `stop()` (server.ts:233-243).
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(task) = self.heal_task.take() {
            task.abort();
        }
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
        *self.bound_path.lock().unwrap() = None;
        self.runners.lock().unwrap().clear();
    }

    /// Test-only: force a heal check synchronously (the heal timer's body),
    /// letting a regression test drive the unlink→rebind path without
    /// waiting for the 30s interval. Returns true if a re-bind occurred.
    /// Mirrors `__healNow()` (server.ts:250-257).
    #[cfg(test)]
    pub async fn heal_now(&mut self) -> bool {
        if self.stopped.load(Ordering::SeqCst) {
            return false;
        }
        let Some(path) = self.bound_path.lock().unwrap().clone() else {
            return false;
        };
        if Self::socket_dirent_healthy(&path).await {
            return false;
        }
        self.listen(&path).expect("re-bind must succeed in test");
        true
    }

    #[cfg(test)]
    pub fn bound_path(&self) -> Option<PathBuf> {
        self.bound_path.lock().unwrap().clone()
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Re-bind at `path`, replacing the accept task in `accept_task_slot`. Used
/// only by the heal timer (which cannot borrow `&mut IpcServer` from inside
/// its own spawned task), so this free function duplicates `listen()`'s body
/// rather than calling back into the server. Kept in lockstep with `listen()`
/// — any behavior change there must be mirrored here.
#[allow(clippy::too_many_arguments)]
fn rebind(
    path: &Path,
    runners: &RunnerRegistry,
    on_connect: &OnConnectFn,
    on_message: &OnMessageFn,
    on_disconnect: &OnDisconnectFn,
    accept_task_slot: &Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let listener = UnixListener::bind(path)?;

    if let Some(task) = accept_task_slot.lock().unwrap().take() {
        task.abort();
    }

    let runners = Arc::clone(runners);
    let on_connect = Arc::clone(on_connect);
    let on_message = Arc::clone(on_message);
    let on_disconnect = Arc::clone(on_disconnect);
    let new_task = tokio::spawn(accept_loop(
        listener,
        runners,
        on_connect,
        on_message,
        on_disconnect,
    ));
    *accept_task_slot.lock().unwrap() = Some(new_task);
    Ok(())
}

/// Accept connections forever; each is handled on its own task. Mirrors the
/// `Bun.listen` `socket.open`/`data`/`drain`/`close`/`error` handlers
/// (server.ts:80-160) collapsed into one connection task per accept — a
/// natural single teardown point covers both the Bun `close` and `error`
/// paths (`onDisconnect` fires exactly once either way).
async fn accept_loop(
    listener: UnixListener,
    runners: RunnerRegistry,
    on_connect: OnConnectFn,
    on_message: OnMessageFn,
    on_disconnect: OnDisconnectFn,
) {
    loop {
        let Ok((conn, _)) = listener.accept().await else {
            break;
        };
        let runners = Arc::clone(&runners);
        let on_connect = Arc::clone(&on_connect);
        let on_message = Arc::clone(&on_message);
        let on_disconnect = Arc::clone(&on_disconnect);
        tokio::spawn(handle_conn(
            conn,
            runners,
            on_connect,
            on_message,
            on_disconnect,
        ));
    }
}

/// Handle one accepted connection end-to-end: register, read/decode/dispatch
/// frames until EOF/decode-error/dispatch-panic, then unregister exactly
/// once. Mirrors the per-socket lifecycle in server.ts (`open` → `data`* →
/// `close`|`error`).
async fn handle_conn(
    conn: UnixStream,
    runners: RunnerRegistry,
    on_connect: OnConnectFn,
    on_message: OnMessageFn,
    on_disconnect: OnDisconnectFn,
) {
    let (mut read_half, mut write_half) = conn.into_split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(OUTBOUND_CAPACITY);

    let id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    let runner = Arc::new(ConnectedRunner {
        id,
        outbound: outbound_tx,
        sid: Mutex::new(None),
    });

    runners.lock().unwrap().insert(id, Arc::clone(&runner));
    on_connect(&runner);

    // Writer task: drain the outbound channel to the socket half. A write
    // error (peer gone) ends the writer; the reader loop below independently
    // detects EOF/errors on its own half, so either side tearing down
    // eventually collapses the connection — no separate "drain" event is
    // needed the way Bun's backpressure callback requires, since
    // `write_all` on a tokio socket already waits for the OS to accept the
    // bytes (equivalent effect to queue+drain).
    let writer_task = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            if write_half.write_all(&frame).await.is_err() {
                break;
            }
        }
        let _ = write_half.shutdown().await;
    });

    let mut decoder = FrameDecoder::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = match read_half.read(&mut buf).await {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };
        let frames = match decoder.decode(&buf[..n]) {
            Ok(frames) => frames,
            Err(e) => {
                // Framed-JSON decode with teardown (server.ts:90-103): log +
                // close THIS socket only, never wedge.
                eprintln!("[IpcServer] frame decode error — closing socket: {e}");
                break;
            }
        };
        for frame in frames {
            let Ok(value) = serde_json::from_slice::<Value>(&frame.json) else {
                // Malformed JSON inside an otherwise well-framed frame — drop
                // (mirrors `parseIpcMessage` returning null → "dropped
                // malformed IPC message" warn-and-continue, server.ts:106-108).
                continue;
            };
            let Some(msg) = parse_ipc_message(&value) else {
                continue;
            };
            // Track SID from hello message (server.ts:110-113).
            if let IpcMessage::Hello { ref sid, .. } = msg {
                *runner.sid.lock().unwrap() = Some(sid.clone());
            }
            // onMessage throw-containment (server.ts:114-132): a panicking
            // handler must close only this socket, not crash the whole
            // daemon/process. catch_unwind requires UnwindSafe; the closure
            // types here are `Fn` over `Send + Sync` data, which satisfies it
            // in practice for the callbacks this server is built with.
            let binary = frame.binary.clone();
            let panic_runner = Arc::clone(&runner);
            let on_message_ref = Arc::clone(&on_message);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                on_message_ref(&panic_runner, msg, binary);
            }));
            if result.is_err() {
                eprintln!(
                    "[IpcServer] onMessage handler panicked (sid={:?}) — closing socket",
                    runner.sid()
                );
                break;
            }
        }
    }

    // Teardown: mirrors both the Bun `close` and `error` paths collapsing to
    // one place. `HashMap::remove` returning `Some` is this Rust's analogue
    // of the TS `Set.delete()` boolean guard — fires `onDisconnect` at most
    // once even if this function is somehow re-entered (it isn't, but the
    // guard is cheap insurance mirroring the TS rationale verbatim).
    writer_task.abort();
    let removed = runners.lock().unwrap().remove(&id).is_some();
    if removed {
        on_disconnect(&runner);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Captured test spies for [`test_events`]: connect count, `(kind, payload)`
    /// log of dispatched messages, disconnect count.
    type TestEventSpies = (
        IpcServerEvents,
        Arc<AtomicUsize>,
        Arc<Mutex<Vec<(String, Value)>>>,
        Arc<AtomicUsize>,
    );

    fn test_events() -> TestEventSpies {
        let connect_count = Arc::new(AtomicUsize::new(0));
        let messages: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let disconnect_count = Arc::new(AtomicUsize::new(0));

        let cc = Arc::clone(&connect_count);
        let msgs = Arc::clone(&messages);
        let dc = Arc::clone(&disconnect_count);

        let events = IpcServerEvents {
            on_connect: Arc::new(move |_runner| {
                cc.fetch_add(1, Ordering::SeqCst);
            }),
            on_message: Arc::new(move |_runner, msg, _binary| {
                let t = match &msg {
                    IpcMessage::Hello { sid, .. } => format!("hello:{sid}"),
                    other => format!("{other:?}"),
                };
                msgs.lock().unwrap().push((t, Value::Null));
            }),
            on_disconnect: Arc::new(move |_runner| {
                dc.fetch_add(1, Ordering::SeqCst);
            }),
        };
        (events, connect_count, messages, disconnect_count)
    }

    #[tokio::test]
    async fn bind_connect_hello_tracks_sid_and_fires_callbacks() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let (events, connect_count, messages, disconnect_count) = test_events();

        let mut server = IpcServer::new(events);
        let bound = server.start(Some(sock.clone())).unwrap();
        assert_eq!(bound, sock);

        let mut client = UnixStream::connect(&sock).await.unwrap();
        let hello = serde_json::json!({"t":"hello","sid":"s1","cwd":"/x","pid":42});
        let frame = tp_core::codec::encode_frame(&serde_json::to_vec(&hello).unwrap(), None);
        client.write_all(&frame).await.unwrap();

        // Poll until the message is observed.
        for _ in 0..100 {
            if !messages.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        assert_eq!(connect_count.load(Ordering::SeqCst), 1);
        assert_eq!(messages.lock().unwrap().len(), 1);
        assert_eq!(messages.lock().unwrap()[0].0, "hello:s1");

        let found = server.find_runner_by_sid("s1");
        assert!(found.is_some());
        assert_eq!(found.unwrap().sid().as_deref(), Some("s1"));

        // Drop the client → EOF → onDisconnect fires exactly once.
        drop(client);
        for _ in 0..100 {
            if disconnect_count.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(disconnect_count.load(Ordering::SeqCst), 1);

        server.stop();
    }

    #[tokio::test]
    async fn malformed_frame_tears_down_socket_without_crashing_server() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let (events, _connect_count, _messages, disconnect_count) = test_events();

        let mut server = IpcServer::new(events);
        server.start(Some(sock.clone())).unwrap();

        let mut client = UnixStream::connect(&sock).await.unwrap();
        // Poison header: jsonLen = 0xFFFFFFFF (H1 oversized-frame rejection).
        let mut poison = vec![0xFFu8, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0];
        poison.extend_from_slice(b"x");
        let _ = client.write_all(&poison).await;

        // The connection should be torn down (onDisconnect fires) without
        // the server itself dying — prove the server is still alive by
        // connecting a second, well-behaved client afterward.
        for _ in 0..100 {
            if disconnect_count.load(Ordering::SeqCst) >= 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(disconnect_count.load(Ordering::SeqCst), 1);

        // Server survives: a second connection still works.
        let mut client2 = UnixStream::connect(&sock).await.unwrap();
        let hello = serde_json::json!({"t":"hello","sid":"s2","cwd":"/x","pid":7});
        let frame = tp_core::codec::encode_frame(&serde_json::to_vec(&hello).unwrap(), None);
        assert!(client2.write_all(&frame).await.is_ok());

        server.stop();
    }

    #[tokio::test]
    async fn heal_now_rebinds_after_dirent_unlink() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let (events, _connect_count, _messages, _disconnect_count) = test_events();

        let mut server = IpcServer::new(events);
        server.start(Some(sock.clone())).unwrap();

        // Healthy: no heal needed.
        assert!(!server.heal_now().await);

        // Unlink the dirent out from under the live listener (the kernel
        // socket survives; the path does not).
        std::fs::remove_file(&sock).unwrap();
        assert!(!sock.exists());

        let healed = server.heal_now().await;
        assert!(healed, "heal_now must re-bind after dirent unlink");
        assert!(sock.exists(), "the socket dirent must exist again");

        // New connections must work post-heal.
        let mut client = UnixStream::connect(&sock).await.unwrap();
        let hello = serde_json::json!({"t":"hello","sid":"s3","cwd":"/x","pid":9});
        let frame = tp_core::codec::encode_frame(&serde_json::to_vec(&hello).unwrap(), None);
        assert!(client.write_all(&frame).await.is_ok());

        server.stop();
    }

    #[tokio::test]
    async fn stop_clears_bound_path_and_runners() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let (events, _cc, _msgs, _dc) = test_events();

        let mut server = IpcServer::new(events);
        server.start(Some(sock.clone())).unwrap();
        assert!(server.bound_path().is_some());

        server.stop();
        assert!(server.bound_path().is_none());
        assert!(server.connected_runners().is_empty());
    }

    #[tokio::test]
    async fn send_delivers_frame_to_connected_client() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("d.sock");
        let (events, _cc, _msgs, _dc) = test_events();

        let mut server = IpcServer::new(events);
        server.start(Some(sock.clone())).unwrap();

        let mut client = UnixStream::connect(&sock).await.unwrap();
        let hello = serde_json::json!({"t":"hello","sid":"send-test","cwd":"/x","pid":1});
        let frame = tp_core::codec::encode_frame(&serde_json::to_vec(&hello).unwrap(), None);
        client.write_all(&frame).await.unwrap();

        let runner = loop {
            if let Some(r) = server.find_runner_by_sid("send-test") {
                break r;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };

        let ack = serde_json::json!({"t":"ack","sid":"send-test","seq":1});
        assert!(IpcServer::send(
            &runner,
            &serde_json::to_vec(&ack).unwrap(),
            None
        ));

        let mut header = [0u8; 8];
        client.read_exact(&mut header).await.unwrap();
        let json_len = u32::from_be_bytes(header[0..4].try_into().unwrap()) as usize;
        let mut json = vec![0u8; json_len];
        client.read_exact(&mut json).await.unwrap();
        let got: Value = serde_json::from_slice(&json).unwrap();
        assert_eq!(got["t"], "ack");

        server.stop();
    }
}
