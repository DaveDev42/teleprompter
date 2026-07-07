//! Runner process supervisor — byte-exact (behavior-identical) port of
//! `packages/daemon/src/session/session-manager.ts`. See `manager` for the
//! full module doc.

pub mod manager;

pub use manager::{
    RunnerExitHandler, RunnerInfo, SessionManager, SpawnRunnerOptions, TrackedChild,
};
