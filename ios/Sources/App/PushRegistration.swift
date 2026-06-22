import Foundation
import os

#if canImport(UIKit)
import UIKit
#endif

// MARK: - PushTokenObserver

/// A type that wants to be told when the device's APNs token becomes available
/// (or changes). `RelayClient` conforms so it can send `relay.push.register` as
/// soon as it has both a live authenticated connection AND a token — whichever
/// order those two facts arrive in.
@MainActor
protocol PushTokenObserver: AnyObject {
    /// The APNs device token, as a lowercase hex string. Called on the main actor
    /// whenever the token is first set or changes. The observer should (re)send its
    /// `relay.push.register` if it is currently connected; if it is not yet
    /// connected it can cache the fact and send on its next successful auth.
    func pushTokenDidChange(_ tokenHex: String)
}

// MARK: - PushTokenStore

/// Process-lifetime side-channel that carries the APNs device token from the
/// `UIApplicationDelegate` callback (which has no reference to the live relay
/// clients) to every `RelayClient` (which is owned by `PairingViewModel`).
///
/// This mirrors the `SessionNavigator.shared` pattern already used to bridge
/// non-SwiftUI delegate code to the app: the token can arrive *before* any relay
/// client connects (cold launch) or *after* (token refresh while connected), so
/// neither side can assume ordering. The store decouples them:
///
///   - `AppDelegate.didRegisterForRemoteNotifications…` → `setToken(_:)`.
///   - Each `RelayClient.connect()` → `addObserver(self)`; on registration it is
///     handed the current token immediately if one already exists.
///   - `setToken` fans the (possibly new) token out to all live observers so a
///     refreshed token re-registers everywhere.
///
/// Observers are held weakly — a torn-down `RelayClient` drops out of the set on
/// its next compaction without any explicit deregistration, so there is no
/// lifecycle coupling back from the client to the store.
@MainActor
final class PushTokenStore {
    static let shared = PushTokenStore()
    private init() {}

    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "push")

    /// The most recent APNs device token (lowercase hex), or nil if APNs has not
    /// yet delivered one (Simulator, or before registration completes).
    private(set) var deviceTokenHex: String?

    /// Weakly-held observers (relay clients). `NSHashTable.weakObjects` lets a
    /// deallocated client fall out without explicit removal.
    private let observers = NSHashTable<AnyObject>.weakObjects()

    /// Record the device token and fan it out to every live observer. Idempotent:
    /// re-setting the same token still re-notifies (cheap, and covers the case
    /// where an observer registered, missed the first set, and a later identical
    /// set should still reach it — though `addObserver` already handles that).
    func setToken(_ tokenHex: String) {
        let changed = deviceTokenHex != tokenHex
        deviceTokenHex = tokenHex
        log.notice(
            "APNs device token received (\(tokenHex.count, privacy: .public) hex chars), notifying \(self.observers.count, privacy: .public) observer(s)"
        )
        guard changed || !observers.allObjects.isEmpty else { return }
        for case let observer as PushTokenObserver in observers.allObjects {
            observer.pushTokenDidChange(tokenHex)
        }
    }

    /// Register an observer. If a token is already available it is delivered
    /// synchronously so a client that connected *after* the token arrived does not
    /// have to wait for a token refresh that may never come.
    func addObserver(_ observer: PushTokenObserver) {
        observers.add(observer)
        if let token = deviceTokenHex {
            observer.pushTokenDidChange(token)
        }
    }
}

// MARK: - AppDelegate (APNs registration callbacks)

#if os(iOS)
/// App delegate adaptor whose sole job is to receive the APNs device-token
/// callbacks, which SwiftUI's `App` lifecycle does not surface directly.
///
/// `UIApplication.shared.registerForRemoteNotifications()` (called from
/// `NotificationService`) eventually drives exactly one of these two callbacks.
/// On a real device with the `aps-environment` entitlement + a matching push
/// provisioning profile, `didRegister…` fires with a usable token. On the
/// Simulator the callback also fires but the token cannot deliver real pushes;
/// the relay seals whatever we send and the daemon simply never gets a
/// deliverable APNs receipt — harmless. Either way the *software* path
/// (token → `relay.push.register` → seal → daemon store) is exercised.
///
/// NOTE: the `aps-environment` entitlement is intentionally NOT added yet (it
/// breaks Simulator/ad-hoc signing without a provisioning profile — see
/// `NotificationService.swift`). Until it is added on a real-device build,
/// `didRegister…` will not fire on device; this adaptor is still safe to install
/// (it is inert until APNs calls it) and keeps the whole path wired so the only
/// remaining step is the provisioning artifact.
final class TeleprompterAppDelegate: NSObject, UIApplicationDelegate {
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "push")

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        log.notice("didRegisterForRemoteNotifications: token=\(hex.count, privacy: .public) hex chars")
        Task { @MainActor in
            PushTokenStore.shared.setToken(hex)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on Simulator without a real APNs provisioning profile, and on
        // any build missing the `aps-environment` entitlement. Log and move on —
        // local notifications (UNUserNotificationCenter) still work, and the relay
        // falls back to its in-band `relay.notification` path when the app is live.
        log.error(
            "didFailToRegisterForRemoteNotifications: \(error.localizedDescription, privacy: .public)"
        )
    }
}
#endif
