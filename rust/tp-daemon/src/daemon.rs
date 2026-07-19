//! Daemon assembly — behavior-faithful port of `packages/daemon/src/daemon.ts`
//! (594 LOC; ADR-0003 Phase 4, increment 5).
//!
//! The TS `Daemon` class closes its construction cycles through `this`
//! (`getDispatcher()`, `createSession`, pair handlers). The Rust port closes
//! the same cycles with **late-bound slots** instead of back-references, so
//! no `Arc` cycle exists:
//!
//! - [`DaemonRelayDeps::dispatch_relay_control`] reads the dispatcher from a
//!   `Mutex<Option<Arc<IpcCommandDispatcher>>>` slot — the literal Rust shape
//!   of the TS lazy `getDispatcher: () => this.dispatcher` (daemon.ts:140).
//! - The push-notifier `sendPush` closure reads the relay manager from a slot
//!   (the TS closure reads `this.relayManager`, daemon.ts:96-106).
//! - `createSession`'s socket path and `setRepoRoot`'s worktree manager are
//!   slots the dispatcher deps read per call (daemon.ts:153, 470-478).
//!
//! ## Honest deviations from TS (each flagged in the increment report)
//!
//! - **`awaitPendingPairing()` promise → poll-watcher task.** The TS pair
//!   completion flow is a `.then` chain on the pending pairing's promise
//!   (daemon.ts:363-410). The Rust orchestrator resolves via
//!   `wait_for_join(&mut self)`, which would starve `cancel` if the watcher
//!   held the orchestrator lock across the full await — so the watcher polls
//!   `wait_for_join` in bounded [`PAIR_WATCH_POLL_MS`] windows and reads
//!   `resolved()`/`has_pending()` each tick. End frames (`pair.completed` /
//!   `pair.cancelled` / `pair.error`) are byte-identical.
//! - **promote() cannot fail through the inc4 trait.**
//!   `OrchestratorDeps::save_pairing` returns `()` while the TS
//!   `store.savePairing` can throw (daemon.ts:379-396 catches it). The
//!   daemon-side deps record the store error in a slot; after `promote` the
//!   watcher checks it and mirrors the TS failure branch (log + defensive
//!   clear + `pair.error`), additionally tearing the just-registered client
//!   back down via `remove_pairing(notify_peer=false)` so the pool matches
//!   the (unpersisted) store.
//! - **`stop()` does not close the store.** `Store::close(self)` is consuming
//!   and the store `Arc` is shared with the dispatcher/relay deps; rusqlite
//!   closes the connections when the last `Arc` drops — same end state.
//!   (The TS `close()` convenience delegate is omitted for the same reason.)
//! - `listSessions()` throwing out of `start()` (TS) becomes
//!   `unwrap_or_default()` + the sweep simply seeing no rows — consistent
//!   with the dispatcher's log-and-continue store-error posture.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tp_proto::ipc::{DoctorRelayStatus, IpcMessage, IpcPairBeginErrReason, IpcPairErrorReason};
use tp_proto::label::Label;

use crate::ipc::command_dispatcher::{
    BoxFuture, IpcCommandDispatcher, IpcCommandDispatcherDeps, OnRecordFn, RelayClientLink,
    RelayLink,
};
use crate::ipc::server::{ConnectedRunner, IpcServer, IpcServerEvents};
use crate::pairing::orchestrator::{
    BeginPairingError, BeginResult, OrchestratorDeps, PairingOrchestrator, RelayClientFactoryFn,
};
use crate::pairing::pending_pairing::{PendingPairingCompleted, PendingPairingResult};
use crate::push::notifier::PushNotifier;
use crate::session::manager::{RunnerInfo, SessionManager, SpawnRunnerOptions};
use crate::store::session_db::StoredRecord;
use crate::store::store::{SavePairingInput, SessionMeta, Store};
use crate::transport::relay_client::{RelayClient, RelayClientConfig, RelayClientEvents};
use crate::transport::relay_manager::{
    DispatchSendPushFn, RelayConnectionManager, RelayManagerDeps, StorePushNotifierDeps,
};
use crate::worktree::manager::WorktreeManager;

/// `DEFAULT_PRUNE_TTL_DAYS` (daemon.ts:37). `f64` because the TS TTL is a JS
/// number (fractional days from `TP_PRUNE_TTL_DAYS` are legal).
pub const DEFAULT_PRUNE_TTL_DAYS: f64 = 7.0;
/// `PRUNE_INTERVAL_MS` (daemon.ts:38) — 24 hours.
const PRUNE_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
/// Poll window of the pair-completion watcher (see module doc §deviations).
const PAIR_WATCH_POLL_MS: u64 = 25;

/// Late-bound dispatcher slot — the Rust shape of the TS lazy
/// `getDispatcher()` (daemon.ts:140).
type DispatcherSlot = Arc<Mutex<Option<Arc<IpcCommandDispatcher>>>>;
type RelayManagerSlot = Arc<Mutex<Option<Arc<RelayConnectionManager<DaemonRelayDeps>>>>>;
type WorktreeSlot = Arc<Mutex<Option<Arc<WorktreeManager>>>>;
type SocketPathSlot = Arc<Mutex<Option<PathBuf>>>;
type OnRecordSlot = Arc<Mutex<Option<OnRecordFn>>>;

/// Serialize + frame + send an IPC message to a connected runner. Mirrors the
/// TS `this.ipcServer.send(runner, msg)` call sites (the Rust
/// [`IpcServer::send`] is an associated fn over pre-encoded JSON).
fn send_ipc(runner: &ConnectedRunner, msg: &IpcMessage) {
    if let Ok(json) = serde_json::to_vec(msg) {
        let _ = IpcServer::send(runner, &json, None);
    }
}

// ---------------------------------------------------------------------------
// RelayManagerDeps impl (daemon.ts:136-141)
// ---------------------------------------------------------------------------

/// The Daemon's [`RelayManagerDeps`]: owns `Arc` clones of the shared
/// components plus the late-bound dispatcher slot (no back-pointer to
/// [`Daemon`], so no `Arc` cycle).
pub struct DaemonRelayDeps {
    ipc_server: Arc<IpcServer>,
    store: Arc<Mutex<Store>>,
    push_notifier: Arc<Mutex<PushNotifier<StorePushNotifierDeps>>>,
    dispatcher: DispatcherSlot,
}

impl RelayManagerDeps for DaemonRelayDeps {
    fn ipc_server(&self) -> &IpcServer {
        &self.ipc_server
    }

    fn store(&self) -> &Mutex<Store> {
        &self.store
    }

    fn push_notifier(&self) -> &Mutex<PushNotifier<StorePushNotifierDeps>> {
        &self.push_notifier
    }

    /// Route a decrypted relay control message into the dispatcher. The trait
    /// method is sync (the TS `getDispatcher().dispatchRelayControl(..)` call
    /// fires promises); the Rust dispatcher entry is async, so spawn it.
    fn dispatch_relay_control(&self, client: &Arc<RelayClient>, msg: &Value, frontend_id: &str) {
        let Some(dispatcher) = self.dispatcher.lock().unwrap().clone() else {
            // Pre-wiring window only. Unreachable in practice: `Daemon::new`
            // fills the slot synchronously before any relay client exists.
            return;
        };
        let relay: Arc<dyn RelayLink> = Arc::new(RelayClientLink(Arc::clone(client)));
        let msg = msg.clone();
        let frontend_id = frontend_id.to_string();
        tokio::spawn(async move {
            dispatcher
                .dispatch_relay_control(&relay, &msg, &frontend_id)
                .await;
        });
    }
}

// ---------------------------------------------------------------------------
// OrchestratorDeps impl (daemon.ts:143-146)
// ---------------------------------------------------------------------------

/// The Daemon's [`OrchestratorDeps`], delegating to the relay manager + store
/// exactly like the TS `PairingOrchestratorDeps` bag.
pub struct DaemonOrchDeps {
    relay_manager: Arc<RelayConnectionManager<DaemonRelayDeps>>,
    store: Arc<Mutex<Store>>,
    /// `OrchestratorDeps::save_pairing` returns `()` (inc4 trait) while the
    /// TS `store.savePairing` can throw inside `promote()`. The error is
    /// recorded here so the pair-begin watcher can mirror the TS
    /// promote-failure branch (daemon.ts:379-396). See module doc.
    last_save_error: Mutex<Option<String>>,
}

impl OrchestratorDeps for DaemonOrchDeps {
    fn build_events(
        &self,
        _get_client: Arc<dyn Fn() -> Option<Arc<RelayClient>> + Send + Sync>,
        label: Option<Label>,
        daemon_id: String,
    ) -> RelayClientEvents {
        // The manager's `build_events` resolves clients from its own pool, so
        // the orchestrator-provided `get_client` shim is unused here (same
        // information flow as the TS `RelayConnectionManager.buildEvents`).
        self.relay_manager.build_events(label, daemon_id)
    }

    fn register_client(&self, client: Arc<RelayClient>) {
        self.relay_manager.register_client(client);
    }

    fn factory(&self) -> Option<RelayClientFactoryFn> {
        self.relay_manager.factory()
    }

    fn daemon_id_taken(&self, daemon_id: &str) -> bool {
        let store = self.store.lock().unwrap();
        store
            .list_pairings()
            .unwrap_or_default()
            .iter()
            .any(|p| p.daemon_id == daemon_id)
    }

    fn save_pairing(&self, completed: &PendingPairingCompleted) {
        let input = SavePairingInput {
            daemon_id: completed.daemon_id.clone(),
            relay_url: completed.relay_url.clone(),
            relay_token: completed.relay_token.clone(),
            registration_proof: completed.registration_proof.clone(),
            public_key: completed.key_pair.public_key.to_vec(),
            secret_key: completed.key_pair.secret_key.to_vec(),
            pairing_secret: completed.pairing_secret.clone(),
            label: Some(completed.label.clone()),
            pairing_id: completed.pairing_id.clone(),
            hostname: completed.hostname.clone(),
        };
        let result = {
            let store = self.store.lock().unwrap();
            store.save_pairing(&input)
        };
        if let Err(err) = result {
            *self.last_save_error.lock().unwrap() = Some(err.to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing runtime (daemon.ts __handlePairBegin/__handlePairCancel/
// __handleCliDisconnect + pendingPairingOwner)
// ---------------------------------------------------------------------------

/// Watcher-loop verdict for one poll tick (see [`PairingRuntime::watch_pending`]).
enum WatchOutcome {
    Promoted(Box<PendingPairingCompleted>),
    /// Our pairing is gone: cancelled, or the slot now belongs to a
    /// successor `begin` (whose own watcher handles it).
    CancelledOurs,
    StillPending,
}

/// Everything the IPC pair handlers share with the dispatcher closures.
/// `owner` mirrors `pendingPairingOwner` (daemon.ts:49) keyed by
/// [`ConnectedRunner::id`] (the TS code compares object identity).
struct PairingRuntime {
    orchestrator: tokio::sync::Mutex<PairingOrchestrator<DaemonOrchDeps>>,
    orch_deps: Arc<DaemonOrchDeps>,
    owner: Mutex<Option<u64>>,
    relay_manager: Arc<RelayConnectionManager<DaemonRelayDeps>>,
}

impl PairingRuntime {
    /// TS `if (this.pendingPairingOwner === runner) this.pendingPairingOwner
    /// = null` (daemon.ts:367-368).
    fn clear_owner_if(&self, runner: &ConnectedRunner) {
        let mut owner = self.owner.lock().unwrap();
        if *owner == Some(runner.id()) {
            *owner = None;
        }
    }

    /// Port of `__handlePairBegin` (daemon.ts:341-427). Runs as a spawned
    /// task (the TS call site is `void this.__handlePairBegin(...)`).
    async fn handle_pair_begin(
        self: Arc<Self>,
        runner: Arc<ConnectedRunner>,
        relay_url: String,
        daemon_id: Option<String>,
        label: Option<Label>,
    ) {
        let begin = {
            let mut orch = self.orchestrator.lock().await;
            orch.begin(relay_url, daemon_id, label).await
        };
        let info = match begin {
            Ok(info) => info,
            Err(err) => {
                // TS: reason = BeginPairingError ? err.reason : "internal";
                // Rust `begin` only surfaces `BeginPairingError`, so the
                // "internal" arm is unreachable here.
                let reason = match &err {
                    BeginPairingError::AlreadyPending => IpcPairBeginErrReason::AlreadyPending,
                    BeginPairingError::DaemonIdTaken => IpcPairBeginErrReason::DaemonIdTaken,
                    BeginPairingError::RelayUnreachable(_) => {
                        IpcPairBeginErrReason::RelayUnreachable
                    }
                };
                let message = err.to_string();
                eprintln!(
                    "[Daemon] pair.begin failed: reason={} message={message}",
                    err.reason()
                );
                send_ipc(
                    &runner,
                    &IpcMessage::PairBeginErr {
                        reason,
                        message: Some(message),
                    },
                );
                return;
            }
        };

        *self.owner.lock().unwrap() = Some(runner.id());
        send_ipc(
            &runner,
            &IpcMessage::PairBeginOk {
                pairing_id: info.pairing_id.clone(),
                qr_string: info.qr_string.clone(),
                daemon_id: info.daemon_id.clone(),
            },
        );

        // Fire-and-forget completion follow-up (TS `p.then(...)`,
        // daemon.ts:363-410) — this fn already runs in its own task.
        self.watch_pending(&runner, &info.pairing_id, &info.daemon_id)
            .await;
    }

    /// The `.then` half of `__handlePairBegin` (daemon.ts:366-410): await the
    /// pending pairing's outcome, then promote + `pair.completed`, or
    /// `pair.cancelled`, or (promote failure) `pair.error`.
    async fn watch_pending(
        self: &Arc<Self>,
        runner: &ConnectedRunner,
        pairing_id: &str,
        daemon_id: &str,
    ) {
        loop {
            // Bounded-window poll: `wait_for_join` needs `&mut` on the
            // orchestrator, so a full-await hold would starve `cancel`.
            // Its fast path consumes an already-recorded join, so a join
            // landing between windows is picked up next tick.
            let outcome = {
                let mut orch = self.orchestrator.lock().await;
                let _ = tokio::time::timeout(
                    Duration::from_millis(PAIR_WATCH_POLL_MS),
                    orch.wait_for_join(),
                )
                .await;
                let r = orch.resolved();
                match r {
                    Some(PendingPairingResult::Completed(completed)) => {
                        // Single-slot invariant: the resolved pending pairing
                        // IS ours (`cancel` clears the slot, so no successor
                        // can resolve here). Mirror TS `daemon.ts:369` which
                        // branches purely on `result.kind === "completed"` and
                        // never compares a pairingId. NB: `completed.pairing_id`
                        // is the WIRE UUID (QR bundle id, for store persistence)
                        // while this watcher's `pairing_id` is the daemon-local
                        // `pp-…` slot id — different namespaces, so comparing
                        // them always mismatched and mis-routed every real
                        // completion to CancelledOurs (the flip regression).
                        // Promote inside the same lock so no cancel/stop
                        // interleaves between observation and promote.
                        orch.promote(&completed);
                        WatchOutcome::Promoted(completed)
                    }
                    Some(PendingPairingResult::Cancelled) => WatchOutcome::CancelledOurs,
                    None => {
                        if orch.has_pending() {
                            WatchOutcome::StillPending
                        } else {
                            WatchOutcome::CancelledOurs
                        }
                    }
                }
            };

            match outcome {
                WatchOutcome::StillPending => {}
                WatchOutcome::CancelledOurs => {
                    self.clear_owner_if(runner);
                    send_ipc(
                        runner,
                        &IpcMessage::PairCancelled {
                            pairing_id: pairing_id.to_string(),
                        },
                    );
                    return;
                }
                WatchOutcome::Promoted(completed) => {
                    self.clear_owner_if(runner);
                    let save_err = self.orch_deps.last_save_error.lock().unwrap().take();
                    if let Some(message) = save_err {
                        // TS promote-failure branch (daemon.ts:379-396). See
                        // module doc: promote already registered the client,
                        // so also tear it back down to match the unpersisted
                        // store (best-effort, like the TS clearPending).
                        eprintln!(
                            "[Daemon] promoteCompletedPairing failed (pairingId={pairing_id}): {message}"
                        );
                        self.relay_manager.remove_pairing(daemon_id, false).await;
                        {
                            let mut orch = self.orchestrator.lock().await;
                            orch.clear_pending().await;
                        }
                        send_ipc(
                            runner,
                            &IpcMessage::PairError {
                                pairing_id: pairing_id.to_string(),
                                reason: IpcPairErrorReason::Internal,
                                message: Some(message),
                            },
                        );
                    } else {
                        send_ipc(
                            runner,
                            &IpcMessage::PairCompleted {
                                pairing_id: pairing_id.to_string(),
                                daemon_id: daemon_id.to_string(),
                                label: completed.label.clone(),
                            },
                        );
                    }
                    return;
                }
            }
        }
    }

    /// Port of `__handlePairCancel` (daemon.ts:429-437).
    fn handle_pair_cancel(self: &Arc<Self>, runner: &Arc<ConnectedRunner>, pairing_id: String) {
        {
            let owner = self.owner.lock().unwrap();
            if owner.is_some() && *owner != Some(runner.id()) {
                eprintln!(
                    "[Daemon] pair.cancel from non-owner runner ignored (pairingId={pairing_id})"
                );
                return;
            }
        }
        // TS cancelPendingPairing(msg.pairingId) is sync; the Rust cancel is
        // async (relay dispose) — spawn it.
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut orch = this.orchestrator.lock().await;
            orch.cancel(Some(&pairing_id)).await;
        });
    }

    /// Port of `__handleCliDisconnect` (daemon.ts:439-445).
    fn handle_cli_disconnect(self: &Arc<Self>, runner: &Arc<ConnectedRunner>) {
        let mut owner = self.owner.lock().unwrap();
        if *owner == Some(runner.id()) {
            eprintln!("[Daemon] CLI disconnected mid-pairing; cancelling pending");
            *owner = None;
            drop(owner);
            let this = Arc::clone(self);
            tokio::spawn(async move {
                let mut orch = this.orchestrator.lock().await;
                orch.cancel(None).await;
            });
        }
    }
}

// ---------------------------------------------------------------------------
// TTL resolution (daemon.ts:205-224) — pure so it can be unit-tested without
// touching process env.
// ---------------------------------------------------------------------------

/// `Number(raw)` for the TTL env string. JS coerces with `Number()`:
/// whitespace-trimmed, decimal/scientific floats parse, anything else is
/// `NaN`. (Honest deviation: JS also accepts `"0x.."`/`"Infinity"` where Rust
/// `parse` accepts `"inf"`/`"NaN"` — both sides land in the same invalid →
/// fallback branch for every realistic TTL value.)
fn js_number(raw: &str) -> f64 {
    let t = raw.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Resolve the auto-cleanup TTL (daemon.ts:210-224): explicit arg ??
/// (`TP_PRUNE_TTL_DAYS` env if non-empty) ?? 7. `Err(raw)` = the value was
/// present but invalid (non-finite or ≤ 0) — the caller warns with `raw` and
/// falls back to [`DEFAULT_PRUNE_TTL_DAYS`].
///
/// # Errors
/// `Err(raw)` carries the offending raw value for the TS-shaped warning
/// (`invalid prune TTL '<raw>', falling back to 7d`).
pub fn resolve_prune_ttl_days(ttl_days: Option<f64>, env_val: Option<&str>) -> Result<f64, String> {
    // TS: `process.env["TP_PRUNE_TTL_DAYS"] ? Number(..) : DEFAULT` — an
    // EMPTY env string is falsy and silently selects the default (no warn).
    let days = match ttl_days {
        Some(d) => d,
        None => match env_val {
            Some(raw) if !raw.is_empty() => js_number(raw),
            _ => return Ok(DEFAULT_PRUNE_TTL_DAYS),
        },
    };
    if !days.is_finite() || days <= 0.0 {
        // TS raw: String(ttlDays) when the arg was given, else env ?? "".
        let raw = match ttl_days {
            Some(d) => format!("{d}"),
            None => env_val.unwrap_or("").to_string(),
        };
        return Err(raw);
    }
    Ok(days)
}

/// The startup cleanup pass (daemon.ts:232-253): prune + orphaned-sidecar
/// sweep + orphaned-confirmation sweep, all inside ONE guard — an error from
/// any step logs and continues (an unguarded throw would abort startup
/// before the daemon accepts any IPC). Pinning Bun tests:
/// `auto-cleanup.test.ts` "startAutoCleanup prunes old sessions on startup" /
/// "startAutoCleanup sweeps orphaned WAL/SHM sidecars on startup" /
/// "startAutoCleanup does not throw when the startup prune fails".
fn run_startup_cleanup(store: &Arc<Mutex<Store>>, max_age_ms: i64, days: f64) {
    let result: Result<(), String> = (|| {
        let mut store = store.lock().unwrap();
        let pruned = store
            .prune_old_sessions(max_age_ms)
            .map_err(|e| e.to_string())?;
        if pruned > 0 {
            eprintln!("[Daemon] pruned {pruned} old session(s) (>{days}d)");
        }
        let swept = store.sweep_orphaned_sidecars().map_err(|e| e.to_string())?;
        if swept > 0 {
            eprintln!("[Daemon] swept {swept} orphaned WAL/SHM sidecar file(s)");
        }
        let orphaned_pcts = store
            .sweep_orphaned_confirmations()
            .map_err(|e| e.to_string())?;
        if orphaned_pcts > 0 {
            eprintln!("[Daemon] swept {orphaned_pcts} orphaned pairing confirmation row(s)");
        }
        Ok(())
    })();
    if let Err(err) = result {
        eprintln!("[Daemon] startup auto-cleanup failed (continuing): {err}");
    }
}

/// One periodic prune tick (daemon.ts:257-269): swallow-and-log so a
/// transient FS/SQLite error never kills the long-running scheduler (the TS
/// comment: a throw out of a timer callback terminates the process).
fn run_periodic_prune(store: &Arc<Mutex<Store>>, max_age_ms: i64, days: f64) {
    let result = {
        let mut store = store.lock().unwrap();
        store.prune_old_sessions(max_age_ms)
    };
    match result {
        Ok(n) if n > 0 => {
            eprintln!("[Daemon] periodic prune: removed {n} session(s) (>{days}d)");
        }
        Ok(_) => {}
        Err(err) => {
            eprintln!("[Daemon] periodic auto-cleanup failed (continuing): {err}");
        }
    }
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/// Port of the TS `Daemon` class (daemon.ts:40-594).
pub struct Daemon {
    ipc_server: Arc<IpcServer>,
    store: Arc<Mutex<Store>>,
    session_manager: Arc<SessionManager>,
    relay_manager: Arc<RelayConnectionManager<DaemonRelayDeps>>,
    worktree_manager: WorktreeSlot,
    prune_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pairing: Arc<PairingRuntime>,
    dispatcher: Arc<IpcCommandDispatcher>,
    socket_path: SocketPathSlot,
    on_record: OnRecordSlot,
}

impl Daemon {
    /// Construct the fully-wired daemon (TS constructor, daemon.ts:65-173).
    /// Wiring order mirrors TS: store → onRunnerExit → pushNotifier →
    /// ipcServer → relayManager → pairingOrchestrator → dispatcher.
    ///
    /// # Errors
    /// The underlying `rusqlite::Error` if the store cannot be opened
    /// (mirrors the TS constructor letting `new Store(..)` throw).
    #[allow(clippy::too_many_lines)] // linear TS-constructor mirror; splitting would obscure the wiring order
    pub fn new(store_dir: Option<PathBuf>) -> rusqlite::Result<Self> {
        let store = Arc::new(Mutex::new(Store::open(store_dir, None)?));
        let session_manager = Arc::new(SessionManager::new());
        let dispatcher_slot: DispatcherSlot = Arc::new(Mutex::new(None));
        let relay_manager_slot: RelayManagerSlot = Arc::new(Mutex::new(None));

        // Reconcile session state when a Runner process exits for any reason
        // (daemon.ts:88-94; see the long TS comment — this covers the
        // crash/kill path where no "bye" is sent, and the broadcast is the
        // critical half: without it subscribed frontends never learn a
        // crashed session died). Registered before the dispatcher exists but
        // only ever RUNS after construction completes (slot is filled).
        {
            let store = Arc::clone(&store);
            let dispatcher_slot = Arc::clone(&dispatcher_slot);
            session_manager.set_on_runner_exit(Arc::new(move |sid, _exit_code| {
                let flipped = {
                    let store = store.lock().unwrap();
                    match store.get_session(&sid) {
                        Ok(Some(meta)) if meta.state == "running" => {
                            let _ = store.update_session_state(&sid, "stopped");
                            true
                        }
                        _ => false,
                    }
                };
                if flipped {
                    if let Some(dispatcher) = dispatcher_slot.lock().unwrap().clone() {
                        let sid = sid.clone();
                        tokio::spawn(async move {
                            dispatcher.broadcast_session_state(&sid).await;
                        });
                    }
                }
            }));
        }

        // PushNotifier (daemon.ts:96-112). The TS sendPush closure reads
        // `this.relayManager`; the manager doesn't exist yet, so read it from
        // a slot filled right after construction.
        let push_dispatch: DispatchSendPushFn = {
            let relay_manager_slot = Arc::clone(&relay_manager_slot);
            Arc::new(
                move |frontend_id,
                      sealed,
                      title,
                      body,
                      interruption_level,
                      sid,
                      event,
                      daemon_id| {
                    let Some(manager) = relay_manager_slot.lock().unwrap().clone() else {
                        return;
                    };
                    let frontend_id = frontend_id.to_string();
                    let sealed = sealed.to_string();
                    let title = title.to_string();
                    let body = body.to_string();
                    let sid = sid.to_string();
                    let event = event.to_string();
                    let daemon_id = daemon_id.to_string();
                    tokio::spawn(async move {
                        // TS `data?.daemonId` is falsy for "": normalize an
                        // empty owner id to None so `send_push` falls back to
                        // the client's own daemon id, like the TS path.
                        let owner = if daemon_id.is_empty() {
                            None
                        } else {
                            Some(daemon_id.as_str())
                        };
                        manager
                            .dispatch_push(
                                &frontend_id,
                                &sealed,
                                &title,
                                &body,
                                Some(interruption_level),
                                Some((&sid, owner, &event)),
                            )
                            .await;
                    });
                },
            )
        };
        let push_notifier = Arc::new(Mutex::new(PushNotifier::new(StorePushNotifierDeps::new(
            Arc::clone(&store),
            push_dispatch,
        ))));

        // IpcServer (daemon.ts:117-130) — all three callbacks route through
        // the late-bound dispatcher slot.
        let ipc_server = {
            let disconnect_slot = Arc::clone(&dispatcher_slot);
            let message_slot = Arc::clone(&dispatcher_slot);
            Arc::new(IpcServer::new(IpcServerEvents {
                on_message: Arc::new(move |runner, msg, binary| {
                    if let Some(dispatcher) = message_slot.lock().unwrap().clone() {
                        dispatcher.dispatch_ipc(runner, &msg, binary);
                    }
                }),
                on_connect: Arc::new(|_runner| {
                    eprintln!("[Daemon] runner connected");
                }),
                on_disconnect: Arc::new(move |runner| {
                    if let Some(dispatcher) = disconnect_slot.lock().unwrap().clone() {
                        dispatcher.handle_runner_disconnect(runner);
                    }
                    if let Some(sid) = runner.sid() {
                        eprintln!("[Daemon] runner disconnected sid={sid}");
                    }
                }),
            }))
        };

        // RelayConnectionManager (daemon.ts:136-141) — constructed before the
        // dispatcher; the dispatcher reads clients via `list_clients()` and
        // the manager reads the dispatcher lazily via the slot.
        let relay_deps = Arc::new(DaemonRelayDeps {
            ipc_server: Arc::clone(&ipc_server),
            store: Arc::clone(&store),
            push_notifier: Arc::clone(&push_notifier),
            dispatcher: Arc::clone(&dispatcher_slot),
        });
        let relay_manager = Arc::new(RelayConnectionManager::new(relay_deps));
        *relay_manager_slot.lock().unwrap() = Some(Arc::clone(&relay_manager));

        // PairingOrchestrator (daemon.ts:143-146).
        let orch_deps = Arc::new(DaemonOrchDeps {
            relay_manager: Arc::clone(&relay_manager),
            store: Arc::clone(&store),
            last_save_error: Mutex::new(None),
        });
        let pairing = Arc::new(PairingRuntime {
            orchestrator: tokio::sync::Mutex::new(PairingOrchestrator::new(Arc::clone(&orch_deps))),
            orch_deps,
            owner: Mutex::new(None),
            relay_manager: Arc::clone(&relay_manager),
        });

        let worktree_manager: WorktreeSlot = Arc::new(Mutex::new(None));
        let socket_path: SocketPathSlot = Arc::new(Mutex::new(None));
        let on_record: OnRecordSlot = Arc::new(Mutex::new(None));

        // IpcCommandDispatcher (daemon.ts:148-172).
        let dispatcher = IpcCommandDispatcher::new(IpcCommandDispatcherDeps {
            ipc_server: Arc::clone(&ipc_server),
            store: Arc::clone(&store),
            session_manager: Arc::clone(&session_manager),
            push_notifier: Arc::clone(&push_notifier),
            get_worktree_manager: {
                let wm = Arc::clone(&worktree_manager);
                Arc::new(move || wm.lock().unwrap().clone())
            },
            create_session: {
                let session_manager = Arc::clone(&session_manager);
                let socket_path = Arc::clone(&socket_path);
                Arc::new(move |sid, cwd, opts| {
                    // TS createSession (daemon.ts:470-478): override
                    // socketPath with the daemon's own (post-start) path; a
                    // pre-start None maps to the spawner's default.
                    let mut opts = opts;
                    opts.socket_path = socket_path
                        .lock()
                        .unwrap()
                        .clone()
                        .map(|p| p.to_string_lossy().into_owned());
                    session_manager
                        .spawn_runner(sid, cwd, Some(opts))
                        .map(|_pid| ())
                        .map_err(|e| e.to_string())
                })
            },
            on_pair_begin: {
                let pairing = Arc::clone(&pairing);
                Arc::new(move |runner, msg| {
                    let IpcMessage::PairBegin {
                        relay_url,
                        daemon_id,
                        label,
                    } = msg
                    else {
                        return;
                    };
                    // TS: `void this.__handlePairBegin(runner, msg)`.
                    let this = Arc::clone(&pairing);
                    let runner = Arc::clone(runner);
                    let relay_url = relay_url.clone();
                    let daemon_id = daemon_id.clone();
                    let label = label.clone();
                    tokio::spawn(async move {
                        this.handle_pair_begin(runner, relay_url, daemon_id, label)
                            .await;
                    });
                })
            },
            on_pair_cancel: {
                let pairing = Arc::clone(&pairing);
                Arc::new(move |runner, msg| {
                    let IpcMessage::PairCancel { pairing_id } = msg else {
                        return;
                    };
                    pairing.handle_pair_cancel(runner, pairing_id.clone());
                })
            },
            on_cli_disconnect: {
                let pairing = Arc::clone(&pairing);
                Arc::new(move |runner| pairing.handle_cli_disconnect(runner))
            },
            remove_pairing: {
                let relay_manager = Arc::clone(&relay_manager);
                Arc::new(move |daemon_id: String| -> BoxFuture<Result<u64, String>> {
                    let relay_manager = Arc::clone(&relay_manager);
                    Box::pin(async move {
                        // TS removePairing default opts = { notifyPeer: true }.
                        let notified = relay_manager.remove_pairing(&daemon_id, true).await;
                        Ok(notified as u64)
                    })
                })
            },
            rename_pairing: {
                let relay_manager = Arc::clone(&relay_manager);
                Arc::new(
                    move |daemon_id: String, label: Label| -> BoxFuture<Result<u64, String>> {
                        let relay_manager = Arc::clone(&relay_manager);
                        Box::pin(async move {
                            let notified = relay_manager.rename_pairing(&daemon_id, label).await;
                            Ok(notified as u64)
                        })
                    },
                )
            },
            get_on_record: {
                let on_record = Arc::clone(&on_record);
                Arc::new(move || on_record.lock().unwrap().clone())
            },
            get_relay_clients: {
                let relay_manager = Arc::clone(&relay_manager);
                Arc::new(move || {
                    relay_manager
                        .list_clients()
                        .into_iter()
                        .map(|c| Arc::new(RelayClientLink(c)) as Arc<dyn RelayLink>)
                        .collect()
                })
            },
            get_relay_health: {
                let relay_manager = Arc::clone(&relay_manager);
                Arc::new(move || -> BoxFuture<Vec<DoctorRelayStatus>> {
                    // daemon.ts:164-171 — snapshot per client.
                    let clients = relay_manager.list_clients();
                    Box::pin(async move {
                        let mut out = Vec::with_capacity(clients.len());
                        for c in clients {
                            out.push(DoctorRelayStatus {
                                daemon_id: c.daemon_id().to_string(),
                                relay_url: c.relay_url().to_string(),
                                connected: c.is_connected().await,
                                peer_count: c.get_peer_count().await as u64,
                                throttled: Some(c.is_throttled().await),
                            });
                        }
                        out
                    })
                })
            },
        });
        *dispatcher_slot.lock().unwrap() = Some(Arc::clone(&dispatcher));

        Ok(Daemon {
            ipc_server,
            store,
            session_manager,
            relay_manager,
            worktree_manager,
            prune_task: Mutex::new(None),
            pairing,
            dispatcher,
            socket_path,
            on_record,
        })
    }

    /// Port of `start()` (daemon.ts:185-198): mark stale "running" sessions
    /// from a previous daemon run as stopped, then bind the IPC socket.
    ///
    /// # Errors
    /// The socket-bind `io::Error` from [`IpcServer::start`].
    pub fn start(&self, socket_path: Option<PathBuf>) -> std::io::Result<PathBuf> {
        let stale: Vec<String> = {
            let store = self.store.lock().unwrap();
            store
                .list_sessions()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| s.state == "running")
                .map(|s| s.sid)
                .collect()
        };
        for sid in stale {
            {
                let store = self.store.lock().unwrap();
                let _ = store.update_session_state(&sid, "stopped");
            }
            eprintln!("[Daemon] marked stale session as stopped: {sid}");
        }

        let path = self.ipc_server.start(socket_path)?;
        *self.socket_path.lock().unwrap() = Some(path.clone());
        eprintln!("[Daemon] started");
        Ok(path)
    }

    /// Port of `startAutoCleanup` (daemon.ts:205-273): resolve TTL, prune
    /// immediately (guarded), then schedule the 24h periodic prune. Must be
    /// called from within a tokio runtime (the TS `setInterval` becomes a
    /// spawned interval task; `unref()` needs no analog — tokio tasks never
    /// keep the process alive on their own).
    pub fn start_auto_cleanup(&self, ttl_days: Option<f64>) {
        let env_val = std::env::var("TP_PRUNE_TTL_DAYS").ok();
        let days = match resolve_prune_ttl_days(ttl_days, env_val.as_deref()) {
            Ok(days) => days,
            Err(raw) => {
                eprintln!(
                    "[Daemon] invalid prune TTL '{raw}', falling back to {DEFAULT_PRUNE_TTL_DAYS}d"
                );
                DEFAULT_PRUNE_TTL_DAYS
            }
        };
        #[allow(clippy::cast_possible_truncation)] // days is validated finite & > 0
        let max_age_ms = (days * 24.0 * 60.0 * 60.0 * 1000.0) as i64;

        run_startup_cleanup(&self.store, max_age_ms, days);

        // Schedule periodic cleanup (daemon.ts:256-272).
        self.stop_auto_cleanup();
        let store = Arc::clone(&self.store);
        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(PRUNE_INTERVAL_MS));
            // tokio's first tick completes immediately; consume it so the
            // first real pass is 24h out (TS setInterval semantics).
            interval.tick().await;
            loop {
                interval.tick().await;
                run_periodic_prune(&store, max_age_ms, days);
            }
        });
        *self.prune_task.lock().unwrap() = Some(handle);
    }

    /// Port of `stopAutoCleanup` (daemon.ts:278-283).
    pub fn stop_auto_cleanup(&self) {
        if let Some(handle) = self.prune_task.lock().unwrap().take() {
            handle.abort();
        }
    }

    /// True while the periodic prune task is scheduled (test observability —
    /// the TS tests read the private `pruneTimer` directly).
    #[must_use]
    pub fn auto_cleanup_scheduled(&self) -> bool {
        self.prune_task.lock().unwrap().is_some()
    }

    /// Port of `connectRelay` (daemon.ts:294-296) — thin delegate to
    /// [`RelayConnectionManager::add_client`].
    ///
    /// # Errors
    /// The store error from persisting the pairing row (the client is
    /// disposed on that path — see `add_client`).
    pub async fn connect_relay(
        &self,
        config: RelayClientConfig,
    ) -> rusqlite::Result<Arc<RelayClient>> {
        self.relay_manager.add_client(config).await
    }

    /// Test-only hook: inject a fake `RelayClient` factory (TS
    /// `__setRelayFactory`, daemon.ts:299-301).
    pub fn set_relay_factory(&self, factory: RelayClientFactoryFn) {
        self.relay_manager.set_factory(factory);
    }

    /// Port of `beginPairing` (daemon.ts:310-316) — thin delegate to
    /// [`PairingOrchestrator::begin`].
    ///
    /// # Errors
    /// [`BeginPairingError`] — the IPC layer converts it into
    /// `pair.begin.err` (see `PairingRuntime::handle_pair_begin`).
    pub async fn begin_pairing(
        &self,
        relay_url: String,
        daemon_id: Option<String>,
        label: Option<Label>,
    ) -> Result<BeginResult, BeginPairingError> {
        let mut orch = self.pairing.orchestrator.lock().await;
        orch.begin(relay_url, daemon_id, label).await
    }

    /// Port of `cancelPendingPairing` (daemon.ts:326-328).
    pub async fn cancel_pending_pairing(&self, pairing_id: Option<&str>) {
        let mut orch = self.pairing.orchestrator.lock().await;
        orch.cancel(pairing_id).await;
    }

    /// TS `daemon.pendingPairing` getter analog (daemon.ts:181-183) collapsed
    /// to the boolean the callers actually branch on.
    pub async fn has_pending_pairing(&self) -> bool {
        self.pairing.orchestrator.lock().await.has_pending()
    }

    /// Port of `reconnectSavedRelays` (daemon.ts:461-468): backfill legacy
    /// `pairing_id`s first (warn-and-continue — the derivation retries on the
    /// next startup), then reconnect every persisted pairing.
    pub async fn reconnect_saved_relays(&self) -> usize {
        let migrate = {
            let store = self.store.lock().unwrap();
            store.migrate_pairing_ids()
        };
        if let Err(err) = migrate {
            eprintln!("[Daemon] pairing_id backfill failed (continuing): {err}");
        }
        self.relay_manager.reconnect_saved().await
    }

    /// Port of `createSession` (daemon.ts:470-478).
    ///
    /// # Errors
    /// The spawn `io::Error` (mirrors `spawnRunner` throwing).
    pub fn create_session(
        &self,
        sid: &str,
        cwd: &str,
        opts: Option<SpawnRunnerOptions>,
    ) -> std::io::Result<u32> {
        let mut opts = opts.unwrap_or_default();
        opts.socket_path = self
            .socket_path
            .lock()
            .unwrap()
            .clone()
            .map(|p| p.to_string_lossy().into_owned());
        self.session_manager.spawn_runner(sid, cwd, Some(opts))
    }

    /// Port of `sendInput` (daemon.ts:481-490): raw terminal bytes →
    /// base64 IPC `input` frame to the session's Runner.
    pub fn send_input(&self, sid: &str, data: &[u8]) {
        use base64::Engine as _;
        if let Some(runner) = self.ipc_server.find_runner_by_sid(sid) {
            send_ipc(
                &runner,
                &IpcMessage::Input {
                    sid: sid.to_string(),
                    data: base64::engine::general_purpose::STANDARD.encode(data),
                },
            );
        }
    }

    /// Port of `resizeSession` (daemon.ts:493-498).
    pub fn resize_session(&self, sid: &str, cols: u64, rows: u64) {
        if let Some(runner) = self.ipc_server.find_runner_by_sid(sid) {
            send_ipc(
                &runner,
                &IpcMessage::Resize {
                    sid: sid.to_string(),
                    cols,
                    rows,
                },
            );
        }
    }

    /// Port of `setRepoRoot` (daemon.ts:503-505).
    ///
    /// # Errors
    /// The `io::Error` from canonicalizing `repo_root`
    /// ([`WorktreeManager::new`] validates the path; the TS constructor
    /// defers failures to first use).
    pub fn set_repo_root(&self, repo_root: &Path) -> std::io::Result<()> {
        let wm = WorktreeManager::new(repo_root)?;
        *self.worktree_manager.lock().unwrap() = Some(Arc::new(wm));
        Ok(())
    }

    /// Port of `getRunner` (daemon.ts:508-510).
    #[must_use]
    pub fn get_runner(&self, sid: &str) -> Option<RunnerInfo> {
        self.session_manager.get_runner(sid)
    }

    /// Port of `listSessions` (daemon.ts:513-515).
    ///
    /// # Errors
    /// The underlying `rusqlite::Error` (TS lets the store throw).
    pub fn list_sessions(&self) -> rusqlite::Result<Vec<SessionMeta>> {
        self.store.lock().unwrap().list_sessions()
    }

    /// Port of `getSession` (daemon.ts:518-520).
    ///
    /// # Errors
    /// The underlying `rusqlite::Error` (TS lets the store throw).
    pub fn get_session(&self, sid: &str) -> rusqlite::Result<Option<SessionMeta>> {
        self.store.lock().unwrap().get_session(sid)
    }

    /// Port of `getRecordsSince` (daemon.ts:526-530): records with
    /// `seq > after_seq`, empty when the session is unknown (or the read
    /// fails — log-and-continue store posture).
    #[must_use]
    pub fn get_records_since(&self, sid: &str, after_seq: i64, limit: i64) -> Vec<StoredRecord> {
        let mut store = self.store.lock().unwrap();
        match store.get_session_db(sid) {
            Some(db) => db.get_records_from(after_seq, limit).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    /// Port of `removePairing` (daemon.ts:551-556) — thin delegate. Returns
    /// the number of peers notified.
    pub async fn remove_pairing(&self, daemon_id: &str, notify_peer: bool) -> usize {
        self.relay_manager
            .remove_pairing(daemon_id, notify_peer)
            .await
    }

    /// Port of `renamePairing` (daemon.ts:565-567) — thin delegate. Returns
    /// the number of peers notified.
    pub async fn rename_pairing(&self, daemon_id: &str, label: Label) -> usize {
        self.relay_manager.rename_pairing(daemon_id, label).await
    }

    /// Port of `getActivePairingIds` (daemon.ts:570-572).
    #[must_use]
    pub fn get_active_pairing_ids(&self) -> Vec<String> {
        self.relay_manager.list_daemon_ids()
    }

    /// Install (or clear) the local record observer — the field assignment
    /// `daemon.onRecord = ...` in TS (daemon.ts:61-63); the dispatcher reads
    /// it per record via its `get_on_record` dep.
    pub fn set_on_record(&self, observer: Option<OnRecordFn>) {
        *self.on_record.lock().unwrap() = observer;
    }

    /// The IPC socket path once [`Daemon::start`] has bound it.
    #[must_use]
    pub fn socket_path(&self) -> Option<PathBuf> {
        self.socket_path.lock().unwrap().clone()
    }

    /// The wired command dispatcher (the bin + tests reach broadcast helpers
    /// through it; TS exposes the field to the relay manager only).
    #[must_use]
    pub fn dispatcher(&self) -> Arc<IpcCommandDispatcher> {
        Arc::clone(&self.dispatcher)
    }

    /// Port of `stop()` (daemon.ts:574-593): kill running sessions, stop the
    /// cleanup scheduler, tear down pairing → relay → IPC. (Store close is a
    /// drop-time effect here — see module doc §deviations.)
    pub async fn stop(&self) {
        let runners = self.session_manager.list_runners();
        let mut killed = 0u32;
        for runner in runners {
            if self.session_manager.kill_runner(&runner.sid) {
                killed += 1;
            }
        }
        if killed > 0 {
            eprintln!("[Daemon] killed {killed} running session(s)");
        }

        self.stop_auto_cleanup();
        {
            let mut orch = self.pairing.orchestrator.lock().await;
            orch.stop().await;
        }
        self.relay_manager.stop().await;
        self.ipc_server.stop();
        eprintln!("[Daemon] stopped");
    }
}

// ---------------------------------------------------------------------------
// Tests — each names the mirrored Bun test (or the pinned daemon.ts lines
// where no Bun twin exists).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tp_core::codec::FrameDecoder;

    fn temp_daemon() -> (tempfile::TempDir, Daemon) {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::new(Some(dir.path().join("vault"))).unwrap();
        (dir, daemon)
    }

    /// Backdate a session's `updated_at` via a second rusqlite connection to
    /// the same meta DB (WAL mode allows concurrent connections) — same
    /// technique as the store's own prune tests, without reaching into the
    /// store's private fields.
    fn backdate_session(vault: &Path, sid: &str, ms_ago: i64) {
        let conn = rusqlite::Connection::open(vault.join("sessions.sqlite")).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(0))
            .unwrap_or(0);
        conn.execute(
            "UPDATE sessions SET updated_at = ? WHERE sid = ?",
            rusqlite::params![now - ms_ago, sid],
        )
        .unwrap();
    }

    /// Receive the next framed JSON reply from a detached runner's outbound
    /// channel (same decode helper shape as the dispatcher tests).
    async fn recv_json(rx: &mut tokio::sync::mpsc::Receiver<Vec<u8>>) -> Value {
        let mut decoder = FrameDecoder::new();
        let deadline = Duration::from_secs(10);
        let chunk = tokio::time::timeout(deadline, rx.recv())
            .await
            .expect("timed out waiting for an IPC reply frame")
            .expect("runner outbound channel closed");
        let frames = decoder.decode(&chunk).expect("frame decode failed");
        let frame = frames.into_iter().next().expect("empty decode batch");
        serde_json::from_slice(&frame.json).expect("reply frame is not JSON")
    }

    /// Poll until `cond` is true (bounded) — pairing cancel runs on spawned
    /// tasks, so assertions on orchestrator state need a settle window.
    async fn wait_until<F: FnMut() -> bool>(mut cond: F) {
        for _ in 0..400 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("wait_until condition never became true");
    }

    fn install_fake_factory(daemon: &Daemon) {
        // Mirrors the Bun tests' `__setRelayFactory` fake: a real RelayClient
        // over an unreachable reserved-TLD URL (connect settles fast, the
        // background reconnect loop is inert) — same approach as the
        // orchestrator's own `fake_deps_with_factory`.
        daemon.set_relay_factory(Arc::new(RelayClient::new));
    }

    fn pair_begin_msg() -> IpcMessage {
        IpcMessage::PairBegin {
            relay_url: "wss://relay.example".to_string(),
            daemon_id: Some("daemon-test".to_string()),
            label: None,
        }
    }

    // ------------------------------------------------------------------
    // resolve_prune_ttl_days (pure)
    // ------------------------------------------------------------------

    // Mirrors Bun: auto-cleanup.test.ts "startAutoCleanup uses default 7-day TTL".
    #[test]
    fn ttl_defaults_to_7_days() {
        assert_eq!(resolve_prune_ttl_days(None, None), Ok(7.0));
        // TS truthiness: an EMPTY env string is falsy → default, no warning
        // (daemon.ts:212-214).
        assert_eq!(resolve_prune_ttl_days(None, Some("")), Ok(7.0));
    }

    // Mirrors Bun: auto-cleanup.test.ts "startAutoCleanup respects
    // TP_PRUNE_TTL_DAYS env var" (env passed as a parameter here — the pure
    // fn seam keeps the test env-mutation-free).
    #[test]
    fn ttl_respects_env_var_and_explicit_arg_wins() {
        assert_eq!(resolve_prune_ttl_days(None, Some("30")), Ok(30.0));
        // Explicit arg takes precedence over env (TS `ttlDays ?? env`).
        assert_eq!(resolve_prune_ttl_days(Some(3.0), Some("30")), Ok(3.0));
    }

    // Mirrors Bun: auto-cleanup.test.ts "startAutoCleanup(0) falls back to
    // DEFAULT_PRUNE_TTL_DAYS, does not wipe all sessions".
    #[test]
    fn ttl_zero_arg_falls_back() {
        assert_eq!(
            resolve_prune_ttl_days(Some(0.0), None),
            Err("0".to_string())
        );
    }

    // Mirrors Bun: auto-cleanup.test.ts "startAutoCleanup(-1) falls back to
    // DEFAULT_PRUNE_TTL_DAYS".
    #[test]
    fn ttl_negative_arg_falls_back() {
        assert_eq!(
            resolve_prune_ttl_days(Some(-1.0), None),
            Err("-1".to_string())
        );
    }

    // Mirrors Bun: auto-cleanup.test.ts "TP_PRUNE_TTL_DAYS=abc falls back to
    // DEFAULT_PRUNE_TTL_DAYS".
    #[test]
    fn ttl_non_numeric_env_falls_back() {
        assert_eq!(
            resolve_prune_ttl_days(None, Some("abc")),
            Err("abc".to_string())
        );
    }

    // Mirrors Bun: auto-cleanup.test.ts "TP_PRUNE_TTL_DAYS=0 falls back to
    // DEFAULT_PRUNE_TTL_DAYS".
    #[test]
    fn ttl_zero_env_falls_back() {
        assert_eq!(
            resolve_prune_ttl_days(None, Some("0")),
            Err("0".to_string())
        );
    }

    // ------------------------------------------------------------------
    // Auto-cleanup (integration over a real temp store)
    // ------------------------------------------------------------------

    // Mirrors Bun: auto-cleanup.test.ts "startAutoCleanup prunes old sessions
    // on startup".
    #[tokio::test]
    async fn auto_cleanup_prunes_old_stopped_sessions_on_startup() {
        let (dir, daemon) = temp_daemon();
        {
            let mut store = daemon.store.lock().unwrap();
            store
                .create_session("old-sess", "/tmp", None, None)
                .unwrap();
            store.update_session_state("old-sess", "stopped").unwrap();
        }
        backdate_session(
            &dir.path().join("vault"),
            "old-sess",
            8 * 24 * 60 * 60 * 1000, // 8 days > 7d TTL
        );

        daemon.start_auto_cleanup(Some(7.0));

        assert!(
            daemon.get_session("old-sess").unwrap().is_none(),
            "8-day-old stopped session must be pruned by the startup pass"
        );
        daemon.stop_auto_cleanup();
    }

    // Mirrors Bun: auto-cleanup.test.ts "running sessions are not pruned
    // regardless of age".
    #[tokio::test]
    async fn auto_cleanup_never_prunes_running_sessions() {
        let (dir, daemon) = temp_daemon();
        {
            let mut store = daemon.store.lock().unwrap();
            store
                .create_session("live-sess", "/tmp", None, None)
                .unwrap(); // state = running
        }
        backdate_session(
            &dir.path().join("vault"),
            "live-sess",
            30 * 24 * 60 * 60 * 1000,
        );

        daemon.start_auto_cleanup(Some(7.0));

        assert!(
            daemon.get_session("live-sess").unwrap().is_some(),
            "running session must survive the prune regardless of age"
        );
        daemon.stop_auto_cleanup();
    }

    // Mirrors Bun: auto-cleanup.test.ts "stopAutoCleanup clears the interval"
    // + "stop() clears auto-cleanup timer".
    #[tokio::test]
    async fn stop_auto_cleanup_clears_the_scheduler() {
        let (_dir, daemon) = temp_daemon();
        daemon.start_auto_cleanup(Some(7.0));
        assert!(daemon.auto_cleanup_scheduled());
        daemon.stop_auto_cleanup();
        assert!(!daemon.auto_cleanup_scheduled());

        // stop() clears it too (daemon.ts:587).
        daemon.start_auto_cleanup(Some(7.0));
        assert!(daemon.auto_cleanup_scheduled());
        daemon.stop().await;
        assert!(!daemon.auto_cleanup_scheduled());
    }

    // ------------------------------------------------------------------
    // start() stale-session sweep
    // ------------------------------------------------------------------

    // No dedicated Bun twin — pins daemon.ts:185-198 (stale "running" rows
    // from a previous daemon run are flipped to "stopped" before the IPC
    // socket binds).
    #[tokio::test]
    async fn start_marks_stale_running_sessions_stopped() {
        let (dir, daemon) = temp_daemon();
        {
            let mut store = daemon.store.lock().unwrap();
            store
                .create_session("stale-sess", "/tmp", None, None)
                .unwrap(); // seeded "running"
        }

        let socket = dir.path().join("d.sock");
        let bound = daemon.start(Some(socket.clone())).unwrap();
        assert_eq!(bound, socket);
        assert_eq!(daemon.socket_path(), Some(socket));

        let meta = daemon.get_session("stale-sess").unwrap().unwrap();
        assert_eq!(
            meta.state, "stopped",
            "stale running session must be swept to stopped on start()"
        );
        daemon.stop().await;
    }

    // ------------------------------------------------------------------
    // Pairing owner bookkeeping (IPC pair.begin / pair.cancel / disconnect)
    // ------------------------------------------------------------------

    // Mirrors Bun: daemon-pairing.test.ts "pair.cancel IPC: cancels pending
    // and emits pair.cancelled" (begin.ok assertion doubles as the first half
    // of "pair.begin IPC: success path emits begin.ok + pair.completed" —
    // the completed half is not fabricable here, see the file-bottom note).
    #[tokio::test]
    async fn pair_cancel_from_owner_emits_pair_cancelled() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (runner, mut rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&runner, &pair_begin_msg(), None);

        let ok = recv_json(&mut rx).await;
        assert_eq!(ok["t"], "pair.begin.ok");
        assert_eq!(ok["daemonId"], "daemon-test");
        let pairing_id = ok["pairingId"].as_str().unwrap().to_string();
        assert!(daemon.has_pending_pairing().await);

        daemon.dispatcher.dispatch_ipc(
            &runner,
            &IpcMessage::PairCancel {
                pairing_id: pairing_id.clone(),
            },
            None,
        );

        let cancelled = recv_json(&mut rx).await;
        assert_eq!(cancelled["t"], "pair.cancelled");
        assert_eq!(cancelled["pairingId"], pairing_id.as_str());
        wait_until(|| daemon.pairing.owner.lock().unwrap().is_none()).await;
        assert!(!daemon.has_pending_pairing().await);
    }

    // Mirrors Bun: daemon-pairing.test.ts "pair.cancel from non-owner runner
    // is ignored".
    #[tokio::test]
    async fn pair_cancel_from_non_owner_is_ignored() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (owner, mut owner_rx) = ConnectedRunner::new_detached(None);
        let (intruder, _intruder_rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&owner, &pair_begin_msg(), None);
        let ok = recv_json(&mut owner_rx).await;
        let pairing_id = ok["pairingId"].as_str().unwrap().to_string();

        daemon.dispatcher.dispatch_ipc(
            &intruder,
            &IpcMessage::PairCancel {
                pairing_id: pairing_id.clone(),
            },
            None,
        );
        // Give the (would-be) cancel task a settle window, then confirm the
        // pending pairing survived the non-owner cancel.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            daemon.has_pending_pairing().await,
            "non-owner pair.cancel must be ignored"
        );
        assert_eq!(*daemon.pairing.owner.lock().unwrap(), Some(owner.id()));

        // The owner's cancel still works afterwards.
        daemon
            .dispatcher
            .dispatch_ipc(&owner, &IpcMessage::PairCancel { pairing_id }, None);
        let cancelled = recv_json(&mut owner_rx).await;
        assert_eq!(cancelled["t"], "pair.cancelled");
    }

    // Mirrors Bun: daemon-pairing.test.ts "pair.cancel with mismatched
    // pairingId does not cancel".
    #[tokio::test]
    async fn pair_cancel_with_mismatched_pairing_id_is_a_noop() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (runner, mut rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&runner, &pair_begin_msg(), None);
        let _ok = recv_json(&mut rx).await;

        daemon.dispatcher.dispatch_ipc(
            &runner,
            &IpcMessage::PairCancel {
                pairing_id: "totally-wrong-id".to_string(),
            },
            None,
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            daemon.has_pending_pairing().await,
            "mismatched pairingId must not cancel the pending pairing"
        );
        daemon.cancel_pending_pairing(None).await;
    }

    // Mirrors Bun: daemon-pairing.test.ts "pair.begin IPC: already-pending
    // emits begin.err".
    #[tokio::test]
    async fn second_pair_begin_gets_already_pending_err() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (first, mut first_rx) = ConnectedRunner::new_detached(None);
        let (second, mut second_rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&first, &pair_begin_msg(), None);
        let ok = recv_json(&mut first_rx).await;
        assert_eq!(ok["t"], "pair.begin.ok");

        daemon.dispatcher.dispatch_ipc(
            &second,
            &IpcMessage::PairBegin {
                relay_url: "wss://relay.example".to_string(),
                daemon_id: Some("daemon-second".to_string()),
                label: None,
            },
            None,
        );
        let err = recv_json(&mut second_rx).await;
        assert_eq!(err["t"], "pair.begin.err");
        assert_eq!(err["reason"], "already-pending");
        // Owner is still the first runner (daemon.ts only reassigns on a
        // successful begin).
        assert_eq!(*daemon.pairing.owner.lock().unwrap(), Some(first.id()));
        daemon.cancel_pending_pairing(None).await;
    }

    // Mirrors Bun: daemon-pairing.test.ts "CLI disconnect cancels pending
    // pairing owned by that CLI".
    #[tokio::test]
    async fn cli_disconnect_cancels_owned_pending_pairing() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (runner, mut rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&runner, &pair_begin_msg(), None);
        let _ok = recv_json(&mut rx).await;
        assert!(daemon.has_pending_pairing().await);

        daemon.dispatcher.handle_runner_disconnect(&runner);

        wait_until(|| daemon.pairing.owner.lock().unwrap().is_none()).await;
        // The cancel task runs async — wait for the slot to clear too.
        for _ in 0..400 {
            if !daemon.has_pending_pairing().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !daemon.has_pending_pairing().await,
            "owner disconnect must cancel the pending pairing"
        );
    }

    // Mirrors Bun (inverse arm of the same test): a NON-owner disconnect must
    // NOT cancel the pending pairing (daemon.ts:439-445 owner identity check).
    #[tokio::test]
    async fn unrelated_disconnect_leaves_pending_pairing_alone() {
        let (_dir, daemon) = temp_daemon();
        install_fake_factory(&daemon);
        let (owner, mut owner_rx) = ConnectedRunner::new_detached(None);
        let (bystander, _bystander_rx) = ConnectedRunner::new_detached(None);

        daemon
            .dispatcher
            .dispatch_ipc(&owner, &pair_begin_msg(), None);
        let _ok = recv_json(&mut owner_rx).await;

        daemon.dispatcher.handle_runner_disconnect(&bystander);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            daemon.has_pending_pairing().await,
            "a non-owner disconnect must not cancel the pending pairing"
        );
        assert_eq!(*daemon.pairing.owner.lock().unwrap(), Some(owner.id()));
        daemon.cancel_pending_pairing(None).await;
    }

    // NOTE (honest scope): the Bun success-path tests ("pair.begin IPC:
    // success path emits begin.ok + pair.completed", "CLI disconnect after
    // completion is a no-op", "promote failure emits pair.error and clears
    // pending slot") require simulating a frontend JOIN. The TS fake factory
    // returns a hand-rolled fake with a test hook that drives
    // `__markCompleted`; the Rust factory seam returns a concrete
    // `Arc<RelayClient>` and `build_relay_client_for_pairing` deliberately
    // drops the wrapped events on the factory path, so a join cannot be
    // fabricated from outside the pairing module. Completion/promote
    // mechanics are pinned by the orchestrator's own unit tests
    // (orchestrator.rs); the watcher's completed arm remains covered only by
    // code review — flagged in the increment report.
}
