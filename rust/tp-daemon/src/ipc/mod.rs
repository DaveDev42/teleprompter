//! Daemon IPC listener — tokio port of `packages/daemon/src/ipc/server.ts`.
//! See `server` for the full module doc.

pub mod command_dispatcher;
pub mod server;

pub use server::{ConnectedRunner, IpcServer, IpcServerEvents};
