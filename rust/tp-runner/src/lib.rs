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
//! stays the default until this port's byte-exactness is proven. The load-
//! bearing parity gate is the **io record**: it carries its bytes as a binary
//! sidecar (`payload="" && binLen>0`), never base64 in the JSON. That
//! byte-exactness is now asserted by a differential wire-parity test
//! (`packages/daemon/src/session/runner-parity.test.ts`), which drives both
//! runners with the same fake claude and compares hello/io/bye frames.
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

pub mod collector;
pub mod hooks;
pub mod ipc;
pub mod pty;
pub mod runner;
pub mod settings;
pub mod socket;
pub mod wire;
