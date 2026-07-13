//! PTY spawn/read/write/resize/kill over `portable-pty` — port of
//! `packages/runner/src/pty/{pty-manager,pty-bun}.ts`, and the ADR §6.1 spike.
//!
//! # Why `portable-pty`
//!
//! ADR §6.1 flagged the PTY crate as "the single biggest technical unknown —
//! spike before Stage 4". `portable-pty` (wezterm) wins over `pty-process`
//! because its model maps cleanly onto the Bun `terminal:{ data() }` callback
//! surface this runner replaces:
//!
//! - `PtySystem::openpty(size)` → a `PtyPair { master, slave }`.
//! - `slave.spawn_command(cmd)` → a boxed `Child`. We drop the slave after spawn
//!   (portable-pty's documented pattern) so the child owns the only slave fd and
//!   the master reader sees EOF when the child exits.
//! - `master.try_clone_reader()` → a **blocking** `Read`. Bun surfaces bytes via
//!   an async `data()` callback; here a dedicated std reader thread reads and
//!   invokes `on_data` (the "reader-task hop"). This keeps the byte path off the
//!   caller's async loop without async PTY I/O.
//! - `master.take_writer()` / `master.resize()` → write + resize.
//! - `child.wait()` (blocking) → the exit code, forwarded to `on_exit` on its own
//!   thread. `child.clone_killer()` gives a `Send + Sync` handle for `kill()`, so
//!   the child can live wholly inside the waiter thread while the struct keeps
//!   only the killer + cached pid.
//!
//! # Callback surface
//!
//! Mirrors `PtyManager`: `spawn` wires `on_data`/`on_exit`, then `write`,
//! `resize`, `kill(signal)`, `pid`. `on_data` fires on the reader thread, so its
//! closure must be `Send`. Defaults match the Bun impl: 120×40, `xterm-256color`,
//! `kill` default SIGTERM (advisory — see [`Pty::kill`]).
//!
//! The crate stays `unsafe`-free (`unsafe_code = "forbid"` at the workspace
//! level) — portable-pty encapsulates the platform ioctls.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};

/// Bound on how long the waiter thread waits for the reader thread to finish
/// draining trailing PTY output before forwarding the exit code regardless.
/// Closes the Layer-1 race (reader/waiter are separate OS threads with no
/// inherent ordering) in the common case, WITHOUT risking an unbounded hang
/// when a grandchild inherits the PTY slave and keeps it open (reader never
/// reaches EOF) — a bounded `recv_timeout`, never a thread join. See module doc
/// + runner.rs exit-arm drain.
const READER_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_millis(200);

/// Options for [`Pty::spawn`]. Mirrors the TS `PtyOptions` (minus the callbacks,
/// which `spawn` takes as separate closures so their trait bounds are explicit).
pub struct PtyOptions {
    pub command: Vec<String>,
    pub cwd: String,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// A spawned PTY child. Holds the master (write/resize), a killer handle + cached
/// pid + exit flag (the child itself lives in the waiter thread), and the reader
/// thread join handle.
pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    // Interior-mutable so `write`/`write_shared` work through `&self` — the
    // Runner select loop holds the Pty by shared ref (it also resizes/kills
    // through `&self`), so a `&mut self` writer would force threading `&mut`
    // through the loop. A Mutex serialises the (infrequent) input writes.
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: Arc<AtomicBool>,
    pid: Option<u32>,
    reader_thread: Option<JoinHandle<()>>,
    waiter_thread: Option<JoinHandle<()>>,
}

impl Pty {
    /// Spawn `opts.command` in a PTY, wiring `on_data` (fires on the reader
    /// thread per byte-chunk) and `on_exit` (fires once with the exit code when
    /// the child exits). Returns the live handle, or an error if openpty/spawn
    /// fails.
    ///
    /// Byte-for-behaviour with `PtyBun.spawn`: 120×40 default size, name
    /// `xterm-256color`, background wait forwarding the exit code.
    pub fn spawn<D, E>(
        opts: PtyOptions,
        on_data: D,
        on_exit: E,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>>
    where
        D: FnMut(&[u8]) + Send + 'static,
        E: FnOnce(i32) + Send + 'static,
    {
        let sys = NativePtySystem::default();
        let size = PtySize {
            rows: opts.rows.unwrap_or(40),
            cols: opts.cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = sys.openpty(size)?;

        let (prog, args) = opts
            .command
            .split_first()
            .ok_or("command must have at least the program")?;
        let mut cmd = CommandBuilder::new(prog);
        cmd.args(args);
        cmd.cwd(&opts.cwd);
        // Match the Bun terminal `name` so claude sees the same $TERM.
        cmd.env("TERM", "xterm-256color");

        let mut child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();
        let killer = child.clone_killer();

        // Drop the slave: the child holds the only slave fd now, so the master
        // reader sees EOF when the child exits (avoids a hung reader).
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // 0-capacity rendezvous: carries no data, only the reader-done signal
        // (presence or sender-disconnect). The waiter recv_timeouts on it so it can
        // sequence on_exit strictly after the reader has flushed all bytes — bounded.
        let (reader_done_tx, reader_done_rx) = std::sync::mpsc::sync_channel::<()>(0);

        // Reader thread: blocking reads → on_data. Ends on EOF (child exit) or
        // read error.
        let mut on_data = on_data;
        let reader_thread = std::thread::Builder::new()
            .name("tp-runner-pty-reader".into())
            .spawn(move || {
                let mut reader = reader;
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // EOF
                        Ok(n) => on_data(&buf[..n]),
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                // Reader done: every byte read from the master has already been passed
                // to on_data (forwarded into pty_data_tx via try_send). Signal the
                // waiter so it can sequence on_exit strictly after this point. If the
                // waiter already timed out and dropped its receiver, this returns
                // Err(SendError) and we simply exit — no block, no panic.
                let _ = reader_done_tx.send(());
            })?;

        // Waiter thread: owns the child, blocks on wait(), forwards the exit
        // code. Separate from the reader so a slow drain never delays the exit
        // signal. Sets `exited` first so a racing kill() becomes a no-op.
        let exited = Arc::new(AtomicBool::new(false));
        let exited_thread = exited.clone();
        let waiter_thread = std::thread::Builder::new()
            .name("tp-runner-pty-wait".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                };
                // Mark exited the instant the child is reaped — BEFORE the drain grace
                // below — so a racing kill() stays a no-op on the (now-reaped, possibly
                // OS-recycled) pid. This flag tracks child liveness, not output
                // completeness, so it must not wait on the reader: sequencing it after
                // the recv_timeout would widen the TOCTOU window to READER_DRAIN_GRACE
                // and let a concurrent teardown-driven kill() signal a recycled pid.
                exited_thread.store(true, Ordering::SeqCst);
                // Bounded wait for the reader to drain trailing output already flushed
                // to the kernel PTY buffer before we signal exit — this is what closes
                // Layer 1. Ok(()) => reader finished, pty_data_tx already holds every
                // trailing chunk. Err(Timeout) => reader hasn't finished (e.g. a
                // grandchild still holds the PTY slave open) — proceed anyway so
                // exit/bye is never blocked unboundedly (200ms hard ceiling).
                let _ = reader_done_rx.recv_timeout(READER_DRAIN_GRACE);
                on_exit(code);
            })?;

        Ok(Pty {
            master: pair.master,
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            exited,
            pid,
            reader_thread: Some(reader_thread),
            waiter_thread: Some(waiter_thread),
        })
    }

    /// Write bytes to the PTY (child stdin) through `&self`. Surfaces write/flush
    /// errors — after a successful spawn the writer is always present (unlike the
    /// Bun no-op on an unspawned proc, which cannot occur here).
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut w = self
            .writer
            .lock()
            .map_err(|_| std::io::Error::other("pty writer poisoned"))?;
        w.write_all(data)?;
        w.flush()
    }

    /// Write bytes, swallowing errors — convenience for the Runner select loop's
    /// `input` handler, where a write failure to a dying PTY is not actionable
    /// (the exit branch will fire and drive teardown). Mirrors the Bun
    /// `terminal.write` no-op-on-dead-proc behaviour.
    pub fn write_shared(&self, data: &[u8]) {
        let _ = self.write(data);
    }

    /// Resize the PTY window. Matches `PtyBun.resize`.
    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Kill the child. `_signal` is accepted for parity with
    /// `PtyBun.kill(signal)` (default 15 = SIGTERM); portable-pty's killer sends
    /// SIGKILL on Unix, so the number is advisory — the daemon's graceful path
    /// relies on the child exiting, not on a specific signal. Idempotent: a no-op
    /// once the child has exited or if already killed.
    pub fn kill(&self, _signal: Option<i32>) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }

    /// The child's process id, cached at spawn.
    #[must_use]
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Whether the child has exited (the waiter thread has observed `wait()`).
    #[must_use]
    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Join the reader + waiter threads (shutdown/test helper — blocks until the
    /// child exits and its output is fully drained).
    pub fn join(&mut self) {
        if let Some(h) = self.reader_thread.take() {
            let _ = h.join();
        }
        if let Some(h) = self.waiter_thread.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    /// The spike: spawn a trivial program in a PTY, prove we read its output and
    /// observe its exit. This retires ADR §6.1 — portable-pty works end-to-end
    /// on this platform.
    #[test]
    fn pty_spike_reads_output_and_exits() {
        let (data_tx, data_rx) = channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = channel::<i32>();

        let mut pty = Pty::spawn(
            PtyOptions {
                // `echo` is present on macOS + Linux; PTY-cooked output ends the
                // line with CRLF.
                command: vec!["/bin/echo".into(), "tp-pty-spike".into()],
                cwd: "/".into(),
                cols: None,
                rows: None,
            },
            move |bytes| {
                let _ = data_tx.send(bytes.to_vec());
            },
            move |code| {
                let _ = exit_tx.send(code);
            },
        )
        .expect("spawn should succeed");

        assert!(pty.pid().is_some(), "spawned child has a pid");

        // Collect output until the reader thread hits EOF (child exit closes the
        // slave, master reader returns 0). Bounded wait so a hang fails the test.
        let mut collected = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match data_rx.recv_timeout(Duration::from_millis(200)) {
                Ok(chunk) => collected.extend_from_slice(&chunk),
                Err(_) => {
                    if !collected.is_empty() {
                        break;
                    }
                }
            }
        }
        let text = String::from_utf8_lossy(&collected);
        assert!(
            text.contains("tp-pty-spike"),
            "PTY output should contain the echoed string, got: {text:?}"
        );

        // The exit code arrives on the waiter thread.
        let code = exit_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("child should exit and report a code");
        assert_eq!(code, 0, "echo exits 0");

        pty.join();
        assert!(pty.has_exited());
    }

    /// Prove write reaches the child: `cat` echoes stdin back through the PTY.
    #[test]
    fn pty_write_roundtrips_through_cat() {
        let (data_tx, data_rx) = channel::<Vec<u8>>();

        let mut pty = Pty::spawn(
            PtyOptions {
                command: vec!["/bin/cat".into()],
                cwd: "/".into(),
                cols: None,
                rows: None,
            },
            move |bytes| {
                let _ = data_tx.send(bytes.to_vec());
            },
            |_code| {},
        )
        .expect("spawn cat");

        pty.write(b"hello-pty\n").expect("write to cat");

        // cat echoes the line back (PTY echo + cat's own copy).
        let mut collected = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
                collected.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&collected).contains("hello-pty") {
                    break;
                }
            }
        }
        assert!(
            String::from_utf8_lossy(&collected).contains("hello-pty"),
            "cat should echo the written line"
        );

        // Kill cat (it would otherwise block forever on stdin).
        pty.kill(None);
        pty.join();
        assert!(pty.has_exited());
    }
}
