import Foundation

// MARK: - AppNavigationModel (keyboard-shortcut & cross-shell navigation)

/// Process-lifetime, `@MainActor`-isolated navigation model that carries
/// keyboard-shortcut and cross-context navigation intents to the SwiftUI shells.
///
/// This mirrors the `SessionNavigator` singleton pattern (see
/// `NotificationService.swift`): a single shared `@Observable` instance used as
/// a side-channel between code that is *outside* a given view's environment
/// (Commands menu on macOS, hidden global shortcut buttons on iOS) and the
/// views that consume the intents (`RootView` / `MacRootView` for tab selection,
/// `SessionDetailView` for pane switching, `SessionsTab` for prev/next + quick
/// switch).
///
/// # The ONE source of truth
///
/// `selectedTab` is the single tab-selection source of truth. Both shells bind
/// their tab/sidebar selection to it (the iOS `TabView` selection and the macOS
/// `NavigationSplitView` sidebar `List(selection:)`), so a ⌘1/⌘2/⌘3 shortcut,
/// a notification tap, and a sidebar arrow-key move all write the same field.
///
/// # Intent fields (consumed-and-cleared)
///
/// `paneIntent`, `sessionStep`, and `showQuickSwitcher` are *intents*: a producer
/// sets them, a single consumer observes the change, acts, and (for `paneIntent`)
/// clears it. They are intentionally NOT placed in the SwiftUI environment for
/// the same reason `SessionNavigator` is not — the producers (menu commands,
/// global hidden buttons) live where environment injection is unavailable.
///
/// # Focus / availability gates
///
/// `composerHasFocus` is published by the chat/terminal composers while their
/// `TextField` is first responder; `hasActiveDetail` is true while a
/// `SessionDetailView` is on screen. Session commands are disabled when either
/// gate forbids them (`composerHasFocus || !hasActiveDetail`) so the shortcuts
/// are inert while typing and when no session is open. Tab-nav (⌘1/2/3) is NOT
/// gated — it stays active everywhere, including while typing.
@MainActor
@Observable
final class AppNavigationModel {
    static let shared = AppNavigationModel()
    private init() {}

    // MARK: - Tab selection (single source of truth)

    /// The selected top-level tab. Both the iOS `TabView` and the macOS
    /// `NavigationSplitView` sidebar bind their selection to this field, so every
    /// producer (⌘1/2/3, notification tap, sidebar arrow keys) writes one place.
    var selectedTab: AppTab = .sessions

    // MARK: - Session-pane intent (consumed + cleared by SessionDetailView)

    /// Request to switch the active session detail to a specific pane
    /// (Chat ⌃⌘C / Terminal ⌘T). `SessionDetailView` observes this, sets its
    /// `$pane`, then clears it back to `nil`. `nil` = idle / nothing pending.
    var paneIntent: SessionPane? = nil

    // MARK: - Prev/next session step (consumed by SessionsTab)

    /// Monotonic request token bumped on every ⌘[ / ⌘] press. `SessionsTab`
    /// observes the change to know a *new* step was requested even when the
    /// direction repeats (two consecutive ⌘] presses), then reads `stepDirection`
    /// to know which way to move. A token + direction pair avoids the "same value
    /// twice in a row doesn't fire `.onChange`" trap of a bare delta.
    private(set) var sessionStep: Int = 0

    /// The direction of the most recent `step(_:)` request: `-1` = previous,
    /// `+1` = next. Read by `SessionsTab` when `sessionStep` changes.
    private(set) var stepDirection: Int = 0

    // MARK: - Quick switcher (consumed by SessionsTab)

    /// Drives the ⌘K quick-switcher sheet. `SessionsTab` presents a sheet over
    /// its `navPath` when this is `true`; selecting a session sets the nav path
    /// and flips this back to `false`.
    var showQuickSwitcher: Bool = false

    // MARK: - Focus / availability gates

    /// `true` while a chat or terminal composer `TextField` is first responder.
    /// Session shortcuts are disabled while this is `true` so chords don't fire
    /// mid-typing. Composers must reset this to `false` on disappear / pane change
    /// so a torn-down composer can't leave focus stuck `true`.
    var composerHasFocus: Bool = false

    /// `true` while a `SessionDetailView` is on screen. Gates the macOS session
    /// commands (and is available to any consumer) so they are inert when no
    /// session detail is open. `SessionDetailView` sets it on appear/disappear.
    var hasActiveDetail: Bool = false

    // MARK: - Convenience helpers

    /// Request the active session detail switch to `pane` (⌃⌘C / ⌘T).
    func cyclePane(to pane: SessionPane) {
        paneIntent = pane
    }

    /// Request a prev/next session move. `dir` is `-1` (previous) or `+1` (next);
    /// any nonzero value is normalized to its sign. Bumps `sessionStep` so the
    /// consumer's `.onChange` fires even on a repeated direction.
    func step(_ dir: Int) {
        guard dir != 0 else { return }
        stepDirection = dir > 0 ? 1 : -1
        sessionStep &+= 1
    }

    /// Request the ⌘K quick-switcher sheet.
    func openQuickSwitcher() {
        showQuickSwitcher = true
    }

    /// Whether session-scoped shortcuts may fire right now: a detail screen is on
    /// screen and no composer is capturing keystrokes. Producers can use this to
    /// drive `.disabled(!nav.sessionCommandsEnabled)`.
    var sessionCommandsEnabled: Bool {
        hasActiveDetail && !composerHasFocus
    }
}
