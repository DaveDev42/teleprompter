//! IPC + relay-control command dispatcher — byte-faithful port of
//! `packages/daemon/src/ipc/command-dispatcher.ts` (ADR-0003 Phase 4,
//! increment 5).
//!
//! Two entry points, mirroring the TS class:
//!
//! - [`IpcCommandDispatcher::dispatch_ipc`] — typed IPC messages from a
//!   connected Runner/CLI (framed JSON over the Unix socket). Synchronous
//!   like the TS method; any relay fan-out it triggers is `tokio::spawn`ed
//!   (the TS equivalent: fire-and-forget promises queued behind the
//!   synchronous store/session mutations).
//! - [`IpcCommandDispatcher::dispatch_relay_control`] — decrypted control
//!   messages from a remote frontend (`control.unpair`/`control.rename` are
//!   intercepted earlier in `RelayClient::decrypt_and_dispatch` and never
//!   reach this handler, same as TS).
//!
//! Relay clients are reached through the object-safe [`RelayLink`] seam so
//! unit tests can capture publishes without a WebSocket; production wires
//! [`RelayClientLink`] over the real [`RelayClient`].
//!
//! Honest deviations from TS (edge-only, documented inline):
//! - TS lets `store.createSession`/`db.append` throws propagate to the IPC
//!   server's per-socket catch (socket close). The Rust store returns
//!   `Result`; the dispatcher logs and drops the frame instead of unwinding
//!   the accept task. No reply frame differs.
//! - `getRelayHealth` is sync in TS; the Rust `RelayClient` state getters are
//!   async, so the dep returns a boxed future the doctor.probe arm awaits.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde_json::{json, Map, Value};
use tp_proto::ipc::{
    AgeFilter, ByeReason, DoctorRelayStatus, IpcMessage, IpcPairRemoveErrReason,
    IpcPairRenameErrReason, IpcSessionDeleteErrReason, IpcSessionPruneErrReason, Namespace,
    RecordKind,
};
use tp_proto::label::Label;
use tp_proto::socket_path::assert_safe_sid;
use tp_proto::socket_path::sanitize_for_sid;

use crate::export_formatter::{format_markdown, ExportSessionMeta};
use crate::ipc::server::{ConnectedRunner, IpcServer};
use crate::push::notifier::{PushNotifier, RecordInfo};
use crate::session::manager::{SessionManager, SpawnRunnerOptions};
use crate::store::session_db::{RecordsFilter, StoredRecord};
use crate::store::store::Store;
use crate::transport::relay_client::RelayClient;
use crate::transport::relay_manager::{
    to_wire_session_meta, StorePushNotifierDeps, RELAY_CHANNEL_CONTROL, RELAY_CHANNEL_META,
};
use crate::worktree::manager::{WorktreeInfo, WorktreeManager};

/// Unified `NO_REPO` error message published when no `WorktreeManager` is
/// configured. Byte-exact with `NO_REPO_MESSAGE` (command-dispatcher.ts:60).
const NO_REPO_MESSAGE: &str = "No repository configured for worktree management";

/// Boxed `'static` future — the object-safe return type for [`RelayLink`]
/// methods and async dispatcher deps (clippy `type_complexity` is deny under
/// workspace `clippy::all`; the alias keeps signatures readable).
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// Object-safe seam over the relay-client surface the dispatcher touches.
///
/// The TS dispatcher takes concrete `RelayClient`s; the Rust `RelayClient`'s
/// publish methods are `async fn` on `&Arc<Self>` which cannot appear in a
/// dyn-safe trait directly, so this trait erases them behind [`BoxFuture`].
/// Production impl = [`RelayClientLink`]; tests capture into vectors.
pub trait RelayLink: Send + Sync {
    /// `relay.label` — the pairing label carried by the client config
    /// (`undefined`/`None` when the pairing has no label).
    fn label(&self) -> Option<Label>;
    /// `relay.peerPctB64(frontendId)` — pairing confirmation tag for the
    /// peer, absent for legacy pairings.
    fn peer_pct_b64(&self, frontend_id: &str) -> BoxFuture<Option<String>>;
    /// `relay.publishToPeer(frontendId, sid, msg)`.
    fn publish_to_peer(&self, frontend_id: &str, sid: &str, msg: Value) -> BoxFuture<()>;
    /// `relay.publishRecord(sessionRec)` (Rust client signature carries
    /// sid/seq explicitly).
    fn publish_record(&self, sid: &str, seq: u64, rec: Value) -> BoxFuture<()>;
    /// `relay.publishState(channel, stateMsg)`.
    fn publish_state(&self, channel: &str, msg: Value) -> BoxFuture<()>;
    /// `relay.publishRemoved(sid, removedMsg)`.
    fn publish_removed(&self, sid: &str, msg: Value) -> BoxFuture<()>;
    /// `relay.subscribe(sid)`.
    fn subscribe(&self, sid: &str) -> BoxFuture<()>;
    /// `relay.unsubscribe(sid)`.
    fn unsubscribe(&self, sid: &str) -> BoxFuture<()>;
}

/// Production [`RelayLink`] over a real [`RelayClient`].
pub struct RelayClientLink(pub Arc<RelayClient>);

impl RelayLink for RelayClientLink {
    fn label(&self) -> Option<Label> {
        self.0.label().cloned()
    }

    fn peer_pct_b64(&self, frontend_id: &str) -> BoxFuture<Option<String>> {
        let client = Arc::clone(&self.0);
        let frontend_id = frontend_id.to_string();
        Box::pin(async move { client.peer_pct_b64(&frontend_id).await })
    }

    fn publish_to_peer(&self, frontend_id: &str, sid: &str, msg: Value) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let frontend_id = frontend_id.to_string();
        let sid = sid.to_string();
        Box::pin(async move { client.publish_to_peer(&frontend_id, &sid, &msg).await })
    }

    fn publish_record(&self, sid: &str, seq: u64, rec: Value) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let sid = sid.to_string();
        Box::pin(async move { client.publish_record(&sid, seq, &rec).await })
    }

    fn publish_state(&self, channel: &str, msg: Value) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let channel = channel.to_string();
        Box::pin(async move { client.publish_state(&channel, &msg).await })
    }

    fn publish_removed(&self, sid: &str, msg: Value) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let sid = sid.to_string();
        Box::pin(async move { client.publish_removed(&sid, &msg).await })
    }

    fn subscribe(&self, sid: &str) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let sid = sid.to_string();
        Box::pin(async move { client.subscribe(&sid).await })
    }

    fn unsubscribe(&self, sid: &str) -> BoxFuture<()> {
        let client = Arc::clone(&self.0);
        let sid = sid.to_string();
        Box::pin(async move { client.unsubscribe(&sid).await })
    }
}

// ---------------------------------------------------------------------------
// Dependency fn aliases (clippy type_complexity is deny — named aliases,
// same pattern the inc2/inc3/inc4 modules use).
// ---------------------------------------------------------------------------

/// `getWorktreeManager()` — getter form so the dispatcher picks up a later
/// `setRepoRoot` without re-construction.
pub type GetWorktreeManagerFn = Arc<dyn Fn() -> Option<Arc<WorktreeManager>> + Send + Sync>;
/// `createSession(sid, cwd, opts)` — spawn a runner for `sid`. Errors become
/// the thrown `Error` the TS handlers catch (`Result::Err(message)` here).
pub type CreateSessionFn =
    Arc<dyn Fn(&str, &str, SpawnRunnerOptions) -> Result<(), String> + Send + Sync>;
/// `getRelayClients()` — getter so newly added relays are picked up per call.
pub type GetRelayClientsFn = Arc<dyn Fn() -> Vec<Arc<dyn RelayLink>> + Send + Sync>;
/// `getRelayHealth()` — relay status snapshots for `doctor.probe`. Async
/// (boxed) because the Rust `RelayClient` state getters are async.
pub type GetRelayHealthFn = Arc<dyn Fn() -> BoxFuture<Vec<DoctorRelayStatus>> + Send + Sync>;
/// `onRecord(sid, kind, payload, name)` — local record observer
/// (passthrough CLI pipes io records to stdout).
pub type OnRecordFn = Arc<dyn Fn(&str, RecordKind, &[u8], Option<&str>) + Send + Sync>;
/// `getOnRecord()` — getter because Daemon installs the observer after
/// dispatcher construction.
pub type GetOnRecordFn = Arc<dyn Fn() -> Option<OnRecordFn> + Send + Sync>;
/// `onPairBegin(runner, msg)` / `onPairCancel(runner, msg)` — pairing
/// lifecycle callbacks delegated to Daemon (which owns the IPC response
/// framing + `PairingOrchestrator` forwarding).
pub type PairMsgHandlerFn = Arc<dyn Fn(&Arc<ConnectedRunner>, &IpcMessage) + Send + Sync>;
/// `onCliDisconnect(runner)`.
pub type RunnerHandlerFn = Arc<dyn Fn(&Arc<ConnectedRunner>) + Send + Sync>;
/// `removePairing(daemonId) -> Promise<number>` (peers notified).
pub type RemovePairingFn = Arc<dyn Fn(String) -> BoxFuture<Result<u64, String>> + Send + Sync>;
/// `renamePairing(daemonId, label) -> Promise<number>` (peers notified).
pub type RenamePairingFn =
    Arc<dyn Fn(String, Label) -> BoxFuture<Result<u64, String>> + Send + Sync>;

/// Dependencies injected into [`IpcCommandDispatcher`]. Mirrors
/// `IpcCommandDispatcherDeps` (command-dispatcher.ts:71-111). All fields are
/// `pub` so the Daemon wiring (and tests) construct it directly.
pub struct IpcCommandDispatcherDeps {
    pub ipc_server: Arc<IpcServer>,
    pub store: Arc<Mutex<Store>>,
    pub session_manager: Arc<SessionManager>,
    pub push_notifier: Arc<Mutex<PushNotifier<StorePushNotifierDeps>>>,
    pub get_worktree_manager: GetWorktreeManagerFn,
    pub create_session: CreateSessionFn,
    pub on_pair_begin: PairMsgHandlerFn,
    pub on_pair_cancel: PairMsgHandlerFn,
    pub on_cli_disconnect: RunnerHandlerFn,
    pub remove_pairing: RemovePairingFn,
    pub rename_pairing: RenamePairingFn,
    pub get_on_record: GetOnRecordFn,
    pub get_relay_clients: GetRelayClientsFn,
    pub get_relay_health: GetRelayHealthFn,
}

/// `Date.now()` in epoch milliseconds.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(0))
        .unwrap_or(0)
}

/// `Number.prototype.toString(36)` for a non-negative integer — used for the
/// auto-generated `session-<base36ts>` sid and the worktree `<branch>-<ts>`
/// suffix, byte-exact with `Date.now().toString(36)`.
fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Wire string for a [`RecordKind`] (`"io" | "event" | "meta"`).
fn record_kind_str(kind: RecordKind) -> &'static str {
    match kind {
        RecordKind::Io => "io",
        RecordKind::Event => "event",
        RecordKind::Meta => "meta",
    }
}

/// Wire string for a [`Namespace`].
fn namespace_str(ns: Namespace) -> &'static str {
    match ns {
        Namespace::Claude => "claude",
        Namespace::Tp => "tp",
        Namespace::Runner => "runner",
        Namespace::Daemon => "daemon",
    }
}

/// `toNamespace` (command-dispatcher.ts:1311-1315): a stored `ns` column
/// value maps to a wire namespace only when it is one of the known four.
fn to_namespace(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("claude") => Some("claude"),
        Some("tp") => Some("tp"),
        Some("runner") => Some("runner"),
        Some("daemon") => Some("daemon"),
        _ => None,
    }
}

/// The wire tag (`t`) of an [`IpcMessage`] — used for the
/// "ignoring unexpected IPC message" log arm (command-dispatcher.ts:192-208).
fn ipc_tag(msg: &IpcMessage) -> &'static str {
    match msg {
        IpcMessage::Hello { .. } => "hello",
        IpcMessage::Rec { .. } => "rec",
        IpcMessage::Bye { .. } => "bye",
        IpcMessage::Ack { .. } => "ack",
        IpcMessage::Input { .. } => "input",
        IpcMessage::Resize { .. } => "resize",
        IpcMessage::PairBegin { .. } => "pair.begin",
        IpcMessage::PairBeginOk { .. } => "pair.begin.ok",
        IpcMessage::PairBeginErr { .. } => "pair.begin.err",
        IpcMessage::PairCancel { .. } => "pair.cancel",
        IpcMessage::PairCompleted { .. } => "pair.completed",
        IpcMessage::PairCancelled { .. } => "pair.cancelled",
        IpcMessage::PairError { .. } => "pair.error",
        IpcMessage::PairRemove { .. } => "pair.remove",
        IpcMessage::PairRemoveOk { .. } => "pair.remove.ok",
        IpcMessage::PairRemoveErr { .. } => "pair.remove.err",
        IpcMessage::PairRename { .. } => "pair.rename",
        IpcMessage::PairRenameOk { .. } => "pair.rename.ok",
        IpcMessage::PairRenameErr { .. } => "pair.rename.err",
        IpcMessage::SessionDelete { .. } => "session.delete",
        IpcMessage::SessionDeleteOk { .. } => "session.delete.ok",
        IpcMessage::SessionDeleteErr { .. } => "session.delete.err",
        IpcMessage::SessionPrune { .. } => "session.prune",
        IpcMessage::SessionPruneOk { .. } => "session.prune.ok",
        IpcMessage::SessionPruneErr { .. } => "session.prune.err",
        IpcMessage::DoctorProbe => "doctor.probe",
        IpcMessage::DoctorProbeOk { .. } => "doctor.probe.ok",
    }
}

/// Serialize + frame-send one IPC reply. TS `this.deps.ipcServer.send(...)`
/// (return value ignored at every dispatcher call site, same here).
fn send_ipc(runner: &ConnectedRunner, msg: &IpcMessage) {
    match serde_json::to_vec(msg) {
        Ok(bytes) => {
            let _ = IpcServer::send(runner, &bytes, None);
        }
        Err(e) => eprintln!("[IpcDispatcher] failed to serialize IPC reply: {e}"),
    }
}

/// Routes IPC messages (Runner → Daemon) and relay control messages
/// (Frontend → Relay → Daemon) to their handlers. Pure router: no transport
/// I/O of its own, no state beyond injected collaborators.
pub struct IpcCommandDispatcher {
    deps: IpcCommandDispatcherDeps,
}

impl IpcCommandDispatcher {
    #[must_use]
    pub fn new(deps: IpcCommandDispatcherDeps) -> Arc<Self> {
        Arc::new(IpcCommandDispatcher { deps })
    }

    // -----------------------------------------------------------------
    // IPC entry (Runner/CLI → Daemon)
    // -----------------------------------------------------------------

    /// Dispatch a typed IPC message from a connected runner. Mirrors
    /// `dispatchIpc` (command-dispatcher.ts:133-217).
    pub fn dispatch_ipc(
        self: &Arc<Self>,
        runner: &Arc<ConnectedRunner>,
        msg: &IpcMessage,
        binary: Option<Vec<u8>>,
    ) {
        match msg {
            IpcMessage::PairBegin { .. } => (self.deps.on_pair_begin)(runner, msg),
            IpcMessage::PairCancel { .. } => (self.deps.on_pair_cancel)(runner, msg),
            IpcMessage::PairRemove { daemon_id } => self.handle_pair_remove(runner, daemon_id),
            IpcMessage::PairRename { daemon_id, label } => {
                self.handle_pair_rename(runner, daemon_id, label.clone());
            }
            IpcMessage::SessionDelete { sid } => self.handle_session_delete(runner, sid),
            IpcMessage::SessionPrune {
                age,
                include_running,
                dry_run,
            } => self.handle_session_prune(runner, age, *include_running, *dry_run),
            IpcMessage::DoctorProbe => self.handle_doctor_probe(runner),
            IpcMessage::Hello {
                sid,
                cwd,
                worktree_path,
                claude_version,
                pid,
            } => self.handle_hello(
                sid,
                cwd,
                worktree_path.as_deref(),
                claude_version.as_deref(),
                *pid,
            ),
            IpcMessage::Rec { .. } => self.handle_rec(runner, msg, binary),
            IpcMessage::Bye {
                sid,
                exit_code,
                pid,
                reason,
            } => self.handle_bye(sid, *exit_code, *pid, *reason),
            // CLI→Daemon passthrough: forward input/resize to the runner for
            // the given sid (service-daemon routing path).
            IpcMessage::Input { sid, .. } | IpcMessage::Resize { sid, .. } => {
                if let Some(target) = self.deps.ipc_server.find_runner_by_sid(sid) {
                    send_ipc(&target, msg);
                }
            }
            // Daemon→runner messages echoed back by a misbehaving runner:
            // harmless — log and move on (command-dispatcher.ts:192-208).
            other => {
                eprintln!(
                    "[IpcDispatcher] ignoring unexpected IPC message from runner: {}",
                    ipc_tag(other)
                );
            }
        }
    }

    /// Called by the Daemon when an IPC socket closes — forwards to the
    /// pairing orchestrator callback (command-dispatcher.ts:456-458).
    pub fn handle_runner_disconnect(&self, runner: &Arc<ConnectedRunner>) {
        (self.deps.on_cli_disconnect)(runner);
    }

    /// Shared guard: verify a pairing with `daemon_id` is registered; send
    /// the not-found error frame and return `false` when absent
    /// (`guardPairingExists`, command-dispatcher.ts:223-232).
    fn guard_pairing_exists(
        &self,
        runner: &ConnectedRunner,
        daemon_id: &str,
        not_found: &IpcMessage,
    ) -> bool {
        let exists = {
            let store = self.deps.store.lock().unwrap();
            store
                .list_pairings()
                .unwrap_or_default()
                .iter()
                .any(|p| p.daemon_id == daemon_id)
        };
        if exists {
            return true;
        }
        send_ipc(runner, not_found);
        false
    }

    fn handle_pair_remove(self: &Arc<Self>, runner: &Arc<ConnectedRunner>, daemon_id: &str) {
        if !self.guard_pairing_exists(
            runner,
            daemon_id,
            &IpcMessage::PairRemoveErr {
                daemon_id: daemon_id.to_string(),
                reason: IpcPairRemoveErrReason::NotFound,
                message: None,
            },
        ) {
            return;
        }
        let fut = (self.deps.remove_pairing)(daemon_id.to_string());
        let runner = Arc::clone(runner);
        let daemon_id = daemon_id.to_string();
        tokio::spawn(async move {
            match fut.await {
                Ok(notified) => send_ipc(
                    &runner,
                    &IpcMessage::PairRemoveOk {
                        daemon_id,
                        notified_peers: notified,
                    },
                ),
                Err(e) => send_ipc(
                    &runner,
                    &IpcMessage::PairRemoveErr {
                        daemon_id,
                        reason: IpcPairRemoveErrReason::Internal,
                        message: Some(e),
                    },
                ),
            }
        });
    }

    fn handle_pair_rename(
        self: &Arc<Self>,
        runner: &Arc<ConnectedRunner>,
        daemon_id: &str,
        label: Label,
    ) {
        if !self.guard_pairing_exists(
            runner,
            daemon_id,
            &IpcMessage::PairRenameErr {
                daemon_id: daemon_id.to_string(),
                reason: IpcPairRenameErrReason::NotFound,
                message: None,
            },
        ) {
            return;
        }
        let fut = (self.deps.rename_pairing)(daemon_id.to_string(), label.clone());
        let runner = Arc::clone(runner);
        let daemon_id = daemon_id.to_string();
        tokio::spawn(async move {
            match fut.await {
                Ok(notified) => send_ipc(
                    &runner,
                    &IpcMessage::PairRenameOk {
                        daemon_id,
                        label,
                        notified_peers: notified,
                    },
                ),
                Err(e) => send_ipc(
                    &runner,
                    &IpcMessage::PairRenameErr {
                        daemon_id,
                        reason: IpcPairRenameErrReason::Internal,
                        message: Some(e),
                    },
                ),
            }
        });
    }

    /// Delete a single session (`handleSessionDelete`,
    /// command-dispatcher.ts:303-358). Kill→unregister→delete, broadcast
    /// `session.removed` BEFORE unsubscribing, then reply ok.
    fn handle_session_delete(self: &Arc<Self>, runner: &Arc<ConnectedRunner>, sid: &str) {
        let meta = {
            let store = self.deps.store.lock().unwrap();
            store.get_session(sid).ok().flatten()
        };
        let Some(meta) = meta else {
            send_ipc(
                runner,
                &IpcMessage::SessionDeleteErr {
                    sid: sid.to_string(),
                    reason: IpcSessionDeleteErrReason::NotFound,
                    message: None,
                },
            );
            return;
        };
        let was_running = meta.state == "running";
        if was_running {
            // killRunner only signals; unregister synchronously so
            // activeCount/listRunners stay consistent with the row delete.
            self.deps.session_manager.kill_runner(sid);
            self.deps.session_manager.unregister_runner(sid);
        }
        let deleted = {
            let mut store = self.deps.store.lock().unwrap();
            store.delete_session(sid)
        };
        if let Err(e) = deleted {
            send_ipc(
                runner,
                &IpcMessage::SessionDeleteErr {
                    sid: sid.to_string(),
                    reason: IpcSessionDeleteErrReason::Internal,
                    message: Some(e.to_string()),
                },
            );
            return;
        }
        // Notify any attached frontend BEFORE unsubscribing — unsubscribing
        // first would publish on a sid the relay no longer forwards. Mirrors
        // Bun test "session.delete unsubscribes the deleted sid from every
        // relay client (rank 8)" ordering (command-dispatcher.test.ts).
        let this = Arc::clone(self);
        let links = (self.deps.get_relay_clients)();
        let sid_owned = sid.to_string();
        tokio::spawn(async move {
            this.broadcast_session_removed(&sid_owned).await;
            for link in &links {
                link.unsubscribe(&sid_owned).await;
            }
        });
        send_ipc(
            runner,
            &IpcMessage::SessionDeleteOk {
                sid: sid.to_string(),
                was_running,
            },
        );
    }

    /// Prune sessions matching the filter (`handleSessionPrune`,
    /// command-dispatcher.ts:367-437).
    fn handle_session_prune(
        self: &Arc<Self>,
        runner: &Arc<ConnectedRunner>,
        age: &AgeFilter,
        include_running: bool,
        dry_run: bool,
    ) {
        let now = now_ms();
        let cutoff_ms: Option<i64> = match age {
            AgeFilter::OlderThan { ms } => Some(now.saturating_sub(*ms) as i64),
            AgeFilter::All => None,
        };

        let candidates: Vec<_> = {
            let store = self.deps.store.lock().unwrap();
            store
                .list_sessions()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| {
                    if s.state == "running" && !include_running {
                        return false;
                    }
                    match cutoff_ms {
                        None => true,
                        Some(cutoff) => s.updated_at < cutoff,
                    }
                })
                .collect()
        };

        if dry_run {
            send_ipc(
                runner,
                &IpcMessage::SessionPruneOk {
                    sids: candidates.iter().map(|s| s.sid.clone()).collect(),
                    running_killed: 0,
                    dry_run: true,
                },
            );
            return;
        }

        let mut deleted: Vec<String> = Vec::new();
        let mut running_killed: u64 = 0;
        for s in &candidates {
            if s.state == "running" {
                self.deps.session_manager.kill_runner(&s.sid);
                // Same as handle_session_delete: drop the in-memory
                // registration synchronously (store row goes away next line).
                self.deps.session_manager.unregister_runner(&s.sid);
                running_killed += 1;
            }
            let result = {
                let mut store = self.deps.store.lock().unwrap();
                store.delete_session(&s.sid)
            };
            if let Err(e) = result {
                // Partial state: rows in `deleted` are already gone; report
                // them so the CLI can render "deleted N/M then errored".
                send_ipc(
                    runner,
                    &IpcMessage::SessionPruneErr {
                        reason: IpcSessionPruneErrReason::Internal,
                        message: Some(e.to_string()),
                        partial_sids: deleted.clone(),
                        partial_running_killed: running_killed,
                    },
                );
                return;
            }
            // Notify attached frontends BEFORE unsubscribing — same ordering
            // rationale as handle_session_delete.
            let this = Arc::clone(self);
            let links = (self.deps.get_relay_clients)();
            let sid = s.sid.clone();
            tokio::spawn(async move {
                this.broadcast_session_removed(&sid).await;
                for link in &links {
                    link.unsubscribe(&sid).await;
                }
            });
            deleted.push(s.sid.clone());
        }

        send_ipc(
            runner,
            &IpcMessage::SessionPruneOk {
                sids: deleted,
                running_killed,
                dry_run: false,
            },
        );
    }

    /// `doctor.probe` → collect relay health from live clients and reply
    /// `doctor.probe.ok` (`handleDoctorProbe`, command-dispatcher.ts:445-449).
    fn handle_doctor_probe(&self, runner: &Arc<ConnectedRunner>) {
        let fut = (self.deps.get_relay_health)();
        let runner = Arc::clone(runner);
        tokio::spawn(async move {
            let relays = fut.await;
            send_ipc(&runner, &IpcMessage::DoctorProbeOk { relays });
        });
    }

    /// `handleHello` (command-dispatcher.ts:797-820).
    fn handle_hello(
        self: &Arc<Self>,
        sid: &str,
        cwd: &str,
        worktree_path: Option<&str>,
        claude_version: Option<&str>,
        pid: u64,
    ) {
        {
            let mut store = self.deps.store.lock().unwrap();
            if let Err(e) = store.create_session(sid, cwd, worktree_path, claude_version) {
                // TS lets this throw unwind to the IPC server's per-socket
                // catch (socket closed). We log and drop the hello — no
                // registration, no subscribe, no broadcast.
                eprintln!("[IpcDispatcher] hello: createSession failed for sid={sid}: {e}");
                return;
            }
        }
        self.deps.session_manager.register_runner(
            sid,
            u32::try_from(pid).unwrap_or(u32::MAX),
            cwd,
            worktree_path.map(str::to_string),
            claude_version.map(str::to_string),
        );
        eprintln!("[IpcDispatcher] session created sid={sid}");

        // Subscribe relay clients to the new session, then broadcast state
        // (async fan-out; TS queues the same promises behind the sync body).
        let this = Arc::clone(self);
        let links = (self.deps.get_relay_clients)();
        let sid = sid.to_string();
        tokio::spawn(async move {
            for link in &links {
                link.subscribe(&sid).await;
            }
            this.broadcast_session_state(&sid).await;
        });
    }

    /// `handleRec` (command-dispatcher.ts:822-902).
    fn handle_rec(
        self: &Arc<Self>,
        runner: &Arc<ConnectedRunner>,
        msg: &IpcMessage,
        binary: Option<Vec<u8>>,
    ) {
        let IpcMessage::Rec {
            sid,
            kind,
            ts,
            ns,
            name,
            payload,
        } = msg
        else {
            return;
        };

        // Runner sends payload either base64 in `payload` (event/meta) or as
        // the frame's binary sidecar (io — raw PTY bytes, no base64).
        let (payload_bytes, ws_payload): (Vec<u8>, String) = match binary {
            Some(bytes) => {
                let b64 = BASE64_STANDARD.encode(&bytes);
                (bytes, b64)
            }
            None => (
                BASE64_STANDARD
                    .decode(payload.as_bytes())
                    .unwrap_or_default(),
                payload.clone(),
            ),
        };

        let seq = {
            let mut store = self.deps.store.lock().unwrap();
            let appended = {
                let Some(db) = store.get_session_db(sid) else {
                    eprintln!("[IpcDispatcher] unknown session sid={sid}");
                    return;
                };
                db.append(
                    record_kind_str(*kind),
                    *ts as i64,
                    &payload_bytes,
                    ns.map(namespace_str),
                    name.as_deref(),
                )
            };
            let seq = match appended {
                Ok(seq) => seq,
                Err(e) => {
                    // TS lets the append throw unwind (socket close); log+drop.
                    eprintln!("[IpcDispatcher] rec append failed for sid={sid}: {e}");
                    return;
                }
            };
            if let Err(e) = store.update_last_seq(sid, seq) {
                eprintln!("[IpcDispatcher] updateLastSeq failed for sid={sid}: {e}");
            }
            seq
        };

        // Ack (informational, non-blocking).
        send_ipc(
            runner,
            &IpcMessage::Ack {
                sid: sid.clone(),
                seq: u64::try_from(seq).unwrap_or(0),
            },
        );

        // Publish to relay(s). WS payloads are base64 text; `ns`/`n` are
        // omitted when absent (TS `undefined` fields drop at stringify).
        let mut rec = Map::new();
        rec.insert("t".to_string(), json!("rec"));
        rec.insert("sid".to_string(), json!(sid));
        rec.insert("seq".to_string(), json!(seq));
        rec.insert("k".to_string(), json!(record_kind_str(*kind)));
        if let Some(ns) = ns {
            rec.insert("ns".to_string(), json!(namespace_str(*ns)));
        }
        if let Some(name) = name {
            rec.insert("n".to_string(), json!(name));
        }
        rec.insert("d".to_string(), json!(ws_payload));
        rec.insert("ts".to_string(), json!(ts));
        let rec_msg = Value::Object(rec);
        let links = (self.deps.get_relay_clients)();
        let sid_owned = sid.clone();
        let seq_u = u64::try_from(seq).unwrap_or(0);
        tokio::spawn(async move {
            for link in &links {
                link.publish_record(&sid_owned, seq_u, rec_msg.clone())
                    .await;
            }
        });

        // Local observer (passthrough CLI).
        if let Some(on_record) = (self.deps.get_on_record)() {
            on_record(sid, *kind, &payload_bytes, name.as_deref());
        }

        // Push-notification gate. Parse defensively; non-event kinds skip
        // (PushNotifier short-circuits on kind != event anyway). TS accepts
        // only a non-null, non-array object (command-dispatcher.ts:886).
        let parsed_payload: Option<Value> =
            if *kind == RecordKind::Event && !payload_bytes.is_empty() {
                serde_json::from_slice::<Value>(&payload_bytes)
                    .ok()
                    .filter(Value::is_object)
            } else {
                None
            };
        // NOTE: the TS RecordInfo also carries `ns`; the Rust inc4
        // `RecordInfo` omits it (PushNotifier never reads it) — flagged in
        // the increment-5 report rather than extending the surface.
        self.deps
            .push_notifier
            .lock()
            .unwrap()
            .on_record(&RecordInfo {
                sid,
                kind: *kind,
                name: name.as_deref(),
                payload: parsed_payload.as_ref(),
            });
    }

    /// `handleBye` (command-dispatcher.ts:904-948) — stale-generation pid
    /// guard + `reason:"signal"` → always `"stopped"`.
    fn handle_bye(
        self: &Arc<Self>,
        sid: &str,
        exit_code: f64,
        pid: Option<u64>,
        reason: Option<ByeReason>,
    ) {
        // Generation guard: a bye carrying a pid that does not match the
        // currently-registered Runner is from a stale generation (the old
        // runner of a `session.restart`) and must be ignored. Mirrors Bun
        // test "stale bye from the old runner does not corrupt a restarted
        // session" (command-dispatcher.test.ts).
        if let Some(bye_pid) = pid {
            if let Some(current) = self.deps.session_manager.get_runner(sid) {
                if u64::from(current.pid) != bye_pid {
                    eprintln!(
                        "[IpcDispatcher] ignoring stale bye sid={sid} from old runner pid={bye_pid} (current pid={})",
                        current.pid
                    );
                    return;
                }
            }
        }

        // `reason:"signal"` = stop triggered by something other than
        // claude's own exit (synthetic exitCode 130/143/-1) → always
        // "stopped". Only "exit"/absent trusts exitCode (0 → stopped,
        // non-zero → error). Same truth table as the TS ternary chain.
        let state = if reason == Some(ByeReason::Signal) || exit_code == 0.0 {
            "stopped"
        } else {
            "error"
        };
        {
            let store = self.deps.store.lock().unwrap();
            if let Err(e) = store.update_session_state(sid, state) {
                eprintln!("[IpcDispatcher] updateSessionState failed for sid={sid}: {e}");
            }
        }
        self.deps.session_manager.unregister_runner(sid);
        eprintln!(
            "[IpcDispatcher] session ended sid={sid} exitCode={exit_code} reason={} state={state}",
            reason.map_or("(none)", |r| match r {
                ByeReason::Signal => "signal",
                ByeReason::Exit => "exit",
            })
        );

        let this = Arc::clone(self);
        let sid = sid.to_string();
        tokio::spawn(async move {
            this.broadcast_session_state(&sid).await;
        });
    }

    // -----------------------------------------------------------------
    // Shared relay broadcasts
    // -----------------------------------------------------------------

    /// Fan-out a session-state update to all connected relay clients
    /// (`broadcastSessionState`, command-dispatcher.ts:763-774). Public:
    /// Daemon's `set_on_runner_exit` crash/kill-path callback calls it
    /// directly. Publishes on [`RELAY_CHANNEL_META`], NOT the sid.
    pub async fn broadcast_session_state(&self, sid: &str) {
        let meta = {
            let store = self.deps.store.lock().unwrap();
            store.get_session(sid).ok().flatten()
        };
        let Some(meta) = meta else { return };
        let state_msg = json!({
            "t": "state",
            "sid": sid,
            "d": to_wire_session_meta(&meta),
        });
        for link in (self.deps.get_relay_clients)() {
            link.publish_state(RELAY_CHANNEL_META, state_msg.clone())
                .await;
        }
    }

    /// Fan-out `session.removed` so an attached frontend learns immediately
    /// (`broadcastSessionRemoved`, command-dispatcher.ts:787-795). Called
    /// BEFORE the relay clients unsubscribe from `sid`.
    async fn broadcast_session_removed(&self, sid: &str) {
        let removed_msg = json!({ "t": "session.removed", "sid": sid });
        for link in (self.deps.get_relay_clients)() {
            link.publish_removed(sid, removed_msg.clone()).await;
        }
    }

    // -----------------------------------------------------------------
    // Relay control entry (Frontend → Relay → Daemon)
    // -----------------------------------------------------------------

    /// Dispatch a decrypted relay control message (`dispatchRelayControl`,
    /// command-dispatcher.ts:467-684). `control.unpair`/`control.rename`
    /// never reach here (intercepted in the relay client).
    pub async fn dispatch_relay_control(
        self: &Arc<Self>,
        relay: &Arc<dyn RelayLink>,
        msg: &Value,
        frontend_id: &str,
    ) {
        let t = msg.get("t").and_then(Value::as_str).unwrap_or("");
        let sid_of = |m: &Value| {
            m.get("sid")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        match t {
            "hello" => {
                let sessions: Vec<Value> = {
                    let store = self.deps.store.lock().unwrap();
                    store
                        .list_sessions()
                        .unwrap_or_default()
                        .iter()
                        .map(to_wire_session_meta)
                        .collect()
                };
                // `daemonLabel` omitted when the pairing has no label
                // (keep-current surface, decodeKxLabelOrKeep). `pct` mirrors
                // the auto-hello in relay-manager's on_frontend_joined.
                let daemon_label = relay.label();
                let pct_b64 = relay.peer_pct_b64(frontend_id).await;
                let mut d = Map::new();
                d.insert("sessions".to_string(), Value::Array(sessions));
                if let Some(label) = daemon_label {
                    d.insert(
                        "daemonLabel".to_string(),
                        serde_json::to_value(&label).unwrap_or(Value::Null),
                    );
                }
                if let Some(pct) = pct_b64 {
                    d.insert("pct".to_string(), Value::String(pct));
                }
                self.reply(
                    relay,
                    frontend_id,
                    RELAY_CHANNEL_META,
                    json!({ "t": "hello", "v": 1, "d": Value::Object(d) }),
                )
                .await;
            }

            "attach" => {
                let sid = sid_of(msg);
                let meta = {
                    let store = self.deps.store.lock().unwrap();
                    store.get_session(&sid).ok().flatten()
                };
                match meta {
                    Some(meta) => {
                        self.reply(
                            relay,
                            frontend_id,
                            &sid,
                            json!({ "t": "state", "sid": sid, "d": to_wire_session_meta(&meta) }),
                        )
                        .await;
                    }
                    None => {
                        self.reply_error(
                            relay,
                            frontend_id,
                            &sid,
                            "NOT_FOUND",
                            &format!("Session {sid} not found"),
                        )
                        .await;
                    }
                }
            }

            // No response needed for detach via relay.
            "detach" => {}

            "resume" => {
                let sid = sid_of(msg);
                let cursor = msg.get("c").and_then(Value::as_i64).unwrap_or(0);
                self.handle_relay_resume(relay, frontend_id, &sid, cursor)
                    .await;
            }

            "resize" => {
                let sid = sid_of(msg);
                let cols = msg.get("cols").and_then(Value::as_u64).unwrap_or(0);
                let rows = msg.get("rows").and_then(Value::as_u64).unwrap_or(0);
                if let Some(target) = self.deps.ipc_server.find_runner_by_sid(&sid) {
                    send_ipc(
                        &target,
                        &IpcMessage::Resize {
                            sid: sid.clone(),
                            cols,
                            rows,
                        },
                    );
                } else {
                    // No live runner: NACK so the frontend doesn't believe
                    // the resize landed (mirrors session.stop's no-runner NACK).
                    self.reply_error(
                        relay,
                        frontend_id,
                        &sid,
                        "NO_RUNNER",
                        &format!("No runner for session {sid}"),
                    )
                    .await;
                }
            }

            "ping" => {
                self.reply(
                    relay,
                    frontend_id,
                    RELAY_CHANNEL_CONTROL,
                    json!({ "t": "pong" }),
                )
                .await;
            }

            "session.create" => {
                let sid = msg.get("sid").and_then(Value::as_str).map_or_else(
                    || format!("session-{}", to_base36(now_ms())),
                    str::to_string,
                );
                let cwd = msg.get("cwd").and_then(Value::as_str).unwrap_or("");
                let cols = msg
                    .get("cols")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok());
                let rows = msg
                    .get("rows")
                    .and_then(Value::as_u64)
                    .and_then(|v| u32::try_from(v).ok());
                // Frontend-supplied sid reaches Store's
                // `join(storeDir, "sessions", sid + ".sqlite")` — validate
                // BEFORE createSession/subscribe so a crafted `../../evil`
                // is a clean SESSION_ERROR with zero side-effects. Mirrors
                // Bun test "session.create with a path-traversal sid is
                // rejected BEFORE createSession/subscribe (rank 3)".
                let result = assert_safe_sid(&sid).and_then(|()| {
                    (self.deps.create_session)(
                        &sid,
                        cwd,
                        SpawnRunnerOptions {
                            cols,
                            rows,
                            ..SpawnRunnerOptions::default()
                        },
                    )
                });
                match result {
                    Ok(()) => {
                        // Subscribe every relay client IMMEDIATELY, before
                        // the runner's hello round-trips — closes the race
                        // window where early input frames would be dropped.
                        for link in (self.deps.get_relay_clients)() {
                            link.subscribe(&sid).await;
                        }
                        self.reply(
                            relay,
                            frontend_id,
                            &sid,
                            json!({ "t": "session.create.ok", "sid": sid }),
                        )
                        .await;
                    }
                    Err(message) => {
                        let m = if message.is_empty() {
                            "Failed to create session".to_string()
                        } else {
                            message
                        };
                        self.reply_error(relay, frontend_id, &sid, "SESSION_ERROR", &m)
                            .await;
                    }
                }
            }

            "session.stop" => {
                let sid = sid_of(msg);
                if !self.deps.session_manager.kill_runner(&sid) {
                    self.reply_error(
                        relay,
                        frontend_id,
                        &sid,
                        "NO_RUNNER",
                        &format!("No runner for session {sid}"),
                    )
                    .await;
                }
            }

            "session.restart" => {
                let sid = sid_of(msg);
                self.handle_relay_session_restart(relay, frontend_id, &sid)
                    .await;
            }

            "session.delete" => {
                // Relay-plane sibling of the IPC session.delete: same
                // kill→unregister→delete semantics, broadcast BEFORE
                // unsubscribe, then reply ok/err to the frontend.
                let sid = sid_of(msg);
                let meta = {
                    let store = self.deps.store.lock().unwrap();
                    store.get_session(&sid).ok().flatten()
                };
                let Some(meta) = meta else {
                    self.reply(
                        relay,
                        frontend_id,
                        &sid,
                        json!({ "t": "session.delete.err", "sid": sid, "reason": "not-found" }),
                    )
                    .await;
                    return;
                };
                let was_running = meta.state == "running";
                if was_running {
                    self.deps.session_manager.kill_runner(&sid);
                    self.deps.session_manager.unregister_runner(&sid);
                }
                let deleted = {
                    let mut store = self.deps.store.lock().unwrap();
                    store.delete_session(&sid)
                };
                if let Err(e) = deleted {
                    self.reply(
                        relay,
                        frontend_id,
                        &sid,
                        json!({
                            "t": "session.delete.err",
                            "sid": sid,
                            "reason": "internal",
                            "message": e.to_string(),
                        }),
                    )
                    .await;
                    return;
                }
                self.broadcast_session_removed(&sid).await;
                for link in (self.deps.get_relay_clients)() {
                    link.unsubscribe(&sid).await;
                }
                self.reply(
                    relay,
                    frontend_id,
                    &sid,
                    json!({ "t": "session.delete.ok", "sid": sid, "wasRunning": was_running }),
                )
                .await;
            }

            "session.export" => {
                self.handle_relay_session_export(relay, frontend_id, msg)
                    .await;
            }

            "worktree.list" => {
                self.handle_relay_worktree_list(relay, frontend_id).await;
            }

            "worktree.create" => {
                let branch = msg
                    .get("branch")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let base_branch = msg
                    .get("baseBranch")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let path = msg.get("path").and_then(Value::as_str).map(str::to_string);
                self.handle_relay_worktree_create(
                    relay,
                    frontend_id,
                    &branch,
                    base_branch.as_deref(),
                    path.as_deref(),
                )
                .await;
            }

            "worktree.remove" => {
                let path = msg
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let force = msg.get("force").and_then(Value::as_bool).unwrap_or(false);
                self.handle_relay_worktree_remove(relay, frontend_id, &path, force)
                    .await;
            }

            // TS has an exhaustive typed union here; unknown tags cannot
            // occur post-guard. Values reaching the Rust seam are already
            // guard-validated upstream — ignore anything else.
            _ => {}
        }
    }

    async fn reply(&self, relay: &Arc<dyn RelayLink>, frontend_id: &str, sid: &str, msg: Value) {
        relay.publish_to_peer(frontend_id, sid, msg).await;
    }

    async fn reply_error(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        sid: &str,
        e: &str,
        m: &str,
    ) {
        self.reply(
            relay,
            frontend_id,
            sid,
            json!({ "t": "err", "e": e, "m": m }),
        )
        .await;
    }

    /// `session.restart` (`handleRelaySessionRestart`,
    /// command-dispatcher.ts:707-745): kill → **await exit** → unregister →
    /// respawn; refuses a passthrough/registered-only runner.
    async fn handle_relay_session_restart(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        sid: &str,
    ) {
        let session = {
            let store = self.deps.store.lock().unwrap();
            store.get_session(sid).ok().flatten()
        };
        let Some(session) = session else {
            self.reply_error(
                relay,
                frontend_id,
                sid,
                "NOT_FOUND",
                &format!("Session {sid} not found"),
            )
            .await;
            return;
        };

        // A registered-only runner (no tracked process) cannot be signalled
        // — refuse rather than double-spawn. Mirrors Bun test
        // "session.restart refuses a passthrough/registered-only session
        // (no process handle)" (command-dispatcher.test.ts).
        let runner = self.deps.session_manager.get_runner(sid);
        if let Some(runner) = runner {
            if runner.process.is_none() {
                self.reply_error(
                    relay,
                    frontend_id,
                    sid,
                    "SESSION_ERROR",
                    &format!(
                        "Cannot restart session {sid}: it is not managed by this daemon \
                         (passthrough/registered-only) and cannot be safely killed before \
                         respawning."
                    ),
                )
                .await;
                return;
            }
        }

        self.deps.session_manager.kill_runner(sid);
        self.deps.session_manager.wait_for_exit(sid).await;
        self.deps.session_manager.unregister_runner(sid);

        let spawn_result = (self.deps.create_session)(
            sid,
            &session.cwd,
            SpawnRunnerOptions {
                worktree_path: session.worktree_path.clone(),
                ..SpawnRunnerOptions::default()
            },
        );
        match spawn_result {
            Ok(()) => eprintln!("[IpcDispatcher] restarted session {sid} via relay"),
            Err(message) => {
                let m = if message.is_empty() {
                    "Failed to restart session".to_string()
                } else {
                    message
                };
                self.reply_error(relay, frontend_id, sid, "SESSION_ERROR", &m)
                    .await;
            }
        }
    }

    /// `handleRelayResume` (command-dispatcher.ts:954-978).
    async fn handle_relay_resume(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        sid: &str,
        cursor: i64,
    ) {
        let records = {
            let mut store = self.deps.store.lock().unwrap();
            store
                .get_session_db(sid)
                .map(|db| db.get_records_from(cursor, 1000).unwrap_or_default())
        };
        let Some(records) = records else {
            self.reply_error(
                relay,
                frontend_id,
                sid,
                "NOT_FOUND",
                &format!("Session {sid} not found"),
            )
            .await;
            return;
        };
        let recs: Vec<Value> = records.iter().map(|r| to_session_rec(sid, r)).collect();
        self.reply(
            relay,
            frontend_id,
            sid,
            json!({ "t": "batch", "sid": sid, "d": recs }),
        )
        .await;
    }

    /// Guard helper for worktree relay handlers (`withWorktreeManager`,
    /// command-dispatcher.ts:989-1018) — publishes `NO_REPO` when no manager
    /// is configured; the caller's returned `Err` becomes `WORKTREE_ERROR`.
    async fn with_worktree_manager<F>(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        fallback_msg: &str,
        run: F,
    ) where
        F: for<'a> FnOnce(
            Arc<WorktreeManager>,
            &'a Arc<dyn RelayLink>,
            &'a str,
        ) -> BoxFuture<Result<(), String>>,
    {
        let Some(wm) = (self.deps.get_worktree_manager)() else {
            self.reply(
                relay,
                frontend_id,
                RELAY_CHANNEL_CONTROL,
                json!({ "t": "err", "e": "NO_REPO", "m": NO_REPO_MESSAGE }),
            )
            .await;
            return;
        };
        if let Err(message) = run(wm, relay, frontend_id).await {
            let m = if message.is_empty() {
                fallback_msg.to_string()
            } else {
                message
            };
            self.reply(
                relay,
                frontend_id,
                RELAY_CHANNEL_CONTROL,
                json!({ "t": "err", "e": "WORKTREE_ERROR", "m": m }),
            )
            .await;
        }
    }

    /// `handleRelayWorktreeList` (command-dispatcher.ts:1020-1038).
    async fn handle_relay_worktree_list(&self, relay: &Arc<dyn RelayLink>, frontend_id: &str) {
        self.with_worktree_manager(
            relay,
            frontend_id,
            "Failed to list worktrees",
            |wm, relay, frontend_id| {
                let relay = Arc::clone(relay);
                let frontend_id = frontend_id.to_string();
                Box::pin(async move {
                    let worktrees: Vec<Value> = wm.list().iter().map(worktree_info_json).collect();
                    relay
                        .publish_to_peer(
                            &frontend_id,
                            RELAY_CHANNEL_CONTROL,
                            json!({ "t": "worktree.list", "d": worktrees }),
                        )
                        .await;
                    Ok(())
                })
            },
        )
        .await;
    }

    /// `handleRelayWorktreeCreate` (command-dispatcher.ts:1040-1119).
    /// Rolls the worktree back when `createSession` fails, and the rollback
    /// NEVER masks the original error. Mirrors Bun tests "worktree.create
    /// rolls back the worktree when createSession throws" and "worktree.create
    /// sanitizes a '.'-containing branch" (command-dispatcher.test.ts).
    async fn handle_relay_worktree_create(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        branch: &str,
        base_branch: Option<&str>,
        path: Option<&str>,
    ) {
        let create_session = Arc::clone(&self.deps.create_session);
        let get_relay_clients = Arc::clone(&self.deps.get_relay_clients);
        let branch = branch.to_string();
        let base_branch = base_branch.map(str::to_string);
        let path = path.map(str::to_string);
        self.with_worktree_manager(relay, frontend_id, "Failed to create worktree", move |wm, relay, frontend_id| {
            let relay = Arc::clone(relay);
            let frontend_id = frontend_id.to_string();
            Box::pin(async move {
                let ts = to_base36(now_ms());
                // A legal branch name can contain characters outside the sid
                // allowlist ('.', '+', '/', non-ASCII). sanitize_for_sid
                // collapses them so the derived sid (and default worktree
                // path) is always allowlist-clean; the original branch goes
                // to git verbatim.
                let safe_branch = sanitize_for_sid(&branch);
                let wt_path = path.unwrap_or_else(|| format!("{safe_branch}-{ts}"));
                let wt = wm.add(&wt_path, &branch, base_branch.as_deref())?;
                let sid = format!("{safe_branch}-{ts}");

                // `wm.add` created the worktree on disk; a createSession
                // failure below must roll it back (best-effort, force:true —
                // our own just-created worktree) and re-throw the ORIGINAL
                // error for the user-facing frame.
                if let Err(create_err) = create_session(
                    &sid,
                    &wt.path,
                    SpawnRunnerOptions {
                        worktree_path: Some(wt.path.clone()),
                        ..SpawnRunnerOptions::default()
                    },
                ) {
                    match wm.remove(&wt.path, true) {
                        Ok(()) => eprintln!(
                            "[IpcDispatcher] rolled back orphaned worktree at {} after createSession failed",
                            wt.path
                        ),
                        Err(rollback_err) => eprintln!(
                            "[IpcDispatcher] failed to roll back worktree at {} after createSession failed: {rollback_err}",
                            wt.path
                        ),
                    }
                    return Err(create_err);
                }

                // Subscribe every relay client IMMEDIATELY (mirrors
                // session.create) — closes the pre-hello race window.
                for link in get_relay_clients() {
                    link.subscribe(&sid).await;
                }

                relay
                    .publish_to_peer(
                        &frontend_id,
                        RELAY_CHANNEL_CONTROL,
                        json!({ "t": "worktree.created", "d": worktree_info_json(&wt), "sid": sid }),
                    )
                    .await;
                Ok(())
            })
        })
        .await;
    }

    /// `handleRelayWorktreeRemove` (command-dispatcher.ts:1121-1234) —
    /// live-session guard: refuse non-force, kill-on-force with
    /// `killRunner → await waitForExit → unregister → "stopped"`, refuse
    /// process-less blockers, unsubscribe OUTSIDE the kill loop. Truth
    /// source = the LIVE runner map with a stored worktree_path fallback.
    async fn handle_relay_worktree_remove(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        path: &str,
        force: bool,
    ) {
        let session_manager = Arc::clone(&self.deps.session_manager);
        let store = Arc::clone(&self.deps.store);
        let get_relay_clients = Arc::clone(&self.deps.get_relay_clients);
        let path = path.to_string();
        self.with_worktree_manager(relay, frontend_id, "Failed to remove worktree", move |wm, relay, frontend_id| {
            let relay = Arc::clone(relay);
            let frontend_id = frontend_id.to_string();
            Box::pin(async move {
                struct Blocker {
                    sid: String,
                    has_process: bool,
                }
                let target = wm.canonicalize(&path);
                let blockers: Vec<Blocker> = session_manager
                    .list_runners()
                    .into_iter()
                    .filter_map(|runner| {
                        // Live runner map is the truth source (a store row can
                        // read "running" after its runner exited); fall back
                        // to the stored worktree_path for runners registered
                        // via the hello path without that field. Mirrors Bun
                        // tests "worktree.remove falls back to the stored
                        // worktree_path" / "stale 'running' row"
                        // (command-dispatcher.test.ts).
                        let wt_path = runner.worktree_path.clone().or_else(|| {
                            let store = store.lock().unwrap();
                            store
                                .get_session(&runner.sid)
                                .ok()
                                .flatten()
                                .and_then(|s| s.worktree_path)
                        })?;
                        if wm.canonicalize(&wt_path) == target {
                            Some(Blocker {
                                sid: runner.sid,
                                has_process: runner.process.is_some(),
                            })
                        } else {
                            None
                        }
                    })
                    .collect();

                if !blockers.is_empty() {
                    if !force {
                        // Refuse; surface the blocking sids. The frame shape
                        // is exactly the WORKTREE_ERROR the Err path builds,
                        // so return Err (TS publishes directly + `return` —
                        // one frame either way).
                        let sids = blockers
                            .iter()
                            .map(|b| b.sid.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(format!(
                            "Cannot remove worktree: {} running session(s) ({sids}). Use force to kill and remove.",
                            blockers.len()
                        ));
                    }

                    // Force path: a blocker without a tracked process cannot
                    // be SIGTERMed — refuse rather than orphan it.
                    let unkillable: Vec<&Blocker> =
                        blockers.iter().filter(|b| !b.has_process).collect();
                    if !unkillable.is_empty() {
                        let sids = unkillable
                            .iter()
                            .map(|b| b.sid.as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(format!(
                            "Cannot force-remove worktree: session(s) ({sids}) are not managed by this daemon and cannot be killed."
                        ));
                    }

                    // Kill each blocker and reconcile its row BEFORE touching
                    // the worktree: kill → await exit → unregister → stopped.
                    // Mirrors Bun test "worktree.remove (force) kills the
                    // live runner, then removes — in order".
                    for b in &blockers {
                        session_manager.kill_runner(&b.sid);
                        session_manager.wait_for_exit(&b.sid).await;
                        session_manager.unregister_runner(&b.sid);
                        let store = store.lock().unwrap();
                        if let Err(e) = store.update_session_state(&b.sid, "stopped") {
                            eprintln!(
                                "[IpcDispatcher] updateSessionState failed for sid={}: {e}",
                                b.sid
                            );
                        }
                    }
                    // Unsubscribe OUTSIDE the kill loop's failure path —
                    // reached only after all kills succeeded.
                    for link in get_relay_clients() {
                        for b in &blockers {
                            link.unsubscribe(&b.sid).await;
                        }
                    }
                }

                wm.remove(&path, force)?;
                relay
                    .publish_to_peer(
                        &frontend_id,
                        RELAY_CHANNEL_CONTROL,
                        json!({ "t": "worktree.removed", "path": path }),
                    )
                    .await;
                Ok(())
            })
        })
        .await;
    }

    /// `handleRelaySessionExport` (command-dispatcher.ts:1236-1308) —
    /// fetch `effectiveLimit + 1` rows so exactly-at-limit is NOT flagged
    /// truncated. Mirrors Bun test "session.export reports truncated:false
    /// when EXACTLY the limit rows exist (rank 4)".
    async fn handle_relay_session_export(
        &self,
        relay: &Arc<dyn RelayLink>,
        frontend_id: &str,
        msg: &Value,
    ) {
        let sid = msg
            .get("sid")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let format = msg
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("markdown");
        let record_types: Option<Vec<String>> = msg.get("recordTypes").and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
        });
        let from = msg
            .get("timeRange")
            .and_then(|tr| tr.get("from"))
            .and_then(Value::as_i64);
        let to = msg
            .get("timeRange")
            .and_then(|tr| tr.get("to"))
            .and_then(Value::as_i64);
        let limit = msg.get("limit").and_then(Value::as_i64);

        let session = {
            let store = self.deps.store.lock().unwrap();
            store.get_session(&sid).ok().flatten()
        };
        let Some(session) = session else {
            self.reply_error(
                relay,
                frontend_id,
                &sid,
                "NOT_FOUND",
                &format!("Session {sid} not found"),
            )
            .await;
            return;
        };

        let effective_limit = limit.unwrap_or(50_000).min(50_000);
        // Fetch one MORE than the limit to distinguish "exactly
        // effective_limit records" (complete) from genuinely truncated.
        let fetched = {
            let mut store = self.deps.store.lock().unwrap();
            store.get_session_db(&sid).map(|db| {
                db.get_records_filtered(&RecordsFilter {
                    kinds: record_types,
                    from,
                    to,
                    limit: Some(effective_limit + 1),
                })
                .unwrap_or_default()
            })
        };
        let Some(fetched) = fetched else {
            self.reply_error(
                relay,
                frontend_id,
                &sid,
                "NOT_FOUND",
                &format!("Session DB for {sid} not found"),
            )
            .await;
            return;
        };
        let truncated = fetched.len() as i64 > effective_limit;
        let records: &[StoredRecord] = if truncated {
            &fetched[..usize::try_from(effective_limit).unwrap_or(fetched.len())]
        } else {
            &fetched[..]
        };

        let meta = to_wire_session_meta(&session);

        if format == "json" {
            let records_json: Vec<Value> = records.iter().map(stored_record_json).collect();
            let d = serde_json::to_string(&json!({
                "meta": meta,
                "records": records_json,
                "truncated": truncated,
            }))
            .unwrap_or_default();
            self.reply(
                relay,
                frontend_id,
                &sid,
                json!({ "t": "session.exported", "sid": sid, "format": "json", "d": d }),
            )
            .await;
        } else {
            let export_meta = ExportSessionMeta {
                sid: session.sid.clone(),
                cwd: session.cwd.clone(),
                state: session.state.clone(),
                created_at_ms: session.created_at,
            };
            let md = format_markdown(&export_meta, records, truncated);
            self.reply(
                relay,
                frontend_id,
                &sid,
                json!({ "t": "session.exported", "sid": sid, "format": "markdown", "d": md }),
            )
            .await;
        }
    }
}

/// Wire JSON for a [`WorktreeInfo`] — matches the TS `WorktreeInfo`
/// serialization (`{ path, branch, head, isMain }`, branch nullable).
fn worktree_info_json(wt: &WorktreeInfo) -> Value {
    json!({
        "path": wt.path,
        "branch": wt.branch,
        "head": wt.head,
        "isMain": wt.is_main,
    })
}

/// `toSessionRecs` element (command-dispatcher.ts:1317-1328): `ns` only when
/// it is a known namespace, `n` only when non-null (TS `undefined` fields
/// drop at stringify).
fn to_session_rec(sid: &str, r: &StoredRecord) -> Value {
    let mut rec = Map::new();
    rec.insert("t".to_string(), json!("rec"));
    rec.insert("sid".to_string(), json!(sid));
    rec.insert("seq".to_string(), json!(r.seq));
    rec.insert("k".to_string(), json!(r.kind));
    if let Some(ns) = to_namespace(r.ns.as_deref()) {
        rec.insert("ns".to_string(), json!(ns));
    }
    if let Some(name) = &r.name {
        rec.insert("n".to_string(), json!(name));
    }
    rec.insert("d".to_string(), json!(BASE64_STANDARD.encode(&r.payload)));
    rec.insert("ts".to_string(), json!(r.ts));
    Value::Object(rec)
}

/// A [`StoredRecord`] as the TS `JSON.stringify` renders it inside the
/// `session.exported` json `d` payload: `payload` (a `Uint8Array`)
/// stringifies to an index-keyed object (`{"0":1,"1":2}`), `ns`/`name`
/// are `null` when absent.
fn stored_record_json(r: &StoredRecord) -> Value {
    let payload: Map<String, Value> = r
        .payload
        .iter()
        .enumerate()
        .map(|(i, b)| (i.to_string(), json!(b)))
        .collect();
    json!({
        "seq": r.seq,
        "kind": r.kind,
        "ts": r.ts,
        "ns": r.ns,
        "name": r.name,
        "payload": payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::server::IpcServerEvents;
    use crate::transport::relay_manager::DispatchSendPushFn;
    use std::path::Path;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    // -----------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------

    /// One captured [`RelayLink`] call, in emission order.
    #[derive(Debug, Clone, PartialEq)]
    enum LinkCall {
        PublishToPeer {
            frontend_id: String,
            sid: String,
            msg: Value,
        },
        PublishRecord {
            sid: String,
            seq: u64,
            rec: Value,
        },
        PublishState {
            channel: String,
            msg: Value,
        },
        PublishRemoved {
            sid: String,
            msg: Value,
        },
        Subscribe(String),
        Unsubscribe(String),
    }

    /// Test double capturing every publish. Records synchronously (before the
    /// ready future is returned) — the dispatcher awaits each call in order,
    /// so recorded order == wire order.
    struct FakeLink {
        label: Option<Label>,
        pct: Option<String>,
        calls: Mutex<Vec<LinkCall>>,
    }

    impl FakeLink {
        fn new() -> Arc<Self> {
            Arc::new(FakeLink {
                label: None,
                pct: None,
                calls: Mutex::new(Vec::new()),
            })
        }

        fn with_label_pct(label: Option<Label>, pct: Option<String>) -> Arc<Self> {
            Arc::new(FakeLink {
                label,
                pct,
                calls: Mutex::new(Vec::new()),
            })
        }

        fn calls(&self) -> Vec<LinkCall> {
            self.calls.lock().unwrap().clone()
        }

        fn push(&self, call: LinkCall) {
            self.calls.lock().unwrap().push(call);
        }
    }

    impl RelayLink for FakeLink {
        fn label(&self) -> Option<Label> {
            self.label.clone()
        }

        fn peer_pct_b64(&self, _frontend_id: &str) -> BoxFuture<Option<String>> {
            let pct = self.pct.clone();
            Box::pin(async move { pct })
        }

        fn publish_to_peer(&self, frontend_id: &str, sid: &str, msg: Value) -> BoxFuture<()> {
            self.push(LinkCall::PublishToPeer {
                frontend_id: frontend_id.to_string(),
                sid: sid.to_string(),
                msg,
            });
            Box::pin(async {})
        }

        fn publish_record(&self, sid: &str, seq: u64, rec: Value) -> BoxFuture<()> {
            self.push(LinkCall::PublishRecord {
                sid: sid.to_string(),
                seq,
                rec,
            });
            Box::pin(async {})
        }

        fn publish_state(&self, channel: &str, msg: Value) -> BoxFuture<()> {
            self.push(LinkCall::PublishState {
                channel: channel.to_string(),
                msg,
            });
            Box::pin(async {})
        }

        fn publish_removed(&self, sid: &str, msg: Value) -> BoxFuture<()> {
            self.push(LinkCall::PublishRemoved {
                sid: sid.to_string(),
                msg,
            });
            Box::pin(async {})
        }

        fn subscribe(&self, sid: &str) -> BoxFuture<()> {
            self.push(LinkCall::Subscribe(sid.to_string()));
            Box::pin(async {})
        }

        fn unsubscribe(&self, sid: &str) -> BoxFuture<()> {
            self.push(LinkCall::Unsubscribe(sid.to_string()));
            Box::pin(async {})
        }
    }

    type CreateCall = (String, String, Option<String>);

    struct TestCtx {
        _tmp: TempDir,
        store: Arc<Mutex<Store>>,
        session_manager: Arc<SessionManager>,
        links: Vec<Arc<FakeLink>>,
        create_calls: Arc<Mutex<Vec<CreateCall>>>,
        dispatcher: Arc<IpcCommandDispatcher>,
        runner: Arc<ConnectedRunner>,
        rx: mpsc::Receiver<Vec<u8>>,
    }

    struct CtxOpts {
        links: usize,
        wm: Option<Arc<WorktreeManager>>,
        create_err: Option<String>,
        relay_health: Vec<DoctorRelayStatus>,
    }

    impl Default for CtxOpts {
        fn default() -> Self {
            CtxOpts {
                links: 2,
                wm: None,
                create_err: None,
                relay_health: Vec::new(),
            }
        }
    }

    fn make_ctx(opts: CtxOpts) -> TestCtx {
        let tmp = TempDir::new().unwrap();
        let store = Arc::new(Mutex::new(
            Store::open(Some(tmp.path().join("vault")), None).unwrap(),
        ));
        let session_manager = Arc::new(SessionManager::new());
        let links: Vec<Arc<FakeLink>> = (0..opts.links).map(|_| FakeLink::new()).collect();
        let create_calls: Arc<Mutex<Vec<CreateCall>>> = Arc::new(Mutex::new(Vec::new()));

        let noop_push: DispatchSendPushFn = Arc::new(|_, _, _, _, _, _, _, _| {});
        let push_notifier = Arc::new(Mutex::new(PushNotifier::new(StorePushNotifierDeps::new(
            Arc::clone(&store),
            noop_push,
        ))));
        let ipc_server = Arc::new(IpcServer::new(IpcServerEvents {
            on_message: Arc::new(|_, _, _| {}),
            on_connect: Arc::new(|_| {}),
            on_disconnect: Arc::new(|_| {}),
        }));

        let links_for_deps = links.clone();
        let wm = opts.wm;
        let create_err = opts.create_err;
        let create_calls_dep = Arc::clone(&create_calls);
        let relay_health = opts.relay_health;

        let deps = IpcCommandDispatcherDeps {
            ipc_server,
            store: Arc::clone(&store),
            session_manager: Arc::clone(&session_manager),
            push_notifier,
            get_worktree_manager: Arc::new(move || wm.clone()),
            create_session: Arc::new(move |sid, cwd, spawn_opts| {
                create_calls_dep.lock().unwrap().push((
                    sid.to_string(),
                    cwd.to_string(),
                    spawn_opts.worktree_path.clone(),
                ));
                match &create_err {
                    Some(e) => Err(e.clone()),
                    None => Ok(()),
                }
            }),
            on_pair_begin: Arc::new(|_, _| {}),
            on_pair_cancel: Arc::new(|_, _| {}),
            on_cli_disconnect: Arc::new(|_| {}),
            remove_pairing: Arc::new(|_| Box::pin(async { Ok(1) })),
            rename_pairing: Arc::new(|_, _| Box::pin(async { Ok(1) })),
            get_on_record: Arc::new(|| None),
            get_relay_clients: Arc::new(move || {
                links_for_deps
                    .iter()
                    .map(|l| Arc::clone(l) as Arc<dyn RelayLink>)
                    .collect()
            }),
            get_relay_health: Arc::new(move || {
                let relays = relay_health.clone();
                Box::pin(async move { relays })
            }),
        };
        let dispatcher = IpcCommandDispatcher::new(deps);
        let (runner, rx) = ConnectedRunner::new_detached(None);
        TestCtx {
            _tmp: tmp,
            store,
            session_manager,
            links,
            create_calls,
            dispatcher,
            runner,
            rx,
        }
    }

    /// Decode one framed IPC reply (with a receive timeout so a missing
    /// reply fails the test instead of hanging it).
    async fn recv_json(rx: &mut mpsc::Receiver<Vec<u8>>) -> Value {
        let chunk = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for IPC reply")
            .expect("outbound channel closed");
        let mut dec = tp_core::codec::FrameDecoder::new();
        let frames = dec.decode(&chunk).unwrap();
        assert_eq!(frames.len(), 1);
        serde_json::from_slice(&frames[0].json).unwrap()
    }

    /// Poll until `f()` (spawned relay fan-out tasks are async).
    async fn wait_until<F: Fn() -> bool>(f: F, what: &str) {
        for _ in 0..200 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    fn seed_session(ctx: &TestCtx, sid: &str) {
        ctx.store
            .lock()
            .unwrap()
            .create_session(sid, "/tmp/w", None, None)
            .unwrap();
    }

    fn session_state(ctx: &TestCtx, sid: &str) -> Option<String> {
        ctx.store
            .lock()
            .unwrap()
            .get_session(sid)
            .unwrap()
            .map(|m| m.state)
    }

    /// Hermetic git repo for the worktree tests — same hygiene as the inc2
    /// `worktree::manager` test helper: strip `GIT_*` from the child env and
    /// force `commit.gpgsign=false` (a developer's global gitconfig may set
    /// signing, which cannot work against this throwaway identity).
    fn init_git_repo(dir: &Path) {
        let run = |args: &[&str]| {
            let mut full_args: Vec<&str> = vec!["-c", "commit.gpgsign=false"];
            full_args.extend_from_slice(args);
            let out = std::process::Command::new("git")
                .args(&full_args)
                .current_dir(dir)
                .env_clear()
                .envs(std::env::vars_os().filter(|(k, _)| !k.to_string_lossy().starts_with("GIT_")))
                .output()
                .expect("git spawn");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "test@test.com"]);
        run(&["config", "user.name", "Test"]);
        run(&["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    /// Make `Store::get_session_db` fail for any sid by deleting the
    /// on-disk `sessions/` directory. Both stores (bun:sqlite and rusqlite)
    /// auto-open a `.sqlite` for an unknown sid as long as the parent
    /// directory exists, so the "unknown session" dispatcher guard is only
    /// observable when the open itself fails — the Bun harness models this
    /// with `sessionDb: undefined`; here we force the real open to error.
    fn break_session_dbs(ctx: &TestCtx) {
        std::fs::remove_dir_all(ctx._tmp.path().join("vault").join("sessions")).unwrap();
    }

    // -----------------------------------------------------------------
    // bye — generation guard + reason mapping
    // -----------------------------------------------------------------

    /// Mirrors Bun test "stale bye from the old runner does not corrupt a
    /// restarted session" (command-dispatcher.test.ts): a bye whose pid does
    /// not match the currently registered runner is ignored — session state
    /// and the live registration survive.
    #[tokio::test]
    async fn bye_stale_pid_guard_ignores_old_runner() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "s1");
        ctx.session_manager
            .register_runner("s1", 200, "/tmp/w", None, None);

        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Bye {
                sid: "s1".to_string(),
                exit_code: 0.0,
                pid: Some(100), // old generation
                reason: None,
            },
            None,
        );
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(session_state(&ctx, "s1").as_deref(), Some("running"));
        assert!(
            ctx.session_manager.get_runner("s1").is_some(),
            "runner survives"
        );
        assert!(
            ctx.links[0].calls().is_empty(),
            "no state broadcast for a stale bye"
        );
        assert!(ctx.rx.try_recv().is_err(), "bye never replies");
    }

    /// Mirrors Bun test "bye with reason=signal marks the session stopped
    /// even with a non-zero exit code" (command-dispatcher.test.ts): a
    /// kill-path bye (synthetic 130/143/-1) must never smear "error".
    #[tokio::test]
    async fn bye_reason_signal_always_stopped() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "s1");
        ctx.session_manager
            .register_runner("s1", 100, "/tmp/w", None, None);

        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Bye {
                sid: "s1".to_string(),
                exit_code: 130.0,
                pid: Some(100),
                reason: Some(ByeReason::Signal),
            },
            None,
        );

        assert_eq!(session_state(&ctx, "s1").as_deref(), Some("stopped"));
        assert!(
            ctx.session_manager.get_runner("s1").is_none(),
            "runner unregistered"
        );
        wait_until(
            || {
                ctx.links.iter().all(|l| {
                    l.calls().iter().any(|c| {
                        matches!(c, LinkCall::PublishState { channel, .. } if channel == RELAY_CHANNEL_META)
                    })
                })
            },
            "state broadcast on __meta__",
        )
        .await;
    }

    /// Mirrors Bun test "bye maps exit code to session state" — exitCode 0 →
    /// stopped, non-zero (reason exit/absent) → error.
    #[tokio::test]
    async fn bye_exit_code_maps_state() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "ok");
        seed_session(&ctx, "bad");
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Bye {
                sid: "ok".to_string(),
                exit_code: 0.0,
                pid: None,
                reason: Some(ByeReason::Exit),
            },
            None,
        );
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Bye {
                sid: "bad".to_string(),
                exit_code: 1.0,
                pid: None,
                reason: None,
            },
            None,
        );
        assert_eq!(session_state(&ctx, "ok").as_deref(), Some("stopped"));
        assert_eq!(session_state(&ctx, "bad").as_deref(), Some("error"));
    }

    // -----------------------------------------------------------------
    // hello / rec
    // -----------------------------------------------------------------

    /// Mirrors Bun test "hello creates the session, registers the runner,
    /// subscribes every relay and broadcasts state" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn hello_creates_registers_subscribes_broadcasts() {
        let ctx = make_ctx(CtxOpts::default());
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Hello {
                sid: "h1".to_string(),
                cwd: "/tmp/w".to_string(),
                worktree_path: None,
                claude_version: Some("1.2.3".to_string()),
                pid: 4242,
            },
            None,
        );

        assert_eq!(session_state(&ctx, "h1").as_deref(), Some("running"));
        let runner = ctx.session_manager.get_runner("h1").expect("registered");
        assert_eq!(runner.pid, 4242);

        wait_until(
            || {
                ctx.links.iter().all(|l| {
                    let calls = l.calls();
                    let sub = calls
                        .iter()
                        .position(|c| matches!(c, LinkCall::Subscribe(s) if s == "h1"));
                    let state = calls.iter().position(|c| {
                        matches!(c, LinkCall::PublishState { channel, msg }
                            if channel == RELAY_CHANNEL_META && msg["sid"] == "h1")
                    });
                    matches!((sub, state), (Some(a), Some(b)) if a < b)
                })
            },
            "subscribe then state broadcast on every link",
        )
        .await;
    }

    /// Mirrors Bun test "rec appends the record, acks, and publishes to the
    /// relay" (command-dispatcher.test.ts) — plus the `ns`/`n` omission rule
    /// (absent fields never serialize as null).
    #[tokio::test]
    async fn rec_appends_acks_publishes_and_omits_absent_ns() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "r1");
        let payload_b64 = BASE64_STANDARD.encode(b"{\"x\":1}");
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Rec {
                sid: "r1".to_string(),
                kind: RecordKind::Event,
                ts: 1000.0,
                ns: None,
                name: Some("Stop".to_string()),
                payload: payload_b64.clone(),
            },
            None,
        );

        let ack = recv_json(&mut ctx.rx).await;
        assert_eq!(ack, json!({ "t": "ack", "sid": "r1", "seq": 1 }));

        wait_until(
            || {
                ctx.links.iter().all(|l| {
                    l.calls().iter().any(|c| {
                        matches!(c, LinkCall::PublishRecord { sid, seq, rec }
                        if sid == "r1" && *seq == 1
                            && rec["k"] == "event"
                            && rec["n"] == "Stop"
                            && rec["d"] == payload_b64.as_str()
                            && rec.get("ns").is_none())
                    })
                })
            },
            "rec published to every link without an ns key",
        )
        .await;

        // Stored payload is the decoded bytes, not the base64 text.
        let recs = {
            let mut store = ctx.store.lock().unwrap();
            let db = store.get_session_db("r1").unwrap();
            db.get_records_from(0, 10).unwrap()
        };
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].payload, b"{\"x\":1}");
    }

    /// Mirrors Bun test "rec with a binary sidecar stores the raw bytes and
    /// publishes base64" (command-dispatcher.test.ts, io PTY path).
    #[tokio::test]
    async fn rec_binary_sidecar_roundtrip() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "r2");
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Rec {
                sid: "r2".to_string(),
                kind: RecordKind::Io,
                ts: 5.0,
                ns: Some(Namespace::Claude),
                name: None,
                payload: String::new(),
            },
            Some(b"raw-pty".to_vec()),
        );
        let ack = recv_json(&mut ctx.rx).await;
        assert_eq!(ack["seq"], 1);

        let expected_b64 = BASE64_STANDARD.encode(b"raw-pty");
        wait_until(
            || {
                ctx.links[0].calls().iter().any(|c| matches!(c, LinkCall::PublishRecord { rec, .. }
                    if rec["d"] == expected_b64.as_str() && rec["ns"] == "claude" && rec.get("n").is_none()))
            },
            "binary rec published as base64",
        )
        .await;
        let recs = {
            let mut store = ctx.store.lock().unwrap();
            store
                .get_session_db("r2")
                .unwrap()
                .get_records_from(0, 10)
                .unwrap()
        };
        assert_eq!(recs[0].payload, b"raw-pty");
    }

    /// Mirrors Bun test "rec for an unknown session is dropped (no ack, no
    /// publish)" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn rec_unknown_session_dropped() {
        let mut ctx = make_ctx(CtxOpts::default());
        break_session_dbs(&ctx);
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::Rec {
                sid: "ghost".to_string(),
                kind: RecordKind::Io,
                ts: 1.0,
                ns: None,
                name: None,
                payload: BASE64_STANDARD.encode(b"x"),
            },
            None,
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(ctx.rx.try_recv().is_err(), "no ack for unknown session");
        assert!(
            ctx.links[0].calls().is_empty(),
            "no publish for unknown session"
        );
    }

    // -----------------------------------------------------------------
    // IPC session.delete / session.prune / doctor.probe / pair guard
    // -----------------------------------------------------------------

    /// Mirrors Bun tests "session.delete broadcasts session.removed BEFORE
    /// unsubscribing" and "session.delete unsubscribes the deleted sid from
    /// every relay client (rank 8)" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn ipc_session_delete_broadcasts_removed_before_unsubscribe() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "d1");
        // createSession seeds state="running" (both stores); flip to stopped
        // so wasRunning=false is the deterministic expectation here.
        ctx.store
            .lock()
            .unwrap()
            .update_session_state("d1", "stopped")
            .unwrap();
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::SessionDelete {
                sid: "d1".to_string(),
            },
            None,
        );
        let ok = recv_json(&mut ctx.rx).await;
        assert_eq!(
            ok,
            json!({ "t": "session.delete.ok", "sid": "d1", "wasRunning": false })
        );
        assert!(session_state(&ctx, "d1").is_none(), "row deleted");

        wait_until(
            || {
                ctx.links.iter().all(|l| {
                    let calls = l.calls();
                    let removed = calls.iter().position(|c| {
                        matches!(c, LinkCall::PublishRemoved { sid, msg }
                            if sid == "d1" && msg["t"] == "session.removed")
                    });
                    let unsub = calls
                        .iter()
                        .position(|c| matches!(c, LinkCall::Unsubscribe(s) if s == "d1"));
                    matches!((removed, unsub), (Some(a), Some(b)) if a < b)
                })
            },
            "session.removed before unsubscribe on every link",
        )
        .await;
    }

    /// Mirrors Bun test "session.delete replies not-found for an unknown sid"
    /// (command-dispatcher.test.ts) — the err frame has no message field.
    #[tokio::test]
    async fn ipc_session_delete_not_found() {
        let mut ctx = make_ctx(CtxOpts::default());
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::SessionDelete {
                sid: "nope".to_string(),
            },
            None,
        );
        let err = recv_json(&mut ctx.rx).await;
        assert_eq!(
            err,
            json!({ "t": "session.delete.err", "sid": "nope", "reason": "not-found" })
        );
    }

    /// Mirrors Bun tests "session.prune --dry-run lists candidates without
    /// deleting" and "session.prune skips running sessions unless
    /// includeRunning" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn ipc_session_prune_dry_run_and_running_filter() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "stopped-1");
        seed_session(&ctx, "running-1");
        {
            let store = ctx.store.lock().unwrap();
            store.update_session_state("stopped-1", "stopped").unwrap();
            // running-1 stays "running".
        }

        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::SessionPrune {
                age: AgeFilter::All,
                include_running: false,
                dry_run: true,
            },
            None,
        );
        let ok = recv_json(&mut ctx.rx).await;
        assert_eq!(
            ok,
            json!({ "t": "session.prune.ok", "sids": ["stopped-1"], "runningKilled": 0, "dryRun": true })
        );
        assert!(
            session_state(&ctx, "stopped-1").is_some(),
            "dry-run deletes nothing"
        );
        assert!(session_state(&ctx, "running-1").is_some());
    }

    /// Mirrors Bun test "session.prune --older-than deletes only sessions
    /// older than the cutoff" (command-dispatcher.test.ts). A freshly-created
    /// session has updated_at ≈ now, so a 1-hour cutoff spares it and a
    /// 0ms cutoff would not; we assert the spare side (deterministic).
    #[tokio::test]
    async fn ipc_session_prune_older_than_cutoff() {
        let mut ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "fresh");
        {
            let store = ctx.store.lock().unwrap();
            store.update_session_state("fresh", "stopped").unwrap();
        }
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::SessionPrune {
                age: AgeFilter::OlderThan { ms: 3_600_000 },
                include_running: false,
                dry_run: false,
            },
            None,
        );
        let ok = recv_json(&mut ctx.rx).await;
        assert_eq!(
            ok,
            json!({ "t": "session.prune.ok", "sids": [], "runningKilled": 0, "dryRun": false })
        );
        assert!(
            session_state(&ctx, "fresh").is_some(),
            "young session spared"
        );
    }

    /// Mirrors Bun test "doctor.probe surfaces the throttled flag for a
    /// peerless (idle) pairing" (command-dispatcher.test.ts / ipc-guard).
    #[tokio::test]
    async fn doctor_probe_surfaces_throttled() {
        let mut ctx = make_ctx(CtxOpts {
            relay_health: vec![DoctorRelayStatus {
                daemon_id: "d-1".to_string(),
                relay_url: "wss://r".to_string(),
                connected: true,
                peer_count: 0,
                throttled: Some(true),
            }],
            ..CtxOpts::default()
        });
        ctx.dispatcher
            .dispatch_ipc(&ctx.runner, &IpcMessage::DoctorProbe, None);
        let ok = recv_json(&mut ctx.rx).await;
        assert_eq!(ok["t"], "doctor.probe.ok");
        assert_eq!(
            ok["relays"],
            json!([{ "daemonId": "d-1", "relayUrl": "wss://r", "connected": true, "peerCount": 0, "throttled": true }])
        );
    }

    /// Mirrors Bun test "pair.remove replies not-found for an unknown
    /// daemonId (no removePairing call)" (command-dispatcher.test.ts) — the
    /// guard fires before the removal dep.
    #[tokio::test]
    async fn pair_remove_unknown_daemon_not_found() {
        let mut ctx = make_ctx(CtxOpts::default());
        ctx.dispatcher.dispatch_ipc(
            &ctx.runner,
            &IpcMessage::PairRemove {
                daemon_id: "nope".to_string(),
            },
            None,
        );
        let err = recv_json(&mut ctx.rx).await;
        assert_eq!(
            err,
            json!({ "t": "pair.remove.err", "daemonId": "nope", "reason": "not-found" })
        );
    }

    // -----------------------------------------------------------------
    // Relay control — hello / attach / resume / ping / stop / create
    // -----------------------------------------------------------------

    fn as_link(l: &Arc<FakeLink>) -> Arc<dyn RelayLink> {
        Arc::clone(l) as Arc<dyn RelayLink>
    }

    /// Mirrors Bun test "hello reply omits daemonLabel when the pairing has
    /// no label" (command-dispatcher.test.ts) — and includes pct when the
    /// peer has one (PCT promotion input, WS v3).
    #[tokio::test]
    async fn relay_hello_omits_daemon_label_when_unset() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "s1");

        let bare = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(&as_link(&bare), &json!({ "t": "hello" }), "fe-1")
            .await;
        let calls = bare.calls();
        let LinkCall::PublishToPeer {
            frontend_id,
            sid,
            msg,
        } = &calls[0]
        else {
            panic!("expected publish_to_peer, got {calls:?}");
        };
        assert_eq!(frontend_id, "fe-1");
        assert_eq!(sid, RELAY_CHANNEL_META);
        assert_eq!(msg["t"], "hello");
        assert_eq!(msg["v"], 1);
        assert_eq!(msg["d"]["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(msg["d"]["sessions"][0]["sid"], "s1");
        assert!(
            msg["d"].get("daemonLabel").is_none(),
            "no label → key omitted"
        );
        assert!(msg["d"].get("pct").is_none(), "no pct → key omitted");

        let labeled = FakeLink::with_label_pct(
            Some(Label::Set {
                value: "devbox".to_string(),
            }),
            Some("cGN0".to_string()),
        );
        ctx.dispatcher
            .dispatch_relay_control(&as_link(&labeled), &json!({ "t": "hello" }), "fe-1")
            .await;
        let calls = labeled.calls();
        let LinkCall::PublishToPeer { msg, .. } = &calls[0] else {
            panic!("expected publish_to_peer");
        };
        assert_eq!(
            msg["d"]["daemonLabel"],
            json!({ "set": true, "value": "devbox" })
        );
        assert_eq!(msg["d"]["pct"], "cGN0");
    }

    /// Mirrors Bun test "attach replies NOT_FOUND for an unknown session"
    /// (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_attach_not_found_error() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "attach", "sid": "gone" }),
                "fe",
            )
            .await;
        assert_eq!(
            link.calls(),
            vec![LinkCall::PublishToPeer {
                frontend_id: "fe".to_string(),
                sid: "gone".to_string(),
                msg: json!({ "t": "err", "e": "NOT_FOUND", "m": "Session gone not found" }),
            }]
        );
    }

    /// Mirrors Bun test "resume replays stored records as a batch"
    /// (command-dispatcher.test.ts) — payload base64, unknown ns dropped.
    #[tokio::test]
    async fn relay_resume_replays_batch() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "s1");
        {
            let mut store = ctx.store.lock().unwrap();
            let db = store.get_session_db("s1").unwrap();
            db.append("io", 10, b"one", Some("claude"), None).unwrap();
            db.append("event", 20, b"two", Some("bogus"), Some("Stop"))
                .unwrap();
        }
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "resume", "sid": "s1", "c": 0 }),
                "fe",
            )
            .await;
        let calls = link.calls();
        let LinkCall::PublishToPeer { msg, .. } = &calls[0] else {
            panic!("expected batch");
        };
        assert_eq!(msg["t"], "batch");
        let d = msg["d"].as_array().unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!(d[0]["ns"], "claude");
        assert_eq!(d[0]["d"], BASE64_STANDARD.encode(b"one"));
        assert!(d[0].get("n").is_none());
        assert!(d[1].get("ns").is_none(), "unknown ns dropped from the wire");
        assert_eq!(d[1]["n"], "Stop");
    }

    /// Mirrors Bun test "resume replies NOT_FOUND when the session DB is
    /// missing" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_resume_not_found() {
        let ctx = make_ctx(CtxOpts::default());
        break_session_dbs(&ctx);
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "resume", "sid": "zz", "c": 0 }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["m"], "Session zz not found");
    }

    /// Mirrors Bun test "ping → pong on the control channel"
    /// (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_ping_pongs_on_control() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(&as_link(&link), &json!({ "t": "ping" }), "fe")
            .await;
        assert_eq!(
            link.calls(),
            vec![LinkCall::PublishToPeer {
                frontend_id: "fe".to_string(),
                sid: RELAY_CHANNEL_CONTROL.to_string(),
                msg: json!({ "t": "pong" }),
            }]
        );
    }

    /// Mirrors Bun test "session.stop NACKs NO_RUNNER when nothing is
    /// running" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_session_stop_no_runner_nack() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.stop", "sid": "s9" }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["e"], "NO_RUNNER");
        assert_eq!(msg["m"], "No runner for session s9");
    }

    /// Mirrors Bun test "session.create with a path-traversal sid is rejected
    /// BEFORE createSession/subscribe (rank 3)" (command-dispatcher.test.ts):
    /// a crafted sid must be a clean SESSION_ERROR with zero side effects.
    #[tokio::test]
    async fn relay_session_create_rejects_traversal_sid_before_side_effects() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        let evil = "../../evil";
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.create", "sid": evil, "cwd": "/tmp/w" }),
                "fe",
            )
            .await;
        assert!(
            ctx.create_calls.lock().unwrap().is_empty(),
            "createSession never called"
        );
        for l in &ctx.links {
            assert!(
                !l.calls()
                    .iter()
                    .any(|c| matches!(c, LinkCall::Subscribe(_))),
                "no relay subscribe for a rejected sid"
            );
        }
        let LinkCall::PublishToPeer { msg, sid, .. } = &link.calls()[0] else {
            panic!("expected err reply");
        };
        assert_eq!(sid, evil);
        assert_eq!(msg["e"], "SESSION_ERROR");
        assert_eq!(
            msg["m"],
            format!("invalid sid '{evil}': must match [A-Za-z0-9_-]+ (no path separator, '..', or empty)")
        );
    }

    /// Mirrors Bun test "session.create subscribes every relay client
    /// immediately and acks" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_session_create_subscribes_all_relays_and_acks() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.create", "sid": "new-1", "cwd": "/tmp/w", "cols": 80, "rows": 24 }),
                "fe",
            )
            .await;
        assert_eq!(
            ctx.create_calls.lock().unwrap().as_slice(),
            &[("new-1".to_string(), "/tmp/w".to_string(), None)]
        );
        for l in &ctx.links {
            assert!(l
                .calls()
                .contains(&LinkCall::Subscribe("new-1".to_string())));
        }
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected ok");
        };
        assert_eq!(*msg, json!({ "t": "session.create.ok", "sid": "new-1" }));
    }

    /// Mirrors Bun test "session.restart refuses a passthrough/registered-only
    /// session (no process handle)" (command-dispatcher.test.ts): a runner
    /// registered via hello (no tracked child) cannot be safely killed, so
    /// restart must refuse rather than double-spawn.
    #[tokio::test]
    async fn relay_session_restart_refuses_passthrough() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "p1");
        ctx.session_manager
            .register_runner("p1", 77, "/tmp/w", None, None);
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.restart", "sid": "p1" }),
                "fe",
            )
            .await;
        assert!(ctx.create_calls.lock().unwrap().is_empty(), "no respawn");
        assert!(
            ctx.session_manager.get_runner("p1").is_some(),
            "runner untouched"
        );
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["e"], "SESSION_ERROR");
        assert_eq!(
            msg["m"],
            "Cannot restart session p1: it is not managed by this daemon (passthrough/registered-only) and cannot be safely killed before respawning."
        );
    }

    /// Mirrors Bun test "session.restart replies NOT_FOUND for an unknown
    /// session" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_session_restart_not_found() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.restart", "sid": "zz" }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["e"], "NOT_FOUND");
        assert_eq!(msg["m"], "Session zz not found");
    }

    // -----------------------------------------------------------------
    // Relay control — session.export
    // -----------------------------------------------------------------

    /// Mirrors Bun test "session.export reports truncated:false when EXACTLY
    /// the limit rows exist (rank 4)" (command-dispatcher.test.ts) — the
    /// dispatcher fetches limit+1 rows to disambiguate.
    #[tokio::test]
    async fn relay_session_export_truncated_off_by_one() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "e1");
        {
            let mut store = ctx.store.lock().unwrap();
            let db = store.get_session_db("e1").unwrap();
            for i in 0..3 {
                db.append("event", i, b"{}", None, Some("Stop")).unwrap();
            }
        }
        let link = FakeLink::new();

        // Exactly at the limit → NOT truncated.
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.export", "sid": "e1", "format": "json", "limit": 3 }),
                "fe",
            )
            .await;
        // One below the record count → truncated, sliced to the limit.
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.export", "sid": "e1", "format": "json", "limit": 2 }),
                "fe",
            )
            .await;

        let calls = link.calls();
        let LinkCall::PublishToPeer { msg: exact, .. } = &calls[0] else {
            panic!("expected exported");
        };
        let LinkCall::PublishToPeer { msg: over, .. } = &calls[1] else {
            panic!("expected exported");
        };
        assert_eq!(exact["t"], "session.exported");
        assert_eq!(exact["format"], "json");
        let exact_d: Value = serde_json::from_str(exact["d"].as_str().unwrap()).unwrap();
        assert_eq!(exact_d["truncated"], false);
        assert_eq!(exact_d["records"].as_array().unwrap().len(), 3);
        assert_eq!(exact_d["meta"]["sid"], "e1");

        let over_d: Value = serde_json::from_str(over["d"].as_str().unwrap()).unwrap();
        assert_eq!(over_d["truncated"], true);
        assert_eq!(over_d["records"].as_array().unwrap().len(), 2);
    }

    /// Mirrors Bun test "session.export markdown format renders via the
    /// export formatter" (command-dispatcher.test.ts) — default format.
    #[tokio::test]
    async fn relay_session_export_markdown_default() {
        let ctx = make_ctx(CtxOpts::default());
        seed_session(&ctx, "e2");
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "session.export", "sid": "e2" }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected exported");
        };
        assert_eq!(msg["format"], "markdown");
        assert!(msg["d"].as_str().unwrap().contains("e2"));
    }

    // -----------------------------------------------------------------
    // Relay control — worktree.*
    // -----------------------------------------------------------------

    /// Mirrors Bun test "worktree ops reply NO_REPO when no repository is
    /// configured" (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_worktree_no_repo() {
        let ctx = make_ctx(CtxOpts::default());
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(&as_link(&link), &json!({ "t": "worktree.list" }), "fe")
            .await;
        assert_eq!(
            link.calls(),
            vec![LinkCall::PublishToPeer {
                frontend_id: "fe".to_string(),
                sid: RELAY_CHANNEL_CONTROL.to_string(),
                msg: json!({ "t": "err", "e": "NO_REPO", "m": NO_REPO_MESSAGE }),
            }]
        );
    }

    /// Mirrors Bun test "worktree.remove refuses while a live session uses
    /// the worktree (non-force)" (command-dispatcher.test.ts) — refusal is a
    /// single WORKTREE_ERROR frame and the worktree survives.
    #[tokio::test]
    async fn relay_worktree_remove_nonforce_refuses_live_blocker() {
        let repo = TempDir::new().unwrap();
        init_git_repo(repo.path());
        let wm = Arc::new(WorktreeManager::new(repo.path()).unwrap());
        let ctx = make_ctx(CtxOpts {
            wm: Some(Arc::clone(&wm)),
            ..CtxOpts::default()
        });
        let wt = wm.add("wt-a", "feat-a", None).unwrap();
        ctx.session_manager
            .register_runner("wt-sess", 12, "/tmp/w", Some(wt.path.clone()), None);

        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "worktree.remove", "path": wt.path, "force": false }),
                "fe",
            )
            .await;
        let calls = link.calls();
        assert_eq!(calls.len(), 1, "refusal is a single frame");
        let LinkCall::PublishToPeer { msg, .. } = &calls[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["e"], "WORKTREE_ERROR");
        assert_eq!(
            msg["m"],
            "Cannot remove worktree: 1 running session(s) (wt-sess). Use force to kill and remove."
        );
        assert_eq!(wm.list().len(), 2, "worktree survives the refusal");
        assert!(ctx.session_manager.get_runner("wt-sess").is_some());
    }

    /// Mirrors Bun test "worktree.remove force refuses when a blocker has no
    /// process handle" (command-dispatcher.test.ts): a registered-only
    /// session cannot be SIGTERMed, so force must refuse instead of
    /// orphaning it.
    #[tokio::test]
    async fn relay_worktree_remove_force_refuses_processless_blocker() {
        let repo = TempDir::new().unwrap();
        init_git_repo(repo.path());
        let wm = Arc::new(WorktreeManager::new(repo.path()).unwrap());
        let ctx = make_ctx(CtxOpts {
            wm: Some(Arc::clone(&wm)),
            ..CtxOpts::default()
        });
        let wt = wm.add("wt-b", "feat-b", None).unwrap();
        ctx.session_manager
            .register_runner("wt-sess", 12, "/tmp/w", Some(wt.path.clone()), None);

        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "worktree.remove", "path": wt.path, "force": true }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(
            msg["m"],
            "Cannot force-remove worktree: session(s) (wt-sess) are not managed by this daemon and cannot be killed."
        );
        assert_eq!(wm.list().len(), 2, "worktree survives");
    }

    /// Mirrors Bun test "worktree.remove falls back to the stored
    /// worktree_path when the runner registration lacks one"
    /// (command-dispatcher.test.ts) — the store row is the fallback truth
    /// source for hello-registered runners.
    #[tokio::test]
    async fn relay_worktree_remove_store_worktree_path_fallback() {
        let repo = TempDir::new().unwrap();
        init_git_repo(repo.path());
        let wm = Arc::new(WorktreeManager::new(repo.path()).unwrap());
        let ctx = make_ctx(CtxOpts {
            wm: Some(Arc::clone(&wm)),
            ..CtxOpts::default()
        });
        let wt = wm.add("wt-c", "feat-c", None).unwrap();
        // Runner registered WITHOUT a worktree_path; the store row has it.
        ctx.store
            .lock()
            .unwrap()
            .create_session("wt-sess", "/tmp/w", Some(&wt.path), None)
            .unwrap();
        ctx.session_manager
            .register_runner("wt-sess", 12, "/tmp/w", None, None);

        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "worktree.remove", "path": wt.path, "force": false }),
                "fe",
            )
            .await;
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(
            msg["m"],
            "Cannot remove worktree: 1 running session(s) (wt-sess). Use force to kill and remove."
        );
    }

    /// Mirrors Bun test "worktree.create rolls back the worktree when
    /// createSession throws — and surfaces the ORIGINAL error"
    /// (command-dispatcher.test.ts).
    #[tokio::test]
    async fn relay_worktree_create_rolls_back_on_create_session_failure() {
        let repo = TempDir::new().unwrap();
        init_git_repo(repo.path());
        let wm = Arc::new(WorktreeManager::new(repo.path()).unwrap());
        let ctx = make_ctx(CtxOpts {
            wm: Some(Arc::clone(&wm)),
            create_err: Some("session spawn boom".to_string()),
            ..CtxOpts::default()
        });
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "worktree.create", "branch": "feat-x" }),
                "fe",
            )
            .await;
        assert_eq!(
            ctx.create_calls.lock().unwrap().len(),
            1,
            "createSession attempted"
        );
        assert_eq!(
            wm.list().len(),
            1,
            "orphaned worktree rolled back (main only)"
        );
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected err");
        };
        assert_eq!(msg["e"], "WORKTREE_ERROR");
        assert_eq!(
            msg["m"], "session spawn boom",
            "original error, not the rollback's"
        );
        for l in &ctx.links {
            assert!(
                !l.calls()
                    .iter()
                    .any(|c| matches!(c, LinkCall::Subscribe(_))),
                "no subscribe after a failed create"
            );
        }
    }

    /// Mirrors Bun test "worktree.create sanitizes a slash/dot branch into
    /// the sid" (command-dispatcher.test.ts): a legal git branch can contain
    /// characters outside the sid allowlist; the derived sid must be clean.
    #[tokio::test]
    async fn relay_worktree_create_sanitizes_branch_for_sid() {
        let repo = TempDir::new().unwrap();
        init_git_repo(repo.path());
        let wm = Arc::new(WorktreeManager::new(repo.path()).unwrap());
        let ctx = make_ctx(CtxOpts {
            wm: Some(Arc::clone(&wm)),
            ..CtxOpts::default()
        });
        let link = FakeLink::new();
        ctx.dispatcher
            .dispatch_relay_control(
                &as_link(&link),
                &json!({ "t": "worktree.create", "branch": "fix/issue.1" }),
                "fe",
            )
            .await;
        let creates = ctx.create_calls.lock().unwrap().clone();
        assert_eq!(creates.len(), 1);
        let sid = &creates[0].0;
        assert!(
            sid.starts_with("fix-issue-1-"),
            "sid derives from the sanitized branch: {sid}"
        );
        assert_safe_sid(sid).expect("derived sid passes the allowlist");
        let LinkCall::PublishToPeer { msg, .. } = &link.calls()[0] else {
            panic!("expected worktree.created");
        };
        assert_eq!(msg["t"], "worktree.created");
        assert_eq!(msg["sid"], sid.as_str());
        assert_eq!(
            msg["d"]["branch"], "fix/issue.1",
            "git sees the ORIGINAL branch"
        );
        for l in &ctx.links {
            assert!(l.calls().contains(&LinkCall::Subscribe(sid.clone())));
        }
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    /// `to_base36` must match JS `Number.prototype.toString(36)` — the sid
    /// suffix format is shared with the TS dispatcher.
    #[test]
    fn to_base36_matches_js() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        // Date.now()-scale value: (1751940000000).toString(36) === "mctvubk0"
        assert_eq!(to_base36(1_751_940_000_000), "mctvubk0");
    }
}
