//! Native Rust runner (ADR-0003 Stage 4) — the default per-session runner.
//!
//! Spawns Claude Code in a PTY, collects io + hook events, and forwards Records
//! to the daemon over the framed-JSON IPC socket. The Rust `tp-daemon`'s
//! SessionManager spawns this runner per session via `tp_proto::locate_tp_runner()`
//! (task #4 flip, `rust/tp-daemon/src/session/manager.rs` `default_runner_command`).
//! The retired Bun runner (`tpd run`) was deleted in the #5 zero-Bun cascade
//! PR6 (#933); this crate is now the sole runner implementation. The wire it
//! emits is still byte-exact with the retired Bun runner's, locked in by the
//! TS-era golden vectors.
//!
//! # Wire byte-exactness
//!
//! The load-bearing wire surface is the **io record**: it carries its bytes as
//! a binary sidecar (`payload="" && binLen>0`), never base64 in the JSON. The
//! Bun↔Rust differential wire-parity test that proved this byte-exact was
//! removed in PR4 (#5 cascade, once the Rust default landed); byte-exactness
//! is now held by `cargo test` + the tp-core golden vectors, with the local
//! `TP_E2E_RUNNER_BIN=1` real-claude gate as the E2E backstop.
//!
//! # Module map
//!
//! Pure / leaf (increment 1):
//! - [`settings`] — byte-exact `capture_hook_command` + hook-settings merge
//!   (`buildSettings`). Pure; golden-parity tests.
//! - [`collector`] — io/event Record construction (io = binary sidecar,
//!   event = base64 payload). Pure.
//! - [`pty`] — PTY spawn/read/write/resize/kill over `portable-pty` (the ADR
//!   §6.1 spike + real impl). The blocking reader runs on a std thread and
//!   forwards bytes over a channel (the "reader-task hop").
//!
//! Async orchestration (increment 2):
//! - [`cli`] — runner argv parser (`parse_args`) + SIGINT/SIGTERM→exit-code
//!   mapping (`wait_for_signal`), hoisted from `main.rs` so `tp-cli`'s native
//!   passthrough can drive [`runner::run`] in-process (task #17).
//! - [`socket`] — runtime-dir + daemon/hook socket-path derivation (byte-exact
//!   port of the writer half of `socket-path.ts` + the sid traversal guard).
//! - [`wire`] — outbound `hello`/`bye` structs (field order matched to the TS
//!   object literals; carries the runner-specific `pid`/`reason`).
//! - [`ipc`] — tokio IPC client (framed-JSON UnixStream, decode-throw teardown,
//!   inbound `ack`/`input`/`resize` allowlist, overflow → close).
//! - [`hooks`] — tokio hook receiver (UnixListener, 1 MiB UTF-8 byte cap,
//!   `parse_hook_event` validation, dir mode-0700).
//! - [`runner`] — the `select!` orchestration loop wiring PTY + IPC + hooks into
//!   the lifecycle state machine (io-only-while-running, hooks-dropped-in-
//!   teardown, bye pid/reason, kill-child-on-stop).
//!
//! `main.rs` is the runtime bootstrap around the [`cli`] argv wiring — the
//! daemon spawns this binary (not `tpd run`, which no longer exists) as the
//! default runner for every session.

pub mod cli;
pub mod collector;
pub mod hooks;
pub mod ipc;
pub mod pty;
pub mod runner;
pub mod settings;
pub mod socket;
pub mod wire;
