//! Hook receiver — tokio port of `packages/runner/src/hooks/hook-receiver.ts`.
//!
//! Binds a Unix socket that each Claude Code hook connects to (via the `bun -e`
//! one-liner from [`crate::settings::capture_hook_command`]), reads the hook's
//! stdin JSON, validates it, and forwards the raw event to the owning Runner.
//!
//! # Invariants preserved from the Bun receiver
//!
//! - **dir perms**: `mkdir -p` the parent **mode 0700** + explicit `chmod 0700`
//!   (via [`crate::socket::resolve_runtime_dir`]), then atomically remove any
//!   stale socket before binding (no `exists → unlink` TOCTOU).
//! - **UTF-8 byte cap**: the per-connection accumulation buffer is capped at 1
//!   MiB measured in **UTF-8 bytes** (`String::len` is already byte length in
//!   Rust, unlike JS `.length` which is UTF-16 code units) — a flood that never
//!   forms valid JSON is dropped rather than growing without bound.
//! - **accumulate-then-parse**: chunks may split a hook payload; accumulate and
//!   attempt `serde_json::from_str` each time, resetting on success.
//! - **validation**: `parse_hook_event` mirrors `parseHookEvent` — object with a
//!   known `hook_event_name`, string `session_id`, string `cwd`; the raw object
//!   is forwarded unchanged (extra fields ride through to the collector).

use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::io::AsyncReadExt as _;
use tokio::net::UnixListener;
use tokio::sync::mpsc;

use crate::settings::HOOK_EVENTS;

/// Per-connection accumulation ceiling. Hook events are small (a few KB); a
/// stream that never forms valid JSON within this budget is dropped.
const MAX_HOOK_BUF_BYTES: usize = 1024 * 1024; // 1 MiB

/// Validate a decoded hook payload, mirroring `parseHookEvent`. Returns the raw
/// value unchanged when the envelope is valid (known `hook_event_name`, string
/// `session_id`, string `cwd`), else `None`.
#[must_use]
pub fn parse_hook_event(raw: &Value) -> Option<&Value> {
    let obj = raw.as_object()?;
    let name = obj.get("hook_event_name")?.as_str()?;
    if !HOOK_EVENTS.contains(&name) {
        return None;
    }
    obj.get("session_id")?.as_str()?;
    obj.get("cwd")?.as_str()?;
    Some(raw)
}

/// A running hook receiver. Holds the bound socket path (removed on [`stop`]) and
/// the listener task handle.
///
/// [`stop`]: HookReceiver::stop
pub struct HookReceiver {
    socket_path: PathBuf,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl HookReceiver {
    /// Bind `socket_path` and start accepting hook connections, forwarding each
    /// validated event (as an owned `Value`) on `events`. Returns the bound path.
    ///
    /// The parent dir is created mode-0700 + chmod'd, and any stale socket at
    /// the path is removed before binding.
    pub fn start(socket_path: PathBuf, events: mpsc::Sender<Value>) -> std::io::Result<Self> {
        if let Some(parent) = socket_path.parent() {
            create_dir_0700(parent)?;
        }
        // Atomic remove of any stale socket (ENOENT is success).
        match std::fs::remove_file(&socket_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }

        let listener = UnixListener::bind(&socket_path)?;
        let task = tokio::spawn(accept_loop(listener, events));

        Ok(HookReceiver {
            socket_path,
            task: Some(task),
        })
    }

    /// Stop accepting and remove the socket file (idempotent).
    pub fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

impl Drop for HookReceiver {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Accept connections forever; each is drained + parsed on its own task so a
/// slow/partial hook never blocks another.
async fn accept_loop(listener: UnixListener, events: mpsc::Sender<Value>) {
    loop {
        let Ok((conn, _)) = listener.accept().await else {
            break;
        };
        let events = events.clone();
        tokio::spawn(handle_conn(conn, events));
    }
}

/// Read one hook connection to EOF, accumulating chunks, and forward the first
/// valid hook event it forms. Mirrors the Bun per-connection `data`/`close`
/// handling: accumulate, cap at 1 MiB bytes, parse-on-complete.
async fn handle_conn(mut conn: tokio::net::UnixStream, events: mpsc::Sender<Value>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = match conn.read(&mut chunk).await {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };
        buf.extend_from_slice(&chunk[..n]);

        // Byte-length cap (Rust Vec<u8> len IS the byte count).
        if buf.len() > MAX_HOOK_BUF_BYTES {
            // Oversized — can never form a valid event within budget; drop.
            return;
        }

        // Try to parse the accumulated buffer as JSON. Incomplete → keep reading.
        if let Ok(value) = serde_json::from_slice::<Value>(&buf) {
            if parse_hook_event(&value).is_some() {
                let _ = events.send(value).await;
            }
            // Whether valid or not, a complete JSON document ends this hook
            // connection's payload (the Bun hook writes exactly one and closes).
            return;
        }
    }
}

/// `mkdir -p` mode 0700 + explicit chmod 0700 on the leaf (mirrors the TS
/// `mkdirSync({mode:0o700}) + chmodSync(0o700)`).
fn create_dir_0700(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncWriteExt as _;
    use tokio::net::UnixStream;

    #[test]
    fn parse_hook_event_validates_envelope() {
        // Valid: known name + string session_id + string cwd.
        let ok = json!({"hook_event_name":"Stop","session_id":"a","cwd":"/x","extra":1});
        assert!(parse_hook_event(&ok).is_some());
        // Unknown event name → reject.
        assert!(
            parse_hook_event(&json!({"hook_event_name":"Nope","session_id":"a","cwd":"/x"}))
                .is_none()
        );
        // Missing/typed-wrong session_id or cwd → reject.
        assert!(parse_hook_event(&json!({"hook_event_name":"Stop","cwd":"/x"})).is_none());
        assert!(
            parse_hook_event(&json!({"hook_event_name":"Stop","session_id":1,"cwd":"/x"}))
                .is_none()
        );
        assert!(
            parse_hook_event(&json!({"hook_event_name":"Stop","session_id":"a","cwd":2})).is_none()
        );
        // Not an object → reject.
        assert!(parse_hook_event(&json!("nope")).is_none());
    }

    #[tokio::test]
    async fn receives_a_hook_event_over_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hook-s.sock");
        let (tx, mut rx) = mpsc::channel::<Value>(8);
        let _recv = HookReceiver::start(sock.clone(), tx).unwrap();

        // Connect and write a valid hook event, then close (as the bun one-liner
        // does: write + end).
        let mut client = UnixStream::connect(&sock).await.unwrap();
        let event = json!({
            "hook_event_name":"UserPromptSubmit",
            "session_id":"sess","cwd":"/work","prompt":"hi"
        });
        client
            .write_all(&serde_json::to_vec(&event).unwrap())
            .await
            .unwrap();
        client.shutdown().await.unwrap();

        let got = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("event within timeout")
            .expect("an event");
        assert_eq!(got["hook_event_name"], "UserPromptSubmit");
        assert_eq!(got["prompt"], "hi");
    }

    #[tokio::test]
    async fn oversized_payload_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hook-s.sock");
        let (tx, mut rx) = mpsc::channel::<Value>(8);
        let _recv = HookReceiver::start(sock.clone(), tx).unwrap();

        let mut client = UnixStream::connect(&sock).await.unwrap();
        // > 1 MiB of non-JSON garbage.
        let garbage = vec![b'x'; MAX_HOOK_BUF_BYTES + 1024];
        let _ = client.write_all(&garbage).await;
        client.shutdown().await.ok();

        // Nothing should be forwarded.
        let res = tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await;
        assert!(
            res.is_err(),
            "no event should be forwarded for oversized garbage"
        );
    }
}
