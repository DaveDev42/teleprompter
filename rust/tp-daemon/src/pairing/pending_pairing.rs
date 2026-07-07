//! Single-slot pending-pairing state machine — port of
//! `packages/daemon/src/pairing/pending-pairing.ts` (253 LOC).
//!
//! Lifecycle: `new` → `begin()` → `await_completion()` → `{Completed|Cancelled}`.
//! After `Completed`, the caller ([`super::orchestrator::PairingOrchestrator`])
//! calls [`PendingPairing::release_relay`] to take ownership of the
//! `RelayClient` — `PendingPairing` will not dispose it. After `Cancelled`,
//! the `RelayClient` is disposed here.
//!
//! # Invariants preserved from `pending-pairing.ts` (verify each against the
//! TS source)
//!
//! - **cancel-during-connect clean error** (pending-pairing.ts:159-167): after
//!   `relay.connect()`, `cancel()` may have fired during the await (setting
//!   the relay handle to `None`). Re-checking `settled` and returning a
//!   descriptive `"pairing cancelled during relay connect"` error avoids a
//!   null-deref on the nulled relay and gives the orchestrator a clean cause.
//!   Pinning Bun test: `pending-pairing.test.ts` "cancels during relay
//!   connect".
//! - **cancel-before-relay-creation guard** (pending-pairing.ts:140-142): the
//!   same race can happen *before* the relay is even constructed (during the
//!   bundle-creation awaits) — checked via the same `settled` flag before
//!   calling `create_relay_client`.
//! - **`mark_completed` idempotency** (pending-pairing.ts:195-214): a second
//!   `onFrontendJoined` for an already-settled pairing is a no-op — the
//!   pairing resolves with the FIRST frontend to complete kx.

use tp_core::crypto::{derive_registration_proof, KxKeyPair};
use tp_proto::label::Label;

use super::random_pairing_bundle::{random_pairing_bundle, PairingBundle};
use crate::transport::relay_client::RelayClient;

/// The `__meta__` virtual sid a fresh pending client subscribes to (the
/// meta-only channel used for the `hello` frame once a frontend joins).
/// Mirrors `RELAY_CHANNEL_META` (`packages/protocol/src/types/relay.ts:17`).
/// No shared Rust constant exists yet outside `relay_client.rs`'s private
/// `RELAY_CHANNEL_CONTROL` copy, so this module carries its own — matching
/// the precedent `relay_client.rs` itself sets (see its module doc).
const RELAY_CHANNEL_META: &str = "__meta__";
/// Mirrors `RELAY_CHANNEL_CONTROL` (`packages/protocol/src/types/relay.ts:19`).
const RELAY_CHANNEL_CONTROL: &str = "__control__";

/// Outcome of a pending pairing.
///
/// `Completed` carries the material the daemon needs to persist the pairing
/// (`Store::save_pairing`) and keep the `RelayClient` alive. `Cancelled` is
/// emitted after `cancel()` (user Ctrl+C, CLI disconnect, etc.).
///
/// No `Debug` derive: `PendingPairingCompleted` carries a `KxKeyPair`, which
/// deliberately does not implement `Debug` (tp-core) so a stray `{:?}` log
/// line can never leak the daemon's private key.
#[derive(Clone)]
pub enum PendingPairingResult {
    Completed(Box<PendingPairingCompleted>),
    Cancelled,
}

/// The `Completed` payload, boxed in [`PendingPairingResult`] to keep the
/// enum small (clippy `large_enum_variant`, matching inc2/inc3 precedent of
/// boxing large variant payloads).
#[derive(Clone)]
pub struct PendingPairingCompleted {
    pub frontend_id: String,
    pub daemon_id: String,
    pub relay_url: String,
    pub relay_token: String,
    pub registration_proof: String,
    pub key_pair: KxKeyPair,
    pub pairing_secret: Vec<u8>,
    pub label: Label,
    /// Wire pairing UUID minted by the bundle (QR v4) — persisted at promote.
    pub pairing_id: String,
    /// Hostname as emitted in the QR (may be `""` when unknown).
    pub hostname: String,
}

/// Arguments to construct a [`PendingPairing`].
pub struct PendingPairingOptions {
    pub relay_url: String,
    pub daemon_id: String,
    /// Pairing label as a tagged union; `Label::Unset` means "no label".
    pub label: Label,
    /// Daemon display hostname, carried in the QR (v4) and bound into the
    /// PCT. The orchestrator injects the OS hostname; `PendingPairing` itself
    /// stays side-effect free.
    pub hostname: String,
}

/// Everything [`PendingPairing::begin`] needs to hand to the caller-supplied
/// `RelayClient` factory. Mirrors the TS `createRelayClient` callback's
/// argument object (pending-pairing.ts:34-44).
pub struct CreateRelayClientArgs {
    pub relay_url: String,
    pub daemon_id: String,
    pub token: String,
    pub registration_proof: String,
    pub key_pair: KxKeyPair,
    pub pairing_secret: Vec<u8>,
    pub label: Label,
    pub pairing_id: String,
    pub hostname: String,
}

/// Return value of [`PendingPairing::begin`].
pub struct BeginOutcome {
    pub pairing_id: String,
    pub qr_string: String,
    pub daemon_id: String,
}

pub struct PendingPairing {
    pub pairing_id: String,
    opts: PendingPairingOptions,
    relay: Option<std::sync::Arc<RelayClient>>,
    key_pair: Option<KxKeyPair>,
    pairing_secret: Option<Vec<u8>>,
    relay_token: String,
    registration_proof: String,
    qr_string: String,
    /// Wire pairing UUID + hostname exactly as minted into the QR by
    /// [`random_pairing_bundle`] (the bundle generates the UUID when not
    /// supplied). Distinct from `pairing_id`, which is the daemon-local
    /// pending-slot id (`pp-…`) used only for CLI cancel routing.
    wire_pairing_id: String,
    wire_hostname: String,
    settled: bool,
    resolved: Option<PendingPairingResult>,
}

impl PendingPairing {
    #[must_use]
    pub fn new(opts: PendingPairingOptions) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let rand_suffix: u32 = {
            use rand_core::RngCore as _;
            rand_core::OsRng.next_u32()
        };
        let pairing_id = format!("pp-{now:x}-{rand_suffix:x}");
        PendingPairing {
            pairing_id,
            opts,
            relay: None,
            key_pair: None,
            pairing_secret: None,
            relay_token: String::new(),
            registration_proof: String::new(),
            qr_string: String::new(),
            wire_pairing_id: String::new(),
            wire_hostname: String::new(),
            settled: false,
            resolved: None,
        }
    }

    /// Byte-behavior-faithful port of `begin()` (pending-pairing.ts:106-176).
    /// `create_relay_client` mirrors the TS `createRelayClient` factory
    /// callback — the caller (orchestrator) supplies it so this module never
    /// depends on `RelayConnectionManager` directly.
    ///
    /// # Errors
    /// Returns an error if cancelled during bundle-creation or during
    /// `relay.connect()` (both races are guarded — see module docs), or if
    /// `relay.connect()` itself fails.
    pub async fn begin<F>(&mut self, create_relay_client: F) -> Result<BeginOutcome, String>
    where
        F: FnOnce(CreateRelayClientArgs) -> std::sync::Arc<RelayClient>,
    {
        let bundle: PairingBundle = random_pairing_bundle(
            &self.opts.relay_url,
            &self.opts.daemon_id,
            self.opts.hostname.clone(),
        )
        .map_err(|e| e.to_string())?;

        self.key_pair = Some(bundle.key_pair.clone());
        self.pairing_secret = Some(bundle.pairing_secret.clone());
        self.relay_token = bundle.relay_token.clone();
        self.wire_pairing_id = bundle.pairing_id.clone();
        self.wire_hostname = bundle.hostname.clone();
        self.registration_proof = derive_registration_proof(&bundle.pairing_secret);
        self.qr_string = bundle.qr_string.clone();

        // cancel() (reachable via CLI disconnect) may have fired during the
        // bundle-creation work above, while `self.relay` was still `None` —
        // so its dispose() was a no-op. Without this guard we would create
        // + connect a relay that nobody owns.
        if self.settled {
            return Err("pairing cancelled before relay creation".to_string());
        }

        let relay = create_relay_client(CreateRelayClientArgs {
            relay_url: self.opts.relay_url.clone(),
            daemon_id: self.opts.daemon_id.clone(),
            token: self.relay_token.clone(),
            registration_proof: self.registration_proof.clone(),
            key_pair: bundle.key_pair,
            pairing_secret: bundle.pairing_secret,
            label: self.opts.label.clone(),
            // The pending client must already know the pairing identity: the
            // very first kx (the one that completes this pairing) derives
            // the PCT.
            pairing_id: self.wire_pairing_id.clone(),
            hostname: self.wire_hostname.clone(),
        });
        self.relay = Some(std::sync::Arc::clone(&relay));

        relay.connect().await;
        // cancel() can fire during the connect() await above — it sets
        // `self.relay` to `None`, so the subscribe() calls below would
        // operate on a relay nobody else can reach. Re-check `settled`
        // (mirroring the pre-creation guard above) and return the SAME
        // descriptive cancellation error so the orchestrator reports a clean
        // cause.
        if self.settled {
            return Err("pairing cancelled during relay connect".to_string());
        }
        relay.subscribe(RELAY_CHANNEL_META).await;
        relay.subscribe(RELAY_CHANNEL_CONTROL).await;

        Ok(BeginOutcome {
            pairing_id: self.pairing_id.clone(),
            qr_string: self.qr_string.clone(),
            daemon_id: self.opts.daemon_id.clone(),
        })
    }

    /// Called by the daemon's `RelayClient` `on_frontend_joined` hook once
    /// the frontend has completed ECDH key exchange. Idempotent — later
    /// frontends joining the same pending pairing are ignored (the pairing
    /// is already resolved). Mirrors `__markCompleted`
    /// (pending-pairing.ts:195-214).
    pub fn mark_completed(&mut self, frontend_id: &str) {
        if self.settled {
            return;
        }
        let (Some(key_pair), Some(pairing_secret)) =
            (self.key_pair.clone(), self.pairing_secret.clone())
        else {
            return;
        };
        self.settled = true;
        let completed = PendingPairingCompleted {
            frontend_id: frontend_id.to_string(),
            daemon_id: self.opts.daemon_id.clone(),
            relay_url: self.opts.relay_url.clone(),
            relay_token: self.relay_token.clone(),
            registration_proof: self.registration_proof.clone(),
            key_pair,
            pairing_secret,
            label: self.opts.label.clone(),
            pairing_id: self.wire_pairing_id.clone(),
            hostname: self.wire_hostname.clone(),
        };
        self.resolved = Some(PendingPairingResult::Completed(Box::new(completed)));
    }

    /// Returns true if the pairing has already resolved with `Completed`.
    #[must_use]
    pub fn completed(&self) -> bool {
        matches!(self.resolved, Some(PendingPairingResult::Completed(_)))
    }

    /// The resolved result, if any (mirrors `awaitCompletion()`'s
    /// already-resolved fast path — the full async await primitive is the
    /// caller's concern in the Rust port since `PairingOrchestrator` owns a
    /// `tokio::sync::Notify`/channel wiring instead of a stored `Promise`).
    #[must_use]
    pub fn resolved(&self) -> Option<PendingPairingResult> {
        self.resolved.clone()
    }

    /// User Ctrl+C or CLI disconnect: dispose the relay and resolve with
    /// `Cancelled`. Mirrors `cancel()` (pending-pairing.ts:222-239).
    ///
    /// `RelayClient::dispose` is `async` (it awaits the connection-state
    /// mutex and the read-loop task teardown), so this method is too —
    /// unlike the TS `cancel()`, which fires-and-forgets `relay.dispose()`
    /// (no `await` in the TS call site either; the JS event loop drains it
    /// later). Every caller in this port already runs inside an async
    /// context (the orchestrator's methods), so awaiting here is
    /// straightforward and, unlike the TS fire-and-forget, guarantees
    /// disposal has completed before `cancel()` returns.
    pub async fn cancel(&mut self) {
        if self.settled {
            return;
        }
        self.settled = true;
        if let Some(relay) = self.relay.take() {
            relay.dispose().await;
        }
        // Defense-in-depth: a cancelled pairing's secret material is never
        // handed off (the resolved result is `Cancelled`). `KxKeyPair`/the
        // pairing-secret `Vec<u8>` don't zeroize automatically the way the
        // TS `Uint8Array.fill(0)` call does, but `KxKeyPair` already derives
        // `ZeroizeOnDrop` (tp-core) so dropping `self.key_pair` below is
        // sufficient; the pairing secret is zeroized on drop too via the
        // `Zeroizing` wrapper used by `random_pairing_bundle`.
        self.key_pair = None;
        self.pairing_secret = None;
        self.resolved = Some(PendingPairingResult::Cancelled);
    }

    /// Hand off the `RelayClient` to the daemon on successful completion.
    /// Returns `None` if already released or never started, so callers that
    /// run after `cancel()` / a previous `release_relay()` can idempotently
    /// handle both cases. Mirrors `releaseRelay()`
    /// (pending-pairing.ts:247-251).
    pub fn release_relay(&mut self) -> Option<std::sync::Arc<RelayClient>> {
        self.relay.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> PendingPairingOptions {
        PendingPairingOptions {
            relay_url: "wss://relay.example".to_string(),
            daemon_id: "daemon-abc123".to_string(),
            label: Label::Unset,
            hostname: "test-host".to_string(),
        }
    }

    #[test]
    fn pairing_id_has_pp_prefix() {
        let pp = PendingPairing::new(opts());
        assert!(pp.pairing_id.starts_with("pp-"));
    }

    #[test]
    fn not_completed_before_mark_completed() {
        let pp = PendingPairing::new(opts());
        assert!(!pp.completed());
        assert!(pp.resolved().is_none());
    }

    #[test]
    fn mark_completed_without_key_material_is_noop() {
        // Mirrors pending-pairing.ts:197 (`if (!this.keyPair || !this.pairingSecret) return;`)
        // — mark_completed before begin() (no key material yet) must not settle.
        let mut pp = PendingPairing::new(opts());
        pp.mark_completed("frontend-1");
        assert!(!pp.completed());
        assert!(!pp.settled);
    }

    #[tokio::test]
    async fn cancel_before_begin_settles_as_cancelled() {
        let mut pp = PendingPairing::new(opts());
        pp.cancel().await;
        assert!(matches!(
            pp.resolved(),
            Some(PendingPairingResult::Cancelled)
        ));
        assert!(pp.relay.is_none());
    }

    #[tokio::test]
    async fn cancel_is_idempotent() {
        // Pinning Bun test: pending-pairing.test.ts "cancel is a no-op after
        // completion" (mirrored here for the pre-begin cancel path — the
        // second cancel() call must not clobber the first `resolved` value).
        let mut pp = PendingPairing::new(opts());
        pp.cancel().await;
        pp.cancel().await;
        assert!(matches!(
            pp.resolved(),
            Some(PendingPairingResult::Cancelled)
        ));
    }

    #[test]
    fn release_relay_is_none_when_never_started() {
        let mut pp = PendingPairing::new(opts());
        assert!(pp.release_relay().is_none());
    }
}
