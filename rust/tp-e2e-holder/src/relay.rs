//! Embedded real `RelayServer` on an ephemeral loopback port.
//!
//! Same pattern as `tp-loopback` MINUS the golden-token pre-seed: the real
//! daemon self-registers via proof-based `relay.register`, so the registry
//! starts empty. The URL uses `localhost` (Bun-holder parity) — the app in the
//! Simulator / native macOS reaches the host loopback either way.

use std::net::SocketAddr;

use tp_relay::{RelayServer, SharedState};

use crate::out::{die, log};

/// Bind + serve the relay on 127.0.0.1:0 inside `rt`. Returns the ws URL.
/// The server task and its stale-check keep running on the runtime's worker
/// threads for the life of the process.
pub fn start_embedded(rt: &tokio::runtime::Runtime) -> String {
    rt.block_on(async {
        let state = SharedState::from_env();
        let server = RelayServer::with_state(state);
        let router = server.router();
        // Detached: the interval task lives on the runtime until process exit.
        drop(server.spawn_stale_check());

        let addr = SocketAddr::from(([127, 0, 0, 1], 0));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(err) => die(&format!("relay bind {addr} failed: {err}")),
        };
        let port = match listener.local_addr() {
            Ok(bound) => bound.port(),
            Err(err) => die(&format!("relay local_addr failed: {err}")),
        };

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, router).await {
                log(&format!("relay serve error: {err}"));
            }
        });

        format!("ws://localhost:{port}")
    })
}
