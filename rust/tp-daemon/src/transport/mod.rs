//! Relay transport — byte-exact (behavior-identical) port of
//! `packages/daemon/src/transport/relay-client.ts` and
//! `packages/daemon/src/transport/relay-manager.ts`. See `relay_client` /
//! `relay_manager` for the full module docs.

pub mod relay_client;
pub mod relay_manager;

pub use relay_client::{
    compute_reconnect_plan, next_peerless_reconnects, ReconnectPlan, RelayClient,
    RelayClientConfig, RelayClientEvents,
};
pub use relay_manager::{RelayConnectionManager, RelayManagerDeps, StorePushNotifierDeps};
