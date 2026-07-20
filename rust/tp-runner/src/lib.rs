//! Native Rust runner (ADR-0003 Stage 4).
//!
//! Spawns Claude Code in a PTY, collects io + hook events, and forwards Records
//! to the daemon over the framed-JSON IPC socket. This crate is a byte-exact
//! port of `packages/runner` (Bun/TypeScript): the wire it emits must be
//! indistinguishable from the Bun runner's so the daemon cannot tell which
//! implementation produced a session.
//!
//! # Dual-run, no cutover
//!
//! Stage 4 does not switch the default. The daemon's SessionManager picks the
//! runner binary per-session via `TP_RUNNER_BIN`; the Bun runner (`tpd run`)
//! is now the default (task #4 — Rust `tp-daemon` spawns this runner per
//! session). The load-bearing wire surface is the **io record**: it carries
//! its bytes as a binary sidecar (`payload="" && binLen>0`), never base64 in
//! the JSON. The Bun↔Rust differential wire-parity test that proved this
//! byte-exact was removed in PR4 (#5 cascade, once the Rust default landed);
//! byte-exactness is now held by `cargo test` + the tp-core golden vectors,
//! with the local `TP_E2E_RUNNER_BIN=1` real-claude gate as the E2E backstop.
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
//! Still on the Bun runner: `main.rs` argv wiring is present but the dual-run
//! seam (`TP_RUNNER_BIN`) has not been cut over — the daemon still spawns the
//! Bun runner (`tpd run`) by default.

pub mod cli;
pub mod collector;
pub mod hooks;
pub mod ipc;
pub mod pty;
pub mod runner;
pub mod settings;
pub mod socket;
pub mod wire;
