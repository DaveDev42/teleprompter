//! Relay transport — byte-exact (behavior-identical) port of
//! `packages/daemon/src/transport/relay-client.ts`. See `relay_client` for the
//! full module doc.

pub mod relay_client;

pub use relay_client::{
    compute_reconnect_plan, next_peerless_reconnects, ReconnectPlan, RelayClient,
    RelayClientConfig, RelayClientEvents,
};
