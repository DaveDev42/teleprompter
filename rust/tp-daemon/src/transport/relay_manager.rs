//! Owns the pool of active outbound relay connections for the daemon —
//! byte-behavior-faithful port of `packages/daemon/src/transport/relay-manager.ts`
//! (`RelayConnectionManager`, 594 lines).
//!
//! Responsibilities (mirrors the TS doc comment):
//!  - Construct [`RelayClient`] instances with the correct event bag
//!    ([`RelayConnectionManager::build_events`]).
//!  - Fan out push notifications across all active clients
//!    ([`RelayConnectionManager::dispatch_push`]).
//!  - Persist pairing records on connect and reconnect saved pairings on
//!    startup ([`RelayConnectionManager::add_client`],
//!    [`RelayConnectionManager::reconnect_saved`]).
//!  - Tear down a pairing: notify peer + dispose client + delete from store
//!    ([`RelayConnectionManager::remove_pairing`]).
//!
//! Out of scope (stays in the pairing orchestrator, ported in increment 4's
//! sibling modules `crate::pairing::{pending_pairing, orchestrator}`):
//!  - `PendingPairing` lifecycle, `beginPairing`, `cancelPendingPairing`,
//!    `promoteCompletedPairing`.
//!
//! ## Reused (not reimplemented)
//!
//! - [`crate::transport::relay_client::RelayClient`] (increment 3) — the
//!   whole transport. This module only builds the event bag and owns the
//!   `Vec<Arc<RelayClient>>` pool.
//! - [`crate::store::Store`] (increment 1) — `list_sessions`/`list_pairings`/
//!   `save_pairing`/`save_pairing_confirmation`/`update_pairing_label`/
//!   `delete_pairing`/`load_pairings`/`save_push_token`/`load_push_tokens`/
//!   `delete_push_token`/`delete_push_tokens_for_daemon`.
//! - [`crate::ipc::server::IpcServer`] (increment 2) — `find_runner_by_sid` +
//!   the static `send` helper, to route decrypted chat/terminal input to the
//!   Runner's IPC socket.
//! - [`crate::push::PushNotifier`] (increment 4 sibling) —
//!   `register_sealed_token`/`handle_unseal_failed`/`handle_token_dead`.
//!
//! ## Local additions
//!
//! - `to_wire_session_meta`: the wire-shape (camelCase JSON) conversion the
//!   module doc of `crate::store` explicitly says does NOT belong in the
//!   store (`toSessionMeta` in `packages/daemon/src/store/session-meta.ts`,
//!   deliberately not ported alongside the store in increment 1). It belongs
//!   here — the only caller is the `hello` frame this module builds.
//! - Local `RELAY_CHANNEL_META`/`RELAY_CHANNEL_CONTROL` constants (no shared
//!   Rust constant exists anywhere in the workspace for these — `relay_client.rs`
//!   itself already carries its own private copy of `RELAY_CHANNEL_CONTROL`
//!   rather than depending on one; `pending_pairing.rs` follows the same
//!   precedent).
//!
//! ## Load-bearing invariants preserved from the Bun implementation
//!
//! Each has a `relay-manager.test.ts` regression test on the TS side; each
//! has a Rust unit test below with a comment naming the pinning Bun test.
//!
//! 1. `removePairing` deletes the persisted store row BEFORE tearing down
//!    the in-memory client (a store failure must not leave a disposed
//!    client AND a surviving row that `reconnect_saved` resurrects).
//! 2. `removingDaemonIds` re-entrancy guard: a second concurrent
//!    `removePairing` for the same `daemonId` only performs the idempotent
//!    store delete and must NOT re-dispose the client the first call owns.
//! 3. `dispatchPush` targets the ONE client whose `daemonId` sealed the
//!    token; falls back to fan-out-to-all when `daemonId` is absent/unmatched
//!    (legacy token rows, or no connected client matches).

use std::sync::{Arc, Mutex};

use serde_json::Value;
use tp_proto::ipc::IpcMessage;
use tp_proto::label::Label;
use tp_proto::relay_client::InterruptionLevel;

use crate::ipc::server::IpcServer;
use crate::push::{PersistedToken, PushNotifier, PushNotifierDeps};
use crate::store::{PushPlatform, SavePairingInput, SessionMeta, Store};
use crate::transport::relay_client::{
    InputKind, OnFrontendJoinedFn, RelayClient, RelayClientConfig, RelayClientEvents,
};
use tp_proto::relay_client::Platform;

/// Mirrors `RELAY_CHANNEL_META` (`packages/protocol/src/types/relay.ts:17`).
const RELAY_CHANNEL_META: &str = "__meta__";
/// Mirrors `RELAY_CHANNEL_CONTROL` (`packages/protocol/src/types/relay.ts:19`).
const RELAY_CHANNEL_CONTROL: &str = "__control__";

/// Wire-shape conversion for the `hello` frame's `sessions` array — byte-exact
/// port of `toSessionMeta` (`packages/daemon/src/store/session-meta.ts`).
/// Deliberately lives here (not in `crate::store`, see that module's doc
/// comment) because the only consumer is the relay `hello` payload this
/// module builds.
fn to_wire_session_meta(meta: &SessionMeta) -> Value {
    let state = match meta.state.as_str() {
        "running" | "stopped" | "error" => meta.state.clone(),
        _ => "error".to_string(),
    };
    serde_json::json!({
        "sid": meta.sid,
        "state": state,
        "cwd": meta.cwd,
        "worktreePath": meta.worktree_path,
        "claudeVersion": meta.claude_version,
        "createdAt": meta.created_at,
        "updatedAt": meta.updated_at,
        "lastSeq": meta.last_seq,
    })
}

/// Send an IPC `input` frame to a connected Runner. Mirrors the
/// `ipcServer.send(runner, { t: "input", sid, data })` call in `onInput`.
fn send_input_frame(runner: &crate::ipc::server::ConnectedRunner, sid: &str, data: &str) {
    let msg = IpcMessage::Input {
        sid: sid.to_string(),
        data: data.to_string(),
    };
    if let Ok(json) = serde_json::to_vec(&msg) {
        let _ = IpcServer::send(runner, &json, None);
    }
}

/// Dependencies injected into [`RelayConnectionManager`]. Mirrors
/// `RelayConnectionManagerDeps` (relay-manager.ts).
pub trait RelayManagerDeps: Send + Sync {
    fn ipc_server(&self) -> &IpcServer;
    fn store(&self) -> &Mutex<Store>;
    fn push_notifier(&self) -> &Mutex<PushNotifier<StorePushNotifierDeps>>;
    /// Route a decrypted relay control message to the IPC command
    /// dispatcher. Getter form mirrors `getDispatcher()` (the dispatcher is
    /// constructed after the manager in the real Daemon wiring, increment 5).
    fn dispatch_relay_control(&self, client: &Arc<RelayClient>, msg: &Value, frontend_id: &str);
}

/// `(frontend_id, sealed, title, body, interruption_level, sid, event,
/// daemon_id) -> ()` — factored into a named alias to keep clippy's
/// `type_complexity` lint (deny under workspace `clippy::all`) happy, same
/// pattern inc2/inc3 use.
type DispatchSendPushFn =
    Arc<dyn Fn(&str, &str, &str, &str, InterruptionLevel, &str, &str, &str) + Send + Sync>;

/// Test-injected fake `RelayClient` factory (mirrors the TS
/// `__setFactory`/`__getFactory` test seam). Factored out solely to keep
/// clippy's `type_complexity` lint (deny under workspace `clippy::all`)
/// happy — same pattern inc2/inc3 use.
type RelayClientFactoryFn =
    Arc<dyn Fn(RelayClientConfig, RelayClientEvents) -> Arc<RelayClient> + Send + Sync>;

/// [`PushNotifierDeps`] backed directly by [`Store`]'s push-token table.
/// Bridges `push_notifier`'s `&str` platform (mirroring the TS `"ios" |
/// "android"` union at that layer) to the store's typed [`PushPlatform`].
pub struct StorePushNotifierDeps {
    store: Arc<Mutex<Store>>,
    /// Fan-out sink for an actually-sent push — the real send happens via
    /// the owning `RelayClient::send_push`, which `RelayConnectionManager`
    /// drives from `PushNotifier::on_record`'s `send_push` callback. This
    /// indirection exists because `PushNotifierDeps::send_push` has no
    /// access to the client pool; `RelayConnectionManager` supplies a
    /// closure over `Arc<Self>` instead (see `new`).
    dispatch: DispatchSendPushFn,
}

impl PushNotifierDeps for StorePushNotifierDeps {
    fn send_push(
        &self,
        frontend_id: &str,
        sealed: &str,
        title: &str,
        body: &str,
        interruption_level: InterruptionLevel,
        sid: &str,
        event: &str,
        daemon_id: &str,
    ) {
        (self.dispatch)(
            frontend_id,
            sealed,
            title,
            body,
            interruption_level,
            sid,
            event,
            daemon_id,
        );
    }

    fn persist_token(&self, frontend_id: &str, daemon_id: &str, sealed: &str, platform: &str) {
        let Some(p) = PushPlatform::parse(platform) else {
            return;
        };
        let store = self.store.lock().unwrap();
        let _ = store.save_push_token(frontend_id, daemon_id, sealed, p);
    }

    fn load_tokens(&self) -> Vec<PersistedToken> {
        let store = self.store.lock().unwrap();
        store
            .load_push_tokens()
            .unwrap_or_default()
            .into_iter()
            .map(|t| PersistedToken {
                frontend_id: t.frontend_id,
                daemon_id: t.daemon_id,
                sealed: t.sealed,
                platform: t.platform.as_str().to_string(),
            })
            .collect()
    }

    fn delete_token(&self, frontend_id: &str) {
        let store = self.store.lock().unwrap();
        let _ = store.delete_push_token(frontend_id);
    }
}

/// Owns the pool of outbound relay connections for the Daemon. Port of
/// `RelayConnectionManager` (relay-manager.ts).
pub struct RelayConnectionManager<D: RelayManagerDeps> {
    deps: Arc<D>,
    clients: Mutex<Vec<Arc<RelayClient>>>,
    /// daemonIds whose `remove_pairing` is currently in flight. Mirrors
    /// `removingDaemonIds` (relay-manager.ts) — see invariant 2 above.
    removing_daemon_ids: Mutex<std::collections::HashSet<String>>,
    /// Test-only factory injection (mirrors `__setFactory`/`__getFactory`).
    factory: Mutex<Option<RelayClientFactoryFn>>,
}

impl<D: RelayManagerDeps + 'static> RelayConnectionManager<D> {
    #[must_use]
    pub fn new(deps: Arc<D>) -> Self {
        RelayConnectionManager {
            deps,
            clients: Mutex::new(Vec::new()),
            removing_daemon_ids: Mutex::new(std::collections::HashSet::new()),
            factory: Mutex::new(None),
        }
    }

    /// Build the standard event bag for a `RelayClient`. Mirrors
    /// `buildEvents` (relay-manager.ts) — including the former
    /// `attachHandlers`'s `on_unpair`/`on_rename`, which the TS source sets
    /// as post-construction properties but this Rust port must build INTO
    /// the event bag before `RelayClient::new` (no post-construction setters
    /// exist on `RelayClientEvents`, confirmed by reading `relay_client.rs` —
    /// `events` is stored directly into the struct at construction).
    ///
    /// `daemon_id` is threaded through for `on_peer_confirmed` (persisting
    /// the PCT row) and diagnostic logging; `label` is the daemon's
    /// human-readable pairing label surfaced in the encrypted `hello` frame.
    #[allow(clippy::too_many_lines)]
    pub fn build_events(
        self: &Arc<Self>,
        label: Option<Label>,
        daemon_id: String,
    ) -> RelayClientEvents {
        let this = Arc::clone(self);
        let on_input: crate::transport::relay_client::OnInputFn =
            Arc::new(move |kind, sid, data, frontend_id| {
                let runner = this.deps.ipc_server().find_runner_by_sid(sid);
                if let Some(runner) = runner {
                    // Chat input targets the interactive claude TUI, which submits a
                    // prompt only on a carriage return (`\r`) — mirrors the TS
                    // comment in `onInput` byte-for-byte.
                    if kind == InputKind::Chat {
                        use base64::Engine;
                        let with_cr = format!("{data}\r");
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(with_cr.as_bytes());
                        send_input_frame(&runner, sid, &b64);
                    } else {
                        send_input_frame(&runner, sid, data);
                    }
                } else if !frontend_id.is_empty() {
                    let sid = sid.to_string();
                    let frontend_id = frontend_id.to_string();
                    let this2 = Arc::clone(&this);
                    tokio::spawn(async move {
                        if let Some(client) = this2.find_client_by_frontend(&frontend_id).await {
                            let err_msg = serde_json::json!({
                                "t": "err",
                                "e": "NO_RUNNER",
                                "m": format!("No runner for session {sid}"),
                            });
                            client.publish_to_peer(&frontend_id, &sid, &err_msg).await;
                        }
                    });
                }
            });

        let this = Arc::clone(self);
        let on_control_message: crate::transport::relay_client::OnControlMessageFn =
            Arc::new(move |msg, frontend_id| {
                let frontend_id = frontend_id.to_string();
                let msg = msg.clone();
                let this2 = Arc::clone(&this);
                tokio::spawn(async move {
                    if let Some(client) = this2.find_client_by_frontend(&frontend_id).await {
                        this2
                            .deps
                            .dispatch_relay_control(&client, &msg, &frontend_id);
                    }
                });
            });

        let this = Arc::clone(self);
        let did_for_confirm = daemon_id.clone();
        let on_peer_confirmed: crate::transport::relay_client::OnPeerConfirmedFn =
            Arc::new(move |frontend_id, pct, frontend_pk| {
                if did_for_confirm.is_empty() {
                    return;
                }
                let store = this.deps.store().lock().unwrap();
                let _ = store.save_pairing_confirmation(&crate::store::PairingConfirmation {
                    daemon_id: did_for_confirm.clone(),
                    frontend_id: frontend_id.to_string(),
                    pct: pct.to_vec(),
                    frontend_pk: frontend_pk.to_vec(),
                    confirmed_at: now_ms(),
                });
            });

        // `on_frontend_joined` is a plain sync callback (no async client
        // access inside the callback itself) — resolve the client via the
        // pool lookup (sync `Mutex<Vec<_>>`, not the async accessor methods)
        // and spawn the actual work.
        let this = Arc::clone(self);
        let label_for_join = label.clone();
        let daemon_id_for_join = daemon_id.clone();
        let on_frontend_joined: OnFrontendJoinedFn = Arc::new(move |frontend_id: &str| {
            let frontend_id = frontend_id.to_string();
            let label_for_join = label_for_join.clone();
            let daemon_id_for_join = daemon_id_for_join.clone();
            let this2 = Arc::clone(&this);
            tokio::spawn(async move {
                this2
                    .handle_frontend_joined(&frontend_id, label_for_join, &daemon_id_for_join)
                    .await;
            });
        });

        let this = Arc::clone(self);
        let did_for_push = daemon_id.clone();
        let on_push_token_sealed: crate::transport::relay_client::OnPushTokenSealedFn =
            Arc::new(move |frontend_id, sealed, platform| {
                let mut notifier = this.deps.push_notifier().lock().unwrap();
                notifier.register_sealed_token(
                    frontend_id,
                    &did_for_push,
                    sealed,
                    platform_as_str(platform),
                );
            });

        let this = Arc::clone(self);
        let on_push_unseal_failed: crate::transport::relay_client::OnPushUnsealFailedFn =
            Arc::new(move |frontend_id| {
                let mut notifier = this.deps.push_notifier().lock().unwrap();
                notifier.handle_unseal_failed(frontend_id);
            });

        let this = Arc::clone(self);
        let on_push_token_dead: crate::transport::relay_client::OnPushTokenDeadFn =
            Arc::new(move |frontend_id| {
                let mut notifier = this.deps.push_notifier().lock().unwrap();
                notifier.handle_token_dead(frontend_id);
            });

        let this = Arc::clone(self);
        let did_for_unpair = daemon_id.clone();
        let on_unpair: crate::transport::relay_client::OnUnpairFn =
            Arc::new(move |frontend_id, _reason| {
                let frontend_id = frontend_id.to_string();
                let did = did_for_unpair.clone();
                let this2 = Arc::clone(&this);
                tokio::spawn(async move {
                    let _ = frontend_id;
                    this2.remove_pairing(&did, false).await;
                });
            });

        let this = Arc::clone(self);
        let did_for_rename = daemon_id.clone();
        let on_rename: crate::transport::relay_client::OnRenameFn =
            Arc::new(move |_frontend_id, label| {
                let store = this.deps.store().lock().unwrap();
                let _ = store.update_pairing_label(&did_for_rename, label);
            });

        RelayClientEvents {
            on_input: Some(on_input),
            on_control_message: Some(on_control_message),
            on_peer_confirmed: Some(on_peer_confirmed),
            on_frontend_joined: Some(on_frontend_joined),
            on_push_token_sealed: Some(on_push_token_sealed),
            on_push_unseal_failed: Some(on_push_unseal_failed),
            on_push_token_dead: Some(on_push_token_dead),
            on_unpair: Some(on_unpair),
            on_rename: Some(on_rename),
            ..RelayClientEvents::default()
        }
    }

    /// The `onFrontendJoined` body (relay-manager.ts): publish the encrypted
    /// `hello` frame (sessions + daemon label + PCT), then subscribe to
    /// every existing session (running or stopped) so a later resume request
    /// on that sid reaches this daemon.
    async fn handle_frontend_joined(
        self: &Arc<Self>,
        frontend_id: &str,
        label: Option<Label>,
        _daemon_id: &str,
    ) {
        let Some(client) = self.find_client_by_frontend(frontend_id).await else {
            return;
        };
        let sessions: Vec<Value> = {
            let store = self.deps.store().lock().unwrap();
            store
                .list_sessions()
                .unwrap_or_default()
                .iter()
                .map(to_wire_session_meta)
                .collect()
        };
        let pct_b64 = client.peer_pct_b64(frontend_id).await;
        let daemon_label = label.unwrap_or(Label::Unset);
        let mut hello_data = serde_json::json!({
            "sessions": sessions,
            "daemonLabel": daemon_label,
        });
        if let Some(pct) = pct_b64 {
            hello_data["pct"] = Value::String(pct);
        }
        let hello_msg = serde_json::json!({
            "t": "hello",
            "v": 1,
            "d": hello_data,
        });
        client
            .publish_to_peer(frontend_id, RELAY_CHANNEL_META, &hello_msg)
            .await;

        let sids: Vec<String> = {
            let store = self.deps.store().lock().unwrap();
            store
                .list_sessions()
                .unwrap_or_default()
                .into_iter()
                .map(|s| s.sid)
                .collect()
        };
        for sid in sids {
            client.subscribe(&sid).await;
        }
    }

    async fn find_client_by_frontend(&self, frontend_id: &str) -> Option<Arc<RelayClient>> {
        let candidates: Vec<Arc<RelayClient>> = self.clients.lock().unwrap().clone();
        for c in candidates {
            if c.list_peer_frontend_ids()
                .await
                .iter()
                .any(|f| f == frontend_id)
            {
                return Some(c);
            }
        }
        None
    }

    /// Connect to a Relay server for remote frontend access. Persists the
    /// pairing for auto-reconnect and adds the client to the pool. Mirrors
    /// `addClient` (relay-manager.ts).
    ///
    /// # Errors
    /// Returns the underlying `rusqlite::Error` if a store call fails after
    /// `connect()` — the client is disposed before the error propagates so
    /// it is never orphaned outside the pool (see the TS doc comment this
    /// mirrors: a client left out of the pool would be invisible to
    /// `stop()`/`remove_pairing()`, reconnecting forever).
    pub async fn add_client(
        self: &Arc<Self>,
        config: RelayClientConfig,
    ) -> rusqlite::Result<Arc<RelayClient>> {
        let events = self.build_events(config.label.clone(), config.daemon_id.clone());

        // Snapshot everything `save_pairing` needs before `config` is moved
        // into the client constructor — `RelayClientConfig` has no `Clone`.
        let daemon_id = config.daemon_id.clone();
        let relay_url = config.relay_url.clone();
        let token = config.token.clone();
        let registration_proof = config.registration_proof.clone();
        let public_key = config.key_pair.public_key.to_vec();
        let secret_key = config.key_pair.secret_key.to_vec();
        let pairing_secret = config.pairing_secret.clone();
        let label = config.label.clone();
        let pairing_id = config.pairing_id.clone();
        let hostname = config.hostname.clone();

        let factory = self.factory.lock().unwrap().clone();
        let client = if let Some(factory) = factory {
            factory(config, events)
        } else {
            RelayClient::new(config, events)
        };

        client.connect().await;

        // Subscribe to meta, control, and all existing sessions (running OR
        // stopped) — mirrors the TS `try` block's subscribe loop.
        client.subscribe(RELAY_CHANNEL_META).await;
        client.subscribe(RELAY_CHANNEL_CONTROL).await;
        let sids: Vec<String> = {
            let store = self.deps.store().lock().unwrap();
            store
                .list_sessions()
                .unwrap_or_default()
                .into_iter()
                .map(|s| s.sid)
                .collect()
        };
        for sid in &sids {
            client.subscribe(sid).await;
        }

        // Persist pairing data for auto-reconnect, preserving any existing
        // label if the caller didn't supply one.
        let save_result = {
            let store = self.deps.store().lock().unwrap();
            let existing_label = store
                .list_pairings()
                .unwrap_or_default()
                .into_iter()
                .find(|p| p.daemon_id == daemon_id)
                .map(|p| p.label)
                .unwrap_or(Label::Unset);
            store.save_pairing(&SavePairingInput {
                daemon_id,
                relay_url,
                relay_token: token,
                registration_proof,
                public_key,
                secret_key,
                pairing_secret,
                label: Some(label.unwrap_or(existing_label)),
                pairing_id,
                hostname,
            })
        };

        // A store failure here must dispose the client rather than leave it
        // orphaned outside the pool (see the fn doc / TS source comment).
        if let Err(err) = save_result {
            client.dispose().await;
            return Err(err);
        }

        self.clients.lock().unwrap().push(Arc::clone(&client));
        Ok(client)
    }

    /// Register a pre-constructed `RelayClient` in the pool. Used by the
    /// pairing orchestrator's `promote` after a `PendingPairing` completes.
    /// Mirrors `registerClient` (relay-manager.ts).
    pub fn register_client(&self, client: Arc<RelayClient>) {
        self.clients.lock().unwrap().push(client);
    }

    /// Reconnect to all saved relay pairings from the store. Mirrors
    /// `reconnectSaved` (relay-manager.ts) — returns the count that
    /// reconnected successfully; failures are swallowed (best-effort, one
    /// dead pairing must not block the others).
    pub async fn reconnect_saved(self: &Arc<Self>) -> usize {
        let pairings = {
            let store = self.deps.store().lock().unwrap();
            store.load_pairings().unwrap_or_default()
        };
        let mut count = 0;
        for p in pairings {
            let config = RelayClientConfig {
                relay_url: p.relay_url,
                daemon_id: p.daemon_id,
                token: p.relay_token,
                registration_proof: p.registration_proof,
                key_pair: tp_core::crypto::KxKeyPair {
                    public_key: to_array_32(&p.public_key),
                    secret_key: to_array_32(&p.secret_key),
                },
                pairing_secret: p.pairing_secret,
                label: Some(p.label),
                pairing_id: p.pairing_id,
                hostname: p.hostname,
            };
            if self.add_client(config).await.is_ok() {
                count += 1;
            }
        }
        count
    }

    /// Remove a pairing by `daemonId`: optionally notify the peer with a
    /// `control.unpair` frame, tear down the relay client, and delete the
    /// persisted pairing record. Mirrors `removePairing` (relay-manager.ts).
    ///
    /// Returns the number of peers successfully notified.
    pub async fn remove_pairing(self: &Arc<Self>, daemon_id: &str, notify_peer: bool) -> usize {
        // Invariant 2 (`removingDaemonIds` idempotency guard) — pinned by
        // `relay-manager.test.ts` "removePairing re-entrancy" /
        // `removing_daemon_ids_guards_concurrent_removal` below.
        {
            let mut removing = self.removing_daemon_ids.lock().unwrap();
            if removing.contains(daemon_id) {
                drop(removing);
                let mut store = self.deps.store().lock().unwrap();
                let _ = store.delete_pairing(daemon_id);
                return 0;
            }
            removing.insert(daemon_id.to_string());
        }

        let notified = self.remove_pairing_inner(daemon_id, notify_peer).await;
        self.removing_daemon_ids.lock().unwrap().remove(daemon_id);
        notified
    }

    async fn remove_pairing_inner(self: &Arc<Self>, daemon_id: &str, notify_peer: bool) -> usize {
        let client = {
            let clients = self.clients.lock().unwrap();
            clients.iter().find(|c| c.daemon_id() == daemon_id).cloned()
        };

        let mut notified = 0;
        if let Some(client) = &client {
            if notify_peer {
                let peers = client.list_peer_frontend_ids().await;
                for frontend_id in &peers {
                    if client
                        .send_unpair_notice(
                            frontend_id,
                            tp_proto::control::UnpairReason::UserInitiated,
                        )
                        .await
                    {
                        notified += 1;
                    }
                }
            }
        }

        // Invariant 1 (store-first ordering) — pinned by
        // `relay-manager.test.ts` "removePairing deletes store row before
        // disposing client" / `remove_pairing_deletes_store_before_dispose`
        // below.
        {
            let mut store = self.deps.store().lock().unwrap();
            let _ = store.delete_pairing(daemon_id);
        }

        if let Some(client) = client {
            client.dispose().await;
            let mut clients = self.clients.lock().unwrap();
            if let Some(i) = clients.iter().position(|c| Arc::ptr_eq(c, &client)) {
                clients.remove(i);
            }
        }

        notified
    }

    /// Rename a pairing's label. Updates the store immediately, then pushes
    /// a `control.rename` frame to every connected peer. Mirrors
    /// `renamePairing` (relay-manager.ts).
    pub async fn rename_pairing(&self, daemon_id: &str, label: Label) -> usize {
        {
            let store = self.deps.store().lock().unwrap();
            let _ = store.update_pairing_label(daemon_id, &label);
        }

        let client = {
            let clients = self.clients.lock().unwrap();
            clients.iter().find(|c| c.daemon_id() == daemon_id).cloned()
        };
        let Some(client) = client else {
            return 0;
        };

        let mut notified = 0;
        for frontend_id in client.list_peer_frontend_ids().await {
            if client.send_rename_notice(&frontend_id, label.clone()).await {
                notified += 1;
            }
        }
        notified
    }

    /// Route a push notification to the ONE relay client that owns the
    /// sealed token (by `daemon_id`), falling back to fan-out when absent /
    /// unmatched. Mirrors `dispatchPush` (relay-manager.ts) — invariant 3.
    pub async fn dispatch_push(
        &self,
        frontend_id: &str,
        sealed: &str,
        title: &str,
        body: &str,
        interruption_level: Option<InterruptionLevel>,
        data: Option<(&str, Option<&str>, &str)>,
    ) {
        let owner_daemon_id = data.and_then(|(_, daemon_id, _)| daemon_id);
        let targets: Vec<Arc<RelayClient>> = {
            let clients = self.clients.lock().unwrap();
            if let Some(did) = owner_daemon_id {
                let owner = clients.iter().find(|c| c.daemon_id() == did).cloned();
                match owner {
                    Some(c) => vec![c],
                    None => clients.clone(),
                }
            } else {
                clients.clone()
            }
        };
        for client in targets {
            client
                .send_push(frontend_id, sealed, title, body, interruption_level, data)
                .await;
        }
    }

    /// Read-only view of the active clients' daemon ids. Mirrors
    /// `listDaemonIds` (relay-manager.ts).
    pub fn list_daemon_ids(&self) -> Vec<String> {
        self.clients
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.daemon_id().to_string())
            .collect()
    }

    /// Number of active clients. Mirrors the length check callers of
    /// `listClients()` typically perform.
    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    /// Test-only hook: inject a fake `RelayClient` factory. Mirrors
    /// `__setFactory`.
    pub fn set_factory(&self, factory: RelayClientFactoryFn) {
        *self.factory.lock().unwrap() = Some(factory);
    }

    /// Dispose all active clients. Mirrors `stop` (relay-manager.ts) —
    /// called during daemon shutdown.
    pub async fn stop(&self) {
        let clients = {
            let mut guard = self.clients.lock().unwrap();
            std::mem::take(&mut *guard)
        };
        for client in clients {
            client.dispose().await;
        }
    }
}

fn to_array_32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

/// Convert the wire [`Platform`] enum to its lowercase string (`"ios"` /
/// `"android"`) via `Serialize` — `tp_proto::relay_client::Platform` has no
/// public `as_str`/`Display`, only a private `from_str` used internally by
/// its own wire-guard parser.
fn platform_as_str(platform: Platform) -> &'static str {
    match platform {
        Platform::Ios => "ios",
        Platform::Android => "android",
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeDeps {
        store: Arc<Mutex<Store>>,
        push_notifier: Mutex<PushNotifier<StorePushNotifierDeps>>,
        dispatch_calls: AtomicUsize,
    }

    impl FakeDeps {
        fn new(store: Store) -> Arc<Self> {
            let store = Arc::new(Mutex::new(store));
            let dispatch: DispatchSendPushFn = Arc::new(|_, _, _, _, _, _, _, _| {});
            let push_deps = StorePushNotifierDeps {
                store: Arc::clone(&store),
                dispatch,
            };
            Arc::new(FakeDeps {
                store,
                push_notifier: Mutex::new(PushNotifier::new(push_deps)),
                dispatch_calls: AtomicUsize::new(0),
            })
        }
    }

    // FakeDeps needs an IpcServer — build a throwaway one bound nowhere
    // (find_runner_by_sid always returns None, which is all these tests need).
    struct TestHarnessDeps {
        inner: Arc<FakeDeps>,
        ipc: IpcServer,
    }

    impl RelayManagerDeps for TestHarnessDeps {
        fn ipc_server(&self) -> &IpcServer {
            &self.ipc
        }
        fn store(&self) -> &Mutex<Store> {
            &self.inner.store
        }
        fn push_notifier(&self) -> &Mutex<PushNotifier<StorePushNotifierDeps>> {
            &self.inner.push_notifier
        }
        fn dispatch_relay_control(
            &self,
            _client: &Arc<RelayClient>,
            _msg: &Value,
            _frontend_id: &str,
        ) {
            self.inner.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Returns the `TempDir` alongside the manager — the caller must keep it
    /// alive for the store's on-disk sqlite file to survive (same pattern as
    /// `store::store::tests::open_test_store`).
    fn make_manager() -> (
        tempfile::TempDir,
        Arc<RelayConnectionManager<TestHarnessDeps>>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(Some(dir.path().to_path_buf()), None).unwrap();
        let inner = FakeDeps::new(store);
        let events = crate::ipc::server::IpcServerEvents {
            on_message: Arc::new(|_, _, _| {}),
            on_connect: Arc::new(|_| {}),
            on_disconnect: Arc::new(|_| {}),
        };
        let deps = Arc::new(TestHarnessDeps {
            inner,
            ipc: IpcServer::new(events),
        });
        (dir, Arc::new(RelayConnectionManager::new(deps)))
    }

    #[test]
    fn to_wire_session_meta_maps_camel_case_fields() {
        let meta = SessionMeta {
            sid: "sess-1".to_string(),
            state: "running".to_string(),
            worktree_path: Some("/tmp/wt".to_string()),
            cwd: "/tmp".to_string(),
            created_at: 100,
            updated_at: 200,
            claude_version: None,
            last_seq: 5,
        };
        let wire = to_wire_session_meta(&meta);
        assert_eq!(wire["sid"], "sess-1");
        assert_eq!(wire["state"], "running");
        assert_eq!(wire["worktreePath"], "/tmp/wt");
        assert!(wire["claudeVersion"].is_null());
        assert_eq!(wire["createdAt"], 100);
        assert_eq!(wire["updatedAt"], 200);
        assert_eq!(wire["lastSeq"], 5);
    }

    /// Pins `session-meta.test.ts` "narrows a corrupt/legacy state to error".
    #[test]
    fn to_wire_session_meta_narrows_unknown_state_to_error() {
        let meta = SessionMeta {
            sid: "sess-1".to_string(),
            state: "bogus".to_string(),
            worktree_path: None,
            cwd: "/tmp".to_string(),
            created_at: 0,
            updated_at: 0,
            claude_version: None,
            last_seq: 0,
        };
        assert_eq!(to_wire_session_meta(&meta)["state"], "error");
    }

    #[test]
    fn new_manager_has_no_clients() {
        let (_dir, mgr) = make_manager();
        assert_eq!(mgr.client_count(), 0);
        assert!(mgr.list_daemon_ids().is_empty());
    }

    /// Invariant 1 — pins `relay-manager.test.ts` "removePairing deletes the
    /// store row before disposing the client": with no matching client in
    /// the pool, `remove_pairing` must still delete the store row and return
    /// 0 notified (the store-delete-first path runs regardless of whether a
    /// live client exists).
    #[tokio::test]
    async fn remove_pairing_deletes_store_row_even_without_live_client() {
        let (_dir, mgr) = make_manager();
        {
            let deps = &mgr.deps;
            let store = deps.store().lock().unwrap();
            store
                .save_pairing(&SavePairingInput {
                    daemon_id: "daemon-orphan".to_string(),
                    relay_url: "wss://relay.example".to_string(),
                    relay_token: "tok".to_string(),
                    registration_proof: "proof".to_string(),
                    public_key: vec![1u8; 32],
                    secret_key: vec![2u8; 32],
                    pairing_secret: vec![3u8; 32],
                    label: None,
                    pairing_id: "pid-1".to_string(),
                    hostname: "host".to_string(),
                })
                .unwrap();
        }
        let notified = mgr.remove_pairing("daemon-orphan", true).await;
        assert_eq!(notified, 0);
        let remaining = {
            let store = mgr.deps.store().lock().unwrap();
            store.load_pairings().unwrap()
        };
        assert!(remaining.iter().all(|p| p.daemon_id != "daemon-orphan"));
    }

    /// Invariant 2 — pins `relay-manager.test.ts` "a second concurrent
    /// removePairing for the same daemonId only performs the idempotent
    /// store delete". Simulate "already in flight" by pre-inserting the
    /// daemonId into `removing_daemon_ids` before calling `remove_pairing`;
    /// the call must short-circuit to the store-only branch (0 notified,
    /// no panic even though no client is registered).
    #[tokio::test]
    async fn removing_daemon_ids_guards_concurrent_removal() {
        let (_dir, mgr) = make_manager();
        mgr.removing_daemon_ids
            .lock()
            .unwrap()
            .insert("daemon-x".to_string());
        let notified = mgr.remove_pairing("daemon-x", true).await;
        assert_eq!(notified, 0);
        // The guard entry the *caller* inserted is untouched by the
        // short-circuit branch (only the in-flight call's own `finally`
        // clears its own insert) — confirms the second call never touched
        // the removing-set lifecycle owned by the (simulated) first call.
        assert!(mgr.removing_daemon_ids.lock().unwrap().contains("daemon-x"));
    }

    #[tokio::test]
    async fn remove_pairing_idempotent_when_called_twice_sequentially() {
        let (_dir, mgr) = make_manager();
        {
            let store = mgr.deps.store().lock().unwrap();
            store
                .save_pairing(&SavePairingInput {
                    daemon_id: "daemon-twice".to_string(),
                    relay_url: "wss://relay.example".to_string(),
                    relay_token: "tok".to_string(),
                    registration_proof: "proof".to_string(),
                    public_key: vec![1u8; 32],
                    secret_key: vec![2u8; 32],
                    pairing_secret: vec![3u8; 32],
                    label: None,
                    pairing_id: "pid-2".to_string(),
                    hostname: "host".to_string(),
                })
                .unwrap();
        }
        assert_eq!(mgr.remove_pairing("daemon-twice", false).await, 0);
        // Second call: row already gone, must not panic or error.
        assert_eq!(mgr.remove_pairing("daemon-twice", false).await, 0);
        assert!(!mgr
            .removing_daemon_ids
            .lock()
            .unwrap()
            .contains("daemon-twice"));
    }

    #[tokio::test]
    async fn rename_pairing_updates_store_even_without_live_client() {
        let (_dir, mgr) = make_manager();
        {
            let store = mgr.deps.store().lock().unwrap();
            store
                .save_pairing(&SavePairingInput {
                    daemon_id: "daemon-rename".to_string(),
                    relay_url: "wss://relay.example".to_string(),
                    relay_token: "tok".to_string(),
                    registration_proof: "proof".to_string(),
                    public_key: vec![1u8; 32],
                    secret_key: vec![2u8; 32],
                    pairing_secret: vec![3u8; 32],
                    label: None,
                    pairing_id: "pid-3".to_string(),
                    hostname: "host".to_string(),
                })
                .unwrap();
        }
        let notified = mgr
            .rename_pairing(
                "daemon-rename",
                Label::Set {
                    value: "New Label".to_string(),
                },
            )
            .await;
        assert_eq!(notified, 0);
        let pairings = {
            let store = mgr.deps.store().lock().unwrap();
            store.load_pairings().unwrap()
        };
        let row = pairings
            .iter()
            .find(|p| p.daemon_id == "daemon-rename")
            .unwrap();
        assert_eq!(
            row.label,
            Label::Set {
                value: "New Label".to_string()
            }
        );
    }

    #[tokio::test]
    async fn reconnect_saved_returns_zero_when_no_pairings() {
        let (_dir, mgr) = make_manager();
        assert_eq!(mgr.reconnect_saved().await, 0);
    }

    #[tokio::test]
    async fn stop_on_empty_pool_is_noop() {
        let (_dir, mgr) = make_manager();
        mgr.stop().await;
        assert_eq!(mgr.client_count(), 0);
    }

    /// Invariant 3 — pins `relay-manager.test.ts` "dispatchPush fans out to
    /// all clients when daemonId is absent". With no clients registered,
    /// dispatch is simply a no-op (never panics on the empty pool).
    #[tokio::test]
    async fn dispatch_push_on_empty_pool_is_noop() {
        let (_dir, mgr) = make_manager();
        mgr.dispatch_push("frontend-1", "sealed-blob", "Title", "Body", None, None)
            .await;
        assert_eq!(mgr.client_count(), 0);
    }

    #[test]
    fn to_array_32_pads_short_and_truncates_long() {
        assert_eq!(to_array_32(&[1, 2, 3]), {
            let mut a = [0u8; 32];
            a[0] = 1;
            a[1] = 2;
            a[2] = 3;
            a
        });
        let long = vec![7u8; 40];
        assert_eq!(to_array_32(&long), [7u8; 32]);
    }
}
