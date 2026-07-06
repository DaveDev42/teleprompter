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
//! sidecar (`payload="" && binLen>0`), never base64 in the JSON.
//!
//! # Module map (built out over increments)
//!
//! - [`settings`] — byte-exact `capture_hook_command` + hook-settings merge
//!   (`buildSettings`). Pure; the first slice to land with golden-parity tests.
//! - [`collector`] — io/event Record construction (io = binary sidecar,
//!   event = base64 payload). Pure.
//! - [`pty`] — PTY spawn/read/write/resize/kill over `portable-pty` (the ADR
//!   §6.1 spike + real impl). The blocking reader runs on a std thread and
//!   forwards bytes over a channel (the "reader-task hop").
//!
//! The async IPC client, hook receiver, and orchestration (`Runner`) land in
//! subsequent increments; this crate compiles and tests the pure slices + PTY
//! spike first so the biggest technical unknown (PTY) is retired early.

pub mod collector;
pub mod pty;
pub mod settings;
