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
/// `TextField` is first responder; `terminalPaneActive` is true while the
/// Terminal pane (whose SwiftTerm view owns the keyboard outside SwiftUI's
/// `@FocusState`) is on screen; `hasActiveDetail` is true while a
/// `SessionDetailView` is on screen. `inputCapturing` = `composerHasFocus ||
/// terminalPaneActive`. Session-movement commands (⌘[ / ⌘] / ⌘K) are disabled
/// when `inputCapturing || !hasActiveDetail`, and pane switches (⌃⌘C / ⌘T) only
/// when `composerHasFocus || !hasActiveDetail` (they stay reachable from the
/// terminal so the user can always leave it). Tab-nav (⌘1/2/3) is NOT gated — it
/// stays active everywhere, including while typing.
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

    /// `true` while the Terminal pane is the active pane of the on-screen session
    /// detail. The SwiftTerm view (a UIView/NSView) becomes first responder and
    /// receives EVERY hardware keystroke through its own responder chain, NOT
    /// through a SwiftUI `@FocusState`, so `composerHasFocus` never reflects it.
    /// Without this gate, ⌘[ / ⌘] / ⌘K would steal keystrokes from the live PTY —
    /// exactly where bracket/⌘K chords matter most — so those three gate on this
    /// (via `inputCapturing`). The pane switches (⌃⌘C / ⌘T) deliberately do NOT,
    /// so they stay reachable as the escape hatch out of the terminal.
    /// `SessionDetailView` sets this from its `pane` (true ⇔ `.terminal`) and
    /// clears it on disappear. ⌘F is unaffected — it lives in the TerminalView
    /// toolbar, not the gated chords.
    var terminalPaneActive: Bool = false

    /// Number of `SessionDetailView` instances currently on screen. Modeled as a
    /// depth counter, NOT a bare `Bool`: during a ⌘[ / ⌘] session step (or a ⌘K
    /// quick-switch) `SessionsTab` replaces `navPath` with a DIFFERENT sid, so
    /// SwiftUI pushes the incoming detail and pops the outgoing one — and it does
    /// NOT guarantee `onDisappear(old)` runs before `onAppear(new)`. With a Bool
    /// toggled per-instance, the common `new.onAppear` → `old.onDisappear` order
    /// would leave the flag stuck `false` while a detail is still on screen,
    /// permanently disabling the macOS session commands. Incrementing on appear
    /// and decrementing on disappear keeps the count ≥ 1 throughout the swap.
    /// Use `detailAppeared()` / `detailDisappeared()` — do not mutate directly.
    private(set) var activeDetailCount: Int = 0

    /// `true` while at least one `SessionDetailView` is on screen. Gates the
    /// macOS session commands (and is available to any consumer) so they are
    /// inert when no session detail is open.
    var hasActiveDetail: Bool { activeDetailCount > 0 }

    /// A `SessionDetailView` appeared. Pair with `detailDisappeared()`.
    func detailAppeared() {
        activeDetailCount += 1
    }

    /// A `SessionDetailView` disappeared. Clamped at 0 so an extra disappear
    /// (defensive) can never drive the count negative.
    func detailDisappeared() {
        activeDetailCount = max(0, activeDetailCount - 1)
    }

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

    /// `true` while *any* keyboard surface that should swallow the session chords
    /// is capturing input: a SwiftUI composer `TextField` (`composerHasFocus`) OR
    /// the SwiftTerm terminal view (`terminalPaneActive`). Session chords are
    /// inert while this is `true` so they never steal a keystroke from the field
    /// or the PTY the user is typing into.
    var inputCapturing: Bool {
        composerHasFocus || terminalPaneActive
    }

    /// Whether session-scoped shortcuts may fire right now: a detail screen is on
    /// screen and no composer/terminal is capturing keystrokes. Producers can use
    /// this to drive `.disabled(!nav.sessionCommandsEnabled)`.
    var sessionCommandsEnabled: Bool {
        hasActiveDetail && !inputCapturing
    }
}
