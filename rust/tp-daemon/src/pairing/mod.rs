//! Pairing lifecycle — byte-exact (behavior-identical) port of
//! `packages/daemon/src/pairing/*.ts`. See `pending_pairing` and
//! `orchestrator` for the full module docs.

pub mod orchestrator;
pub mod pending_pairing;
mod random_pairing_bundle;

pub use orchestrator::{
    safe_hostname, BeginPairingError, BeginResult, OrchestratorDeps, PairingOrchestrator,
};
pub use pending_pairing::{
    PendingPairing, PendingPairingCompleted, PendingPairingOptions, PendingPairingResult,
};
