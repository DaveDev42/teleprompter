//! Runner process supervisor.
//!
//! Byte-exact (behavior-identical) port of
//! `packages/daemon/src/session/session-manager.ts` (208 LOC). Spawns/kills/
//! registers Runner subprocesses and tracks them in a map. **Async — uses
//! tokio** `Command`/`Child` so the exit-monitor task can `.wait()` without
//! blocking a thread per session.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::process::{Child, Command};

/// Callback fired when any spawned Runner process exits, for ANY reason
/// (clean shutdown, crash, or kill). Lets the owner (Daemon) reconcile the
/// session row to "stopped" so a crashed Runner does not leave a phantom
/// "running" session for the rest of the daemon's lifetime. Mirrors
/// `RunnerExitHandler` (session-manager.ts:32).
pub type RunnerExitHandler = Arc<dyn Fn(String, i32) + Send + Sync>;

/// A tracked spawned child, wrapped so we can compare "is this THE process
/// that exited" by pointer identity — the Rust analogue of the TS `!==`
/// check on the `Subprocess` object reference (session-manager.ts:160).
/// `tokio::process::Child` has no stable identity of its own once moved into
/// a task, so we wrap it in `Arc<Mutex<Child>>` and compare `Arc::ptr_eq`.
pub type TrackedChild = Arc<Mutex<Child>>;

/// Byte-exact port of `RunnerInfo` (session-manager.ts:7-15).
#[derive(Clone)]
pub struct RunnerInfo {
    pub sid: String,
    pub pid: u32,
    pub cwd: String,
    pub worktree_path: Option<String>,
    pub claude_version: Option<String>,
    /// Epoch milliseconds, matching the TS `Date.now()`.
    pub connected_at: u64,
    /// The tracked child handle, if this daemon spawned the process (as
    /// opposed to a registered-only/passthrough runner it never spawned).
    pub process: Option<TrackedChild>,
}

/// Options for [`SessionManager::spawn_runner`]. Mirrors `SpawnRunnerOptions`
/// (session-manager.ts:17-24).
#[derive(Default, Clone)]
pub struct SpawnRunnerOptions {
    pub socket_path: Option<String>,
    pub worktree_path: Option<String>,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
    pub claude_args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Byte-exact (behavior-identical) port of `SessionManager`
/// (session-manager.ts:34-208). The runner-command override
/// ([`SessionManager::set_runner_command`]) is intentionally NOT a field
/// here — it mirrors the TS **static** `SessionManager.runnerCommand`
/// (session-manager.ts:39), a process-global, not per-instance ([`RUNNER_COMMAND`]).
pub struct SessionManager {
    runners: Arc<Mutex<HashMap<String, RunnerInfo>>>,
    on_runner_exit: Arc<Mutex<Option<RunnerExitHandler>>>,
}

/// Process-global runner-command override, mirroring the TS `static
/// runnerCommand` field on the class (a JS `static` is process-wide, not
/// per-instance). `Mutex<Option<Vec<String>>>` rather than `OnceLock` because
/// the TS setter can be called more than once (e.g. tests resetting it).
static RUNNER_COMMAND: Mutex<Option<Vec<String>>> = Mutex::new(None);

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            runners: Arc::new(Mutex::new(HashMap::new())),
            on_runner_exit: Arc::new(Mutex::new(None)),
        }
    }

    /// Byte-exact port of the static `setRunnerCommand`
    /// (session-manager.ts:41-43). Process-global — see [`RUNNER_COMMAND`].
    pub fn set_runner_command(cmd: Vec<String>) {
        *RUNNER_COMMAND.lock().unwrap() = Some(cmd);
    }

    /// Test/reset-only: clear the process-global runner command override so
    /// tests do not leak state into each other via the shared static.
    #[cfg(test)]
    fn clear_runner_command() {
        *RUNNER_COMMAND.lock().unwrap() = None;
    }

    /// Register a callback fired when any spawned Runner process exits.
    /// Mirrors `setOnRunnerExit` (session-manager.ts:46-48).
    pub fn set_on_runner_exit(&self, handler: RunnerExitHandler) {
        *self.on_runner_exit.lock().unwrap() = Some(handler);
    }

    /// Byte-exact port of `registerRunner` (session-manager.ts:50-68).
    /// Preserves an existing tracked `process` handle across a re-register
    /// (session-manager.ts:57-66, `process: existing?.process`) — a runner
    /// that reconnects (hello again) without this daemon having spawned it
    /// fresh must not lose its exit-monitor tracking.
    pub fn register_runner(
        &self,
        sid: &str,
        pid: u32,
        cwd: &str,
        worktree_path: Option<String>,
        claude_version: Option<String>,
    ) {
        let mut runners = self.runners.lock().unwrap();
        let existing_process = runners.get(sid).and_then(|r| r.process.clone());
        runners.insert(
            sid.to_string(),
            RunnerInfo {
                sid: sid.to_string(),
                pid,
                cwd: cwd.to_string(),
                worktree_path,
                claude_version,
                connected_at: now_ms(),
                process: existing_process,
            },
        );
    }

    /// Byte-exact port of `unregisterRunner` (session-manager.ts:70-73).
    pub fn unregister_runner(&self, sid: &str) {
        self.runners.lock().unwrap().remove(sid);
    }

    /// Byte-exact port of `getRunner` (session-manager.ts:75-77).
    pub fn get_runner(&self, sid: &str) -> Option<RunnerInfo> {
        self.runners.lock().unwrap().get(sid).cloned()
    }

    /// Byte-exact port of `listRunners` (session-manager.ts:79-81).
    pub fn list_runners(&self) -> Vec<RunnerInfo> {
        self.runners.lock().unwrap().values().cloned().collect()
    }

    /// Byte-exact port of the `activeCount` getter (session-manager.ts:83-85).
    pub fn active_count(&self) -> usize {
        self.runners.lock().unwrap().len()
    }

    /// Byte-exact port of `defaultRunnerCommand` (session-manager.ts:87-98).
    /// The TS resolves a path relative to `import.meta.dir` into
    /// `packages/runner/src/index.ts` and runs it via `["bun", "run",
    /// <path>]`. Rust has no `import.meta.dir` analogue and no in-process
    /// Bun runtime to `bun run` against, so this default is a placeholder —
    /// **TODO(inc5)**: wire the real Rust runner-binary default here (dual-run
    /// seam target, `TP_RUNNER_BIN`). For now this only matters when no
    /// caller has called [`SessionManager::set_runner_command`] — every
    /// production call path is expected to inject the command explicitly
    /// (mirrors the CLI's `SessionManager.setRunnerCommand(["./tp","run"])`).
    fn default_runner_command() -> Vec<String> {
        vec!["bun".to_string(), "run".to_string()]
    }

    /// Byte-exact port of `spawnRunner` (session-manager.ts:100-173): builds
    /// argv from a base command + `--sid/--cwd/--socket-path/--worktree-path
    /// /--cols/--rows`, then `-- <claudeArgs>`. Spawns via tokio `Command`.
    /// Tracks the child + installs the exit-monitor task with the
    /// GENERATION GUARD (session-manager.ts:147-172): on child exit,
    /// unregister and call `onRunnerExit(sid, code)` — BUT only if the
    /// currently-tracked child IS the one that exited (identity compare) —
    /// an old generation from a restart race must not tear down a
    /// newly-registered live session.
    ///
    /// # Errors
    /// The spawn `io::Error` if the process could not be started (mirrors
    /// `Bun.spawn` throwing synchronously on spawn failure).
    pub fn spawn_runner(
        &self,
        sid: &str,
        cwd: &str,
        opts: Option<SpawnRunnerOptions>,
    ) -> std::io::Result<u32> {
        let opts = opts.unwrap_or_default();
        let base_cmd = RUNNER_COMMAND
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(Self::default_runner_command);

        let mut args: Vec<String> = base_cmd.clone();
        args.push("--sid".to_string());
        args.push(sid.to_string());
        args.push("--cwd".to_string());
        args.push(cwd.to_string());

        if let Some(ref socket_path) = opts.socket_path {
            args.push("--socket-path".to_string());
            args.push(socket_path.clone());
        }
        if let Some(ref worktree_path) = opts.worktree_path {
            args.push("--worktree-path".to_string());
            args.push(worktree_path.clone());
        }
        if let Some(cols) = opts.cols {
            args.push("--cols".to_string());
            args.push(cols.to_string());
        }
        if let Some(rows) = opts.rows {
            args.push("--rows".to_string());
            args.push(rows.to_string());
        }

        // Add "--" separator and claude args.
        if let Some(ref claude_args) = opts.claude_args {
            if !claude_args.is_empty() {
                args.push("--".to_string());
                args.extend(claude_args.iter().cloned());
            }
        }

        let Some((program, rest)) = args.split_first() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "empty runner command",
            ));
        };

        let mut cmd = Command::new(program);
        cmd.args(rest)
            .current_dir(cwd)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        if let Some(ref env) = opts.env {
            for (k, v) in env {
                cmd.env(k, v);
            }
        }
        // kill_on_drop mirrors nothing in the TS (Bun.spawn's process outlives
        // a dropped JS reference) — explicitly false so a dropped SessionManager
        // does not reap live runner children out from under a restart.
        cmd.kill_on_drop(false);

        let child = cmd.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| std::io::Error::other("spawned child has no pid"))?;

        let tracked: TrackedChild = Arc::new(Mutex::new(child));

        // Track the spawned process.
        {
            let mut runners = self.runners.lock().unwrap();
            runners.insert(
                sid.to_string(),
                RunnerInfo {
                    sid: sid.to_string(),
                    pid,
                    cwd: cwd.to_string(),
                    worktree_path: opts.worktree_path.clone(),
                    claude_version: None,
                    connected_at: now_ms(),
                    process: Some(Arc::clone(&tracked)),
                },
            );
        }

        // Monitor exit. A Runner can die without sending a clean "bye"
        // (crash, OOM-kill, kill -9), which previously left the session row
        // stuck at "running" and the in-memory registration leaked for the
        // daemon's lifetime. On ANY exit we unregister and notify the owner
        // to reconcile.
        let runners = Arc::clone(&self.runners);
        let on_runner_exit = Arc::clone(&self.on_runner_exit);
        let sid_owned = sid.to_string();
        let tracked_for_wait = Arc::clone(&tracked);
        tokio::spawn(async move {
            // `Child::wait()` takes `&mut self` and is a real async future,
            // but a std `Mutex` guard can't be held across an `.await` (it's
            // not `Send`-safe to do so, and would also block `kill_runner`'s
            // synchronous lock for the whole wait). Poll `try_wait()`
            // instead, re-acquiring the lock each tick — cheap (a single
            // waitpid(WNOHANG) syscall) and lets `kill_runner`/registration
            // reads interleave freely, mirroring the TS `await proc.exited`
            // which likewise never blocks the rest of the single-threaded
            // event loop.
            let exit_code = loop {
                // Scope the guard to end strictly before the `.await` below —
                // a std `MutexGuard` is `!Send`, so it must not be live
                // across a suspend point in a future handed to `tokio::spawn`
                // (which requires the whole future to be `Send`).
                let polled = tracked_for_wait.lock().unwrap().try_wait();
                match polled {
                    Ok(Some(status)) => break status.code().unwrap_or(0),
                    Ok(None) => {
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                    Err(_) => break 0,
                }
            };

            // Guard against a restart race: session.restart kills the old
            // process and spawns a new one for the same sid. If the new
            // Runner has already re-registered (its `process` differs from
            // the one that just exited), this exit belongs to the old
            // generation — do not tear down the live session.
            let should_notify = {
                let mut map = runners.lock().unwrap();
                match map.get(&sid_owned) {
                    Some(current) => match &current.process {
                        Some(current_proc) if !Arc::ptr_eq(current_proc, &tracked) => {
                            // Stale generation — leave the live entry alone.
                            false
                        }
                        _ => {
                            map.remove(&sid_owned);
                            true
                        }
                    },
                    None => {
                        // Already unregistered by some other path — nothing
                        // to notify (mirrors the TS `current &&` guard, which
                        // is a no-op-if-absent, not a "notify anyway").
                        false
                    }
                }
            };

            if should_notify {
                if let Some(handler) = on_runner_exit.lock().unwrap().clone() {
                    handler(sid_owned, exit_code);
                }
            }
        });

        Ok(pid)
    }

    /// Byte-exact port of `killRunner` (session-manager.ts:175-185): signal
    /// the tracked child (SIGTERM), return whether a signal was sent.
    pub fn kill_runner(&self, sid: &str) -> bool {
        let process = {
            let runners = self.runners.lock().unwrap();
            runners.get(sid).and_then(|r| r.process.clone())
        };
        let Some(process) = process else {
            return false;
        };
        // tokio::process::Child has no direct SIGTERM helper — Rust's
        // `Child::start_kill`/`kill` sends SIGKILL, not SIGTERM. To match
        // the TS `Subprocess.kill()` default signal (SIGTERM), send it
        // explicitly via the pid.
        if let Ok(guard) = process.lock() {
            if let Some(pid) = guard.id() {
                let _ = send_sigterm(pid);
            }
        }
        true
    }

    /// Byte-exact port of `waitForExit` (session-manager.ts:203-207):
    /// resolve when the tracked child for `sid` has exited. Resolves
    /// immediately when no process is tracked (an unknown sid, or a
    /// registered-only/passthrough runner whose process this daemon never
    /// spawned and therefore cannot await — the caller is responsible for
    /// not destroying resources out from under such a runner).
    ///
    /// `killRunner` only *signals* the process (SIGTERM, returns
    /// immediately) — the child is not dead when it returns. A caller that
    /// needs the process to have released its resources (e.g. an open `cwd`
    /// inside a git worktree about to be `git worktree remove`d) must await
    /// the actual exit, otherwise it races the OS teardown: on POSIX an
    /// unlinked-cwd process keeps running and may still hold the directory's
    /// inode open while git tears the entry down, silently losing the
    /// child's pending output.
    pub async fn wait_for_exit(&self, sid: &str) {
        let process = {
            let runners = self.runners.lock().unwrap();
            runners.get(sid).and_then(|r| r.process.clone())
        };
        let Some(process) = process else {
            return;
        };
        loop {
            let exited = {
                let mut guard = process.lock().unwrap();
                matches!(guard.try_wait(), Ok(Some(_)) | Err(_))
            };
            if exited {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Send SIGTERM to `pid`, matching Bun `Subprocess.kill()`'s default signal.
/// Safe (no `unsafe` — workspace forbids it) via `rustix`.
fn send_sigterm(pid: u32) -> Result<(), rustix::io::Errno> {
    let Some(rpid) = rustix::process::Pid::from_raw(pid as i32) else {
        return Err(rustix::io::Errno::INVAL);
    };
    rustix::process::kill_process(rpid, rustix::process::Signal::TERM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

    fn unique_sid(tag: &str) -> String {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        format!("test-{tag}-{}", COUNTER.fetch_add(1, Ordering::SeqCst))
    }

    #[test]
    fn register_and_list_and_active_count() {
        let sm = SessionManager::new();
        sm.register_runner("s1", 100, "/cwd", None, None);
        sm.register_runner("s2", 200, "/cwd2", Some("/wt".into()), Some("1.0".into()));

        assert_eq!(sm.active_count(), 2);
        assert_eq!(sm.list_runners().len(), 2);

        let r2 = sm.get_runner("s2").unwrap();
        assert_eq!(r2.pid, 200);
        assert_eq!(r2.worktree_path.as_deref(), Some("/wt"));
        assert_eq!(r2.claude_version.as_deref(), Some("1.0"));

        sm.unregister_runner("s1");
        assert_eq!(sm.active_count(), 1);
        assert!(sm.get_runner("s1").is_none());
    }

    #[tokio::test]
    async fn register_runner_preserves_existing_process_handle_across_reregister() {
        let sm = SessionManager::new();
        let fake_child: TrackedChild = Arc::new(Mutex::new(
            Command::new("true")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn true"),
        ));
        {
            let mut runners = sm.runners.lock().unwrap();
            runners.insert(
                "s1".to_string(),
                RunnerInfo {
                    sid: "s1".to_string(),
                    pid: 1,
                    cwd: "/a".to_string(),
                    worktree_path: None,
                    claude_version: None,
                    connected_at: 0,
                    process: Some(Arc::clone(&fake_child)),
                },
            );
        }

        // Re-register the same sid with a new pid/cwd but no process arg —
        // the TS keeps `existing?.process`.
        sm.register_runner("s1", 2, "/b", None, None);
        let info = sm.get_runner("s1").unwrap();
        assert_eq!(info.pid, 2);
        assert_eq!(info.cwd, "/b");
        assert!(info.process.is_some());
        assert!(Arc::ptr_eq(&info.process.unwrap(), &fake_child));
    }

    #[tokio::test]
    async fn spawn_kill_and_wait_for_exit() {
        let sid = unique_sid("spawn");
        let sm = SessionManager::new();
        // `sh -c 'sleep 30'` ignores the injected --sid/--cwd/... argv (it
        // only reads argv[0] after `-c`), so this exercises spawn/kill/wait
        // without needing a real runner binary.
        SessionManager::set_runner_command(vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ]);
        let opts = SpawnRunnerOptions::default();
        let pid = sm.spawn_runner(&sid, "/tmp", Some(opts)).expect("spawn ok");
        assert!(pid > 0);
        assert_eq!(sm.active_count(), 1);

        assert!(sm.kill_runner(&sid));
        sm.wait_for_exit(&sid).await;

        // Give the exit-monitor task a moment to run and unregister.
        for _ in 0..50 {
            if sm.get_runner(&sid).is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(sm.get_runner(&sid).is_none());

        SessionManager::clear_runner_command();
    }

    #[tokio::test]
    async fn kill_runner_returns_false_for_registered_only_runner() {
        let sm = SessionManager::new();
        // registered (hello) but never spawned by this daemon — no process.
        sm.register_runner("passthrough", 999, "/cwd", None, None);
        assert!(!sm.kill_runner("passthrough"));
    }

    #[tokio::test]
    async fn wait_for_exit_resolves_immediately_for_unknown_sid() {
        let sm = SessionManager::new();
        // Must not hang.
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            sm.wait_for_exit("no-such-sid"),
        )
        .await
        .expect("wait_for_exit must resolve immediately for an unknown sid");
    }

    #[tokio::test]
    async fn generation_guard_stale_exit_does_not_fire_callback() {
        // Load-bearing: session.restart kills+respawns the SAME sid. The old
        // generation's exit-monitor task must NOT tear down the newly
        // registered live session, and onRunnerExit must NOT fire for the
        // stale generation.
        let sid = unique_sid("gen");
        let sm = SessionManager::new();

        let fired: Arc<AtomicI32> = Arc::new(AtomicI32::new(0));
        let fired_clone = Arc::clone(&fired);
        sm.set_on_runner_exit(Arc::new(move |_sid, _code| {
            fired_clone.fetch_add(1, Ordering::SeqCst);
        }));

        SessionManager::set_runner_command(vec![
            "sh".to_string(),
            "-c".to_string(),
            "sleep 0.2".to_string(),
        ]);
        // Spawn "old generation".
        sm.spawn_runner(&sid, "/tmp", None).expect("spawn old");
        let old_process = sm.get_runner(&sid).unwrap().process.unwrap();

        // Simulate the restart race: before the old process's exit-monitor
        // task observes the exit, a NEW generation re-registers under the
        // SAME sid with a NEW process (different Arc identity).
        let new_child: TrackedChild = Arc::new(Mutex::new(
            Command::new("sh")
                .args(["-c", "sleep 5"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn new generation"),
        ));
        {
            let mut runners = sm.runners.lock().unwrap();
            runners.insert(
                sid.clone(),
                RunnerInfo {
                    sid: sid.clone(),
                    pid: new_child.lock().unwrap().id().unwrap(),
                    cwd: "/tmp".to_string(),
                    worktree_path: None,
                    claude_version: None,
                    connected_at: now_ms(),
                    process: Some(Arc::clone(&new_child)),
                },
            );
        }
        assert!(!Arc::ptr_eq(&old_process, &new_child));

        // Wait long enough for the old generation's sleep(0.2) to exit and
        // its exit-monitor task to run its generation check.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        // The callback must NOT have fired for the stale generation, and the
        // NEW generation's registration must still be intact.
        assert_eq!(
            fired.load(Ordering::SeqCst),
            0,
            "onRunnerExit must not fire for a stale generation's exit"
        );
        let current = sm.get_runner(&sid).unwrap();
        assert!(Arc::ptr_eq(&current.process.unwrap(), &new_child));

        // Cleanup: kill the new generation's real child.
        new_child.lock().unwrap().start_kill().ok();
        SessionManager::clear_runner_command();
    }
}
