//! Git worktree manager — byte-exact (behavior-identical) port of
//! `packages/daemon/src/worktree/worktree-manager.ts`. See `manager` for the
//! full module doc.

pub mod manager;

pub use manager::{WorktreeInfo, WorktreeManager};
