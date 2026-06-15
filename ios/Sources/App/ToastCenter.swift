import Foundation
import Observation

/// Data carried by a transient toast notification.
///
/// `sid` is optional — when set, tapping the toast navigates to that session.
struct ToastItem: Identifiable, Equatable {
    let id: UUID
    let title: String
    let body: String
    let sid: String?

    init(title: String, body: String, sid: String? = nil) {
        self.id = UUID()
        self.title = title
        self.body = body
        self.sid = sid
    }
}

/// App-wide singleton that drives the in-app toast overlay.
///
/// Any subsystem (relay event handler, notification service, etc.) can post a
/// toast by calling `ToastCenter.shared.show(…)`. Toasts auto-dismiss after
/// `autoDismissInterval` seconds; callers may dismiss early via `dismiss()`.
///
/// All mutations are `@MainActor` — callers off the main actor must
/// `Task { @MainActor in ToastCenter.shared.show(…) }`.
@MainActor
@Observable
final class ToastCenter {
    static let shared = ToastCenter()

    /// Currently displayed toast, or `nil` when none is active.
    private(set) var current: ToastItem?

    private var dismissTask: Task<Void, Never>?

    /// How long a toast stays visible before auto-dismissing (matches the old
    /// Expo notification-store: 5 000 ms).
    let autoDismissInterval: Duration = .seconds(5)

    private init() {}

    /// Show a toast. If one is already visible it is replaced immediately (the
    /// timer resets so the new toast gets a full display window).
    func show(_ item: ToastItem) {
        dismissTask?.cancel()
        current = item
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: self?.autoDismissInterval ?? .seconds(5))
            guard !Task.isCancelled else { return }
            self?.current = nil
        }
    }

    /// Convenience overload matching the old `showToast(title:body:sid:)` shape.
    func show(title: String, body: String, sid: String? = nil) {
        show(ToastItem(title: title, body: body, sid: sid))
    }

    /// Dismiss the current toast immediately and cancel the auto-dismiss timer.
    func dismiss() {
        dismissTask?.cancel()
        dismissTask = nil
        current = nil
    }
}
