import SwiftUI

/// App-wide toast overlay. Attach this to the root window group content via
/// `.toastOverlay()` so it floats above every tab and sheet.
///
/// Ported from the Expo `InAppToast` component:
/// - Always present in the accessibility tree (never conditionally mounted) so
///   VoiceOver picks up live-region announcements on the first update.
/// - `accessibilityAddTraits(.updatesFrequently)` requests polite announcements
///   (closest SwiftUI equivalent to `accessibilityLiveRegion="polite"`).
/// - Tapping the body navigates to `toast.sid` when set (mirrors the Expo
///   onPress handler that pushed to `/session/<sid>`).
///
/// Drop web-only aria-atomic hacks — SwiftUI's VoiceOver integration handles
/// atomic region updates natively.
struct ToastOverlay: View {
    @State private var center = ToastCenter.shared
    /// Navigation callback — the host (RootView) passes a closure that pushes
    /// to the session detail. Nil until a session navigator is wired up (Phase 3).
    var onNavigateToSession: ((String) -> Void)?

    var body: some View {
        // The overlay is always mounted; visibility is driven purely by
        // the content, never by conditional mounting. This ensures
        // VoiceOver always has a stable live-region node.
        ZStack(alignment: .top) {
            // Transparent tap-through spacer keeps the ZStack stable even
            // when no toast is shown, without blocking underlying touches.
            Color.clear
                .allowsHitTesting(false)

            if let toast = center.current {
                toastCard(toast)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    // Tell VoiceOver to announce changes to this region
                    // (polite — user is not interrupted).
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        // Accessibility: announce changes as a live region (polite priority).
        .accessibilityElement(children: .contain)
        .animation(.spring(duration: 0.3), value: center.current?.id)
    }

    @ViewBuilder
    private func toastCard(_ toast: ToastItem) -> some View {
        HStack(spacing: 0) {
            // Tappable body: navigate when sid is set, otherwise just dismiss.
            Button {
                center.dismiss()
                if let sid = toast.sid {
                    onNavigateToSession?(sid)
                }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(toast.title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text(toast.body)
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12)
                .padding(.leading, 16)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open: \(toast.title): \(toast.body)")

            // Dismiss button.
            Button {
                center.dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notification")
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }
}

extension View {
    /// Attach the app-wide toast overlay to this view.
    ///
    /// Usage:
    /// ```swift
    /// RootView(…)
    ///     .toastOverlay()
    /// ```
    func toastOverlay(onNavigateToSession: ((String) -> Void)? = nil) -> some View {
        overlay(alignment: .top) {
            ToastOverlay(onNavigateToSession: onNavigateToSession)
                // Ignore safe area so the toast can appear under the status bar,
                // matching the Expo `top: insets.top + 8` positioning.
                .ignoresSafeArea(edges: .top)
        }
    }
}
