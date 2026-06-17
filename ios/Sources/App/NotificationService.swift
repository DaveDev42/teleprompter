import Foundation
import UserNotifications
import os

#if os(iOS)
import UIKit
#endif

// MARK: - SessionNavigator (M13)

/// Lightweight @Observable navigator that carries a session-navigation intent
/// from any context (notification tap, toast tap) to the root SwiftUI shell.
///
/// Usage:
///   - Notification response handler posts `pendingSid` here.
///   - `RootView` / `TeleprompterApp` observes and clears it after switching
///     to the Sessions tab and pushing the session detail.
///
/// The navigator is a process-lifetime singleton shared via `SessionNavigator.shared`.
/// It is intentionally NOT placed in the SwiftUI environment — it is used as a
/// side-channel between non-SwiftUI code (UNUserNotificationCenterDelegate) and
/// the root view, where environment injection is unavailable.
@MainActor
@Observable
final class SessionNavigator {
    static let shared = SessionNavigator()
    private init() {}

    /// A session id that should be navigated to immediately, or `nil` when idle.
    /// Consumers must clear this after acting on it (set back to `nil`).
    var pendingSid: String? = nil
}

/// App-level notification service.
///
/// Handles:
/// 1. `UNUserNotificationCenter` authorization (always safe — Simulator, macOS,
///    and real devices all support UNUserNotificationCenter).
/// 2. APNs registration scaffold — calls `registerForRemoteNotifications()` on
///    iOS only, guarded so it is a strict no-op on macOS and never crashes in
///    the Simulator.
/// 3. Foreground notification handling — routes foreground pushes to
///    `ToastCenter` as in-app toasts (suppresses the OS banner while the app is
///    in the foreground, mirroring the Expo `setNotificationHandler` pattern).
///
/// # Device-gated TODOs (APNs — requires real device + provisioning)
///
/// The `aps-environment` entitlement is intentionally **NOT** added to
/// `ios/Teleprompter.entitlements` or `ios/project.yml`. Adding it without
/// a matching Apple Developer provisioning profile breaks ad-hoc and Simulator
/// signing. These steps must be done when targeting a real device:
///
/// 1. Add `aps-environment = "development"` (or `"production"`) to the
///    Teleprompter entitlements file.
/// 2. Create an APN certificate + provisioning profile in the Apple Developer
///    portal and wire it into `ios/project.yml` → `signing`.
/// 3. Implement `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
///    in `AppDelegate` (or the `@UIApplicationDelegateAdaptor`) to extract the
///    raw device token and send it to the daemon via the relay
///    (`relay.push.register`).
/// 4. Implement `application(_:didFailToRegisterForRemoteNotificationsWithError:)`
///    to log and surface the failure gracefully.
/// 5. The daemon side that seals + stores push tokens is already present in the
///    TypeScript daemon (`packages/daemon`).
///
/// # Simulator / macOS safety
///
/// - `UNUserNotificationCenter.requestAuthorization` works on all platforms.
/// - `UIApplication.shared.registerForRemoteNotifications()` is iOS-only and
///   is compiled out on macOS (`#if os(iOS)`).
/// - The Simulator accepts the authorization request but always returns a
///   sandbox token that cannot be used to deliver real pushes; the daemon
///   ignores zero-length / invalid tokens.
@MainActor
final class NotificationService: NSObject {
    static let shared = NotificationService()

    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "notifications")
    private let center = UNUserNotificationCenter.current()

    private override init() {
        super.init()
        center.delegate = self
    }

    // MARK: - Setup

    /// Call once at app launch (from `TeleprompterApp.init` or `onAppear`).
    ///
    /// Requests notification authorization and — on a real iOS device — triggers
    /// APNs token registration. Safe to call on Simulator and macOS (no-ops for
    /// the device-gated parts).
    func setup() {
        requestAuthorization()
    }

    private func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound, .badge]) {
            [weak self] granted, error in
            guard let self else { return }
            if let error {
                self.log.error(
                    "Notification authorization error: \(error.localizedDescription, privacy: .public)"
                )
                return
            }
            self.log.notice(
                "Notification authorization: \(granted ? "granted" : "denied", privacy: .public)")
            if granted {
                Task { @MainActor in
                    self.registerForRemoteNotificationsIfSupported()
                }
            }
        }
    }

    /// Trigger APNs registration on real iOS devices.
    ///
    /// This call is a no-op on macOS and on the Simulator (the Simulator
    /// nominally accepts the call but the returned token cannot deliver pushes).
    ///
    /// TODO(device-gated): implement `AppDelegate.application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
    /// to receive and forward the device token to the relay/daemon when targeting
    /// a real device.
    private func registerForRemoteNotificationsIfSupported() {
        #if os(iOS)
        // UIApplication.shared must be accessed on the main actor (already here).
        UIApplication.shared.registerForRemoteNotifications()
        log.notice("APNs registration requested (Simulator: token unusable for real pushes)")
        #elseif os(visionOS)
        // visionOS: APNs registration requires a real provisioning profile with
        // the APS Environment entitlement. Out of scope for B2 (Simulator path);
        // local notifications via UNUserNotificationCenter still work.
        log.notice("APNs registration skipped (visionOS — TODO)")
        #else
        // macOS: UNUserNotificationCenter authorization above is sufficient for
        // local notifications. APNs on macOS requires NSApplication-based
        // `registerForRemoteNotifications`, a separate entitlement
        // ("APS Environment" = "development"/"production" in the Mac app
        // entitlements), and is out of scope for Phase A.
        log.notice("APNs registration skipped (macOS — TODO)")
        #endif
    }

    // MARK: - Local Notifications (Simulator / testing)

    /// Post a local notification — useful for testing the notification flow on
    /// Simulator and macOS without real push infrastructure.
    ///
    /// - Parameters:
    ///   - title: Notification title.
    ///   - body: Notification body.
    ///   - sid: Optional session id; stored in `userInfo["sid"]` so the
    ///          response handler can navigate to the session.
    func scheduleLocal(title: String, body: String, sid: String? = nil) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let sid {
            content.userInfo = ["sid": sid]
        }
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil  // deliver immediately
        )
        center.add(request) { [weak self] error in
            if let error {
                self?.log.error(
                    "Local notification delivery error: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// Foreground notification handler. Suppress the OS banner and surface the
    /// push as an in-app toast instead (mirrors Expo `setNotificationHandler`
    /// with `shouldShowAlert: false`).
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let title = content.title
        let body = content.body
        let sid = content.userInfo["sid"] as? String

        // Route to the in-app toast on the main actor.
        await MainActor.run {
            ToastCenter.shared.show(title: title, body: body, sid: sid)
        }

        // Return empty set to suppress the OS banner (we showed our own toast).
        return []
    }

    /// Notification tap response handler (app was backgrounded when the OS
    /// banner appeared; user tapped it to open the app).
    ///
    /// M13: Posts the `sid` to `SessionNavigator.shared` so the root SwiftUI
    /// shell (RootView) can switch to the Sessions tab and push the session
    /// detail. The actual navigation runs on the main actor in the root view's
    /// `.onChange(of: SessionNavigator.shared.pendingSid)` observer.
    ///
    /// Simulator-safe: this path fires for local notifications too (e.g. from
    /// `NotificationService.scheduleLocal(title:body:sid:)`), so the navigation
    /// path is testable without real APNs infrastructure.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let sid = userInfo["sid"] as? String else { return }
        let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "notifications")
        log.notice("Notification tap: navigate to session \(sid, privacy: .public)")
        // M13: post the sid to the shared navigator so the root view switches tabs.
        await MainActor.run {
            SessionNavigator.shared.pendingSid = sid
        }
    }
}
