import SwiftUI
#if os(iOS) || os(visionOS)
import UIKit
#endif

/// A subtle connection-state banner + VoiceOver live-region announcement,
/// ported from the Expo `ConnectionLiveRegion` component.
///
/// Behavior (mirrors Expo exactly):
/// - On disconnect: shows "Disconnected — messages will send after reconnect"
///   with a grey dot. Announces to VoiceOver.
/// - On reconnect after a disconnect: shows "Reconnected" with a green dot for
///   `reconnectBannerDuration` seconds, then hides. Announces to VoiceOver.
/// - On initial mount while connected: no spurious "Reconnected" announce.
///
/// The view is always kept in the hierarchy so VoiceOver always has a stable
/// live-region container (the Expo pattern: mount the container first, inject
/// content later, so AT observes the content change — not the container mount).
struct ConnectionBanner: View {
    let connected: Bool

    private enum BannerState { case hidden, disconnected, reconnected }

    @State private var bannerState: BannerState = .hidden
    @State private var hasBeenDisconnected = false
    @State private var reconnectTask: Task<Void, Never>?

    /// How long the transient "Reconnected" confirmation stays visible (2.5 s,
    /// matching the Expo RECONNECT_BANNER_MS).
    private let reconnectBannerDuration: Duration = .milliseconds(2500)

    var body: some View {
        // The outer container is always mounted; only the chrome toggles.
        VStack(spacing: 0) {
            switch bannerState {
            case .hidden:
                EmptyView()

            case .disconnected:
                bannerRow(
                    text: "Disconnected — messages will send after reconnect",
                    dotColor: .secondary,
                    accessibilityAnnouncement: "Disconnected. Messages will send after reconnect."
                )

            case .reconnected:
                bannerRow(
                    text: "Reconnected",
                    dotColor: .green,
                    accessibilityAnnouncement: "Reconnected."
                )
            }
        }
        .onChange(of: connected, initial: false) { _, isConnected in
            reconnectTask?.cancel()
            if !isConnected {
                hasBeenDisconnected = true
                bannerState = .disconnected
                postAccessibilityAnnouncement("Disconnected. Messages will send after reconnect.")
            } else {
                guard hasBeenDisconnected else {
                    bannerState = .hidden
                    return
                }
                bannerState = .reconnected
                postAccessibilityAnnouncement("Reconnected.")
                reconnectTask = Task {
                    try? await Task.sleep(for: reconnectBannerDuration)
                    guard !Task.isCancelled else { return }
                    await MainActor.run { bannerState = .hidden }
                }
            }
        }
    }

    @ViewBuilder
    private func bannerRow(
        text: String,
        dotColor: Color,
        accessibilityAnnouncement: String
    ) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 6, height: 6)
            Text(text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.background.secondary)
        .overlay(alignment: .bottom) {
            Divider()
        }
        // Live-region accessibility: always-mounted container so VoiceOver
        // hears updates without a new mount.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityAnnouncement)
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// A subtle session-stopped banner + VoiceOver live-region announcement,
/// ported from the Expo `SessionStoppedLiveRegion` component.
///
/// Shows "Session ended — read-only view" with an amber dot when `stopped`
/// is true. Like `ConnectionBanner`, the wrapper is always mounted so AT
/// tracks the stable live-region container.
struct SessionStoppedBanner: View {
    let stopped: Bool

    var body: some View {
        VStack(spacing: 0) {
            if stopped {
                HStack(spacing: 8) {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 6, height: 6)
                    Text("Session ended — read-only view")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.background.secondary)
                .overlay(alignment: .bottom) {
                    Divider()
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Session ended. Read-only view.")
                .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .onChange(of: stopped) { _, isStopped in
            if isStopped {
                postAccessibilityAnnouncement("Session ended. Read-only view.")
            }
        }
    }
}

// MARK: - Accessibility helpers

/// Post a VoiceOver/Accessibility announcement outside the view hierarchy.
///
/// Uses the UIAccessibility API on iOS/iPadOS and NSAccessibility on macOS.
/// The announcement is "polite" (not an interrupt), matching the `role=status`
/// semantic from the Expo live-region components.
func postAccessibilityAnnouncement(_ message: String) {
#if os(iOS) || os(visionOS)
    UIAccessibility.post(notification: .announcement, argument: message)
#elseif os(macOS)
    NSAccessibility.post(
        element: NSApp as AnyObject,
        notification: .announcementRequested,
        userInfo: [
            .announcement: message as NSString,
            .priority: NSAccessibilityPriorityLevel.medium.rawValue as NSNumber
        ]
    )
#endif
}
