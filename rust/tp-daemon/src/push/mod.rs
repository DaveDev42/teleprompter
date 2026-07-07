//! Push notification fan-out — byte-exact (behavior-identical) port of
//! `packages/daemon/src/push/push-notifier.ts`. See `notifier` for the full
//! module doc.

pub mod notifier;

pub use notifier::{
    build_push_message, interruption_level_for, is_notify_event, PersistedToken, PushMessage,
    PushNotifier, PushNotifierDeps, RecordInfo,
};
