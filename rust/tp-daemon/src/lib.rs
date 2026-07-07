//! Native Rust daemon (ADR-0003 Phase 4). Increment 1: the SQLite store
//! layer only — `Store`/`SessionDb` (byte-exact port of
//! `packages/daemon/src/store/*.ts`), `daemon_lock` (pidfile singleton), and
//! `export_formatter` (session export markdown). Lib only — no `[[bin]]`,
//! no runtime cutover. Later increments add relay-client, dispatcher,
//! session-manager, and IPC.

pub mod daemon_lock;
pub mod export_formatter;
pub mod store;
