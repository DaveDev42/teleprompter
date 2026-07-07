//! SQLite store layer — byte-exact port of `packages/daemon/src/store/*.ts`.
//!
//! `config` resolves the on-disk vault directory; `schema` holds the DDL and
//! PRAGMA text verbatim from the TS source; `session_db` wraps a single
//! per-session `<sid>.sqlite`; `pairing_row_guard` validates rows read back
//! out of the `pairings` table; `store` is the top-level `Store` that owns
//! the meta db plus an LRU-of-32 cache of `SessionDb` handles.
//!
//! `session_meta.ts` (the wire-conversion helper `toSessionMeta`) is
//! deliberately NOT ported in this increment — it belongs to the IPC/relay
//! wire layer, not the pure store. `Store::get_session`/`list_sessions`
//! return the raw store-row `SessionMeta` (snake_case columns) instead.

pub mod config;
pub mod pairing_row_guard;
pub mod schema;
pub mod session_db;
#[allow(clippy::module_inception)]
pub mod store;

pub use config::get_store_dir;
pub use pairing_row_guard::{parse_stored_pairing, StoredPairing, PAIRING_KEY_BYTES};
pub use session_db::{RecordsFilter, SessionDb, StoredRecord};
pub use store::{
    PairingConfirmation, PairingSummary, PushPlatform, PushToken, SavePairingInput, SessionMeta,
    Store, StoreError, DEFAULT_MAX_OPEN_SESSION_DBS,
};
