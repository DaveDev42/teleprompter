//! Native Rust daemon (ADR-0003 Phase 4). Increment 1: the SQLite store
//! layer — `Store`/`SessionDb` (byte-exact port of
//! `packages/daemon/src/store/*.ts`), `daemon_lock` (pidfile singleton), and
//! `export_formatter` (session export markdown). Increment 2 adds the IPC
//! listener (`ipc`), the Runner process supervisor (`session`), and the git
//! worktree manager (`worktree`). Increment 3 adds the relay-client
//! transport (`transport`). Increment 4 adds pairing orchestration
//! (`pairing`) and push notifications (`push`). Increment 5 adds the IPC/relay
//! command dispatcher (`ipc::command_dispatcher`), the fully-wired daemon
//! assembly (`daemon`), and the `tp-daemon` shipping bin — the dogfood
//! default daemon remains the Bun implementation (no cutover).

pub mod daemon;
pub mod daemon_lock;
pub mod export_formatter;
pub mod ipc;
pub mod pairing;
pub mod push;
pub mod session;
pub mod store;
pub mod transport;
pub mod worktree;
