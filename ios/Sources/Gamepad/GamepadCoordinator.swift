import Foundation
import os

#if canImport(GameController)
import GameController
#endif
#if canImport(QuartzCore)
import QuartzCore
#endif

private let log = Logger(subsystem: "dev.tpmt.app", category: "gamepad")

// MARK: - GamepadCoordinator
//
// The GameController + SwiftUI glue around the pure `GamepadInputMapper`. Native
// counterpart of the old Expo web bridge `use-gamepad-nav.ts` (PR #624), mapping
// standard-layout MFi/Xbox/PlayStation controller input onto the app's existing
// navigation semantics via `AppNavigationModel`:
//
//   - LB / RB        → cycle the top-level tabs (Sessions ↔ Daemons ↔ Settings),
//                      wrapping; suppressed while a session detail is on screen
//                      so the bumpers don't yank the user off an open session.
//   - A              → activate the focused control. On the Sessions list this
//                      opens the focused session (the roving `@FocusState` token
//                      in `SessionListView`); elsewhere it is a best-effort no-op
//                      (native focus + Return already covers buttons).
//   - B              → back, priority chain: leave the Terminal pane → pop the
//                      session detail. (SwiftUI dismisses sheets via their own
//                      gestures / Esc; B intentionally does not force-dismiss a
//                      modal here — the priority chain stays predictable.)
//   - D-pad / stick  → move focus. Routed to `SessionListView`'s roving focus via
//                      a monotonic focus-move token; when the Terminal pane is
//                      active ONLY `back` acts (the PTY owns every keystroke),
//                      matching the web bridge's `isTerminalFocused` guard.
//
// # Polling, not events
//
// GameController surfaces input through per-element value handlers, but to keep
// the edge-trigger + threshold rules in ONE tested place (`GamepadInputMapper`)
// we instead sample a full snapshot once per tick and diff it — exactly the rAF
// poll the web bridge used. The tick runs ONLY while ≥1 controller is connected
// (CADisplayLink on iOS/visionOS, a Timer on macOS where CADisplayLink needs a
// view); it self-stops when the last pad disconnects.
//
// # Pad-identity baseline
//
// `prev` is tagged with the controller it came from. If the active pad changes
// (first disconnects, the poll moves to the next) we re-baseline (`prev = nil`)
// instead of diffing across two physical pads — otherwise every button the new
// pad happens to hold would fire a phantom edge (incl. the wake-up press some
// controllers send on connect).
@MainActor
@Observable
final class GamepadCoordinator {
    static let shared = GamepadCoordinator()

    // MARK: - Focus-move intent (consumed by SessionListView's roving @FocusState)

    /// Monotonic token bumped on every D-pad / stick direction press while a
    /// focusable list is on screen. `SessionListView` observes the change and
    /// moves its `@FocusState` selection by `focusDelta` (with wrap). A token +
    /// delta pair (not a bare delta) so two consecutive same-direction presses
    /// still fire `.onChange`. Vertical lists only consume up/down; left/right
    /// are recorded too for any future horizontal consumer.
    private(set) var focusMove: Int = 0

    /// The most recent focus-move direction: `-1` = up/left (previous), `+1` =
    /// down/right (next). Read by the consumer when `focusMove` changes.
    private(set) var focusDelta: Int = 0

    /// Monotonic token bumped when `A` is pressed — the focused-list consumer
    /// activates its current `@FocusState` selection (opens the session).
    private(set) var activateToken: Int = 0

    /// `true` once `activate()` has wired up GameController observation, so the
    /// idempotent guard prevents double-registration if the root view re-appears.
    @ObservationIgnored private var started = false

    // MARK: - Poll state

    @ObservationIgnored private var prev: GamepadSnapshot?
    /// Which physical controller `prev` belongs to (identity baseline). Guarded
    /// like every other GameController reference so the file stays compilable on
    /// a hypothetical platform without the framework (the watch target excludes
    /// this file outright, but the discipline is kept consistent).
    #if canImport(GameController)
    @ObservationIgnored private weak var activePad: GCController?
    #endif

    #if canImport(QuartzCore) && !os(macOS)
    @ObservationIgnored private var displayLink: CADisplayLink?
    #endif
    #if os(macOS)
    @ObservationIgnored private var timer: Timer?
    #endif

    private init() {}

    // MARK: - Lifecycle

    /// Begin observing controller connect/disconnect. Idempotent — safe to call
    /// from `RootView.onAppear` on every appearance. No-op if GameController is
    /// unavailable (e.g. some watchOS contexts; the watch target excludes this
    /// file entirely, but the canImport guard keeps it portable).
    func activate() {
        #if canImport(GameController)
        guard !started else { return }
        started = true

        let nc = NotificationCenter.default
        nc.addObserver(
            forName: .GCControllerDidConnect, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.controllersChanged() }
        }
        nc.addObserver(
            forName: .GCControllerDidDisconnect, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.controllersChanged() }
        }
        // Pads already paired before launch don't post a connect notification.
        controllersChanged()
        #endif
    }

    #if canImport(GameController)
    /// React to the connected-controller set changing: start the tick when the
    /// first pad arrives, stop it (and reset the baseline) when the last leaves.
    private func controllersChanged() {
        let pads = GCController.controllers()
        if pads.isEmpty {
            stopTick()
            prev = nil
            activePad = nil
            log.notice("Gamepad: no controllers — tick stopped")
        } else {
            startTick()
            log.notice("Gamepad: \(pads.count) controller(s) connected")
        }
    }

    /// The first connected controller exposing an extended gamepad profile.
    private func firstExtendedPad() -> GCController? {
        for pad in GCController.controllers() where pad.extendedGamepad != nil {
            return pad
        }
        return nil
    }
    #endif

    // MARK: - Tick

    private func startTick() {
        #if canImport(QuartzCore) && !os(macOS)
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tickSelector))
        link.add(to: .main, forMode: .common)
        displayLink = link
        #elseif os(macOS)
        guard timer == nil else { return }
        // ~60 Hz; the diff is cheap and edge-triggered so a coarse tick is fine.
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        #endif
    }

    private func stopTick() {
        #if canImport(QuartzCore) && !os(macOS)
        displayLink?.invalidate()
        displayLink = nil
        #elseif os(macOS)
        timer?.invalidate()
        timer = nil
        #endif
    }

    #if canImport(QuartzCore) && !os(macOS)
    @objc private func tickSelector() {
        // CADisplayLink calls on the main thread; hop to the actor explicitly.
        MainActor.assumeIsolated { self.tick() }
    }
    #endif

    /// One poll: read the active pad → snapshot → diff → apply actions.
    private func tick() {
        #if canImport(GameController)
        guard let pad = firstExtendedPad(), let gp = pad.extendedGamepad else {
            // All pads gone between notification and tick — drain the baseline.
            prev = nil
            activePad = nil
            return
        }
        // Identity baseline: re-baseline when the active pad changes so a button
        // held by the newly-active pad never fires a phantom edge.
        if pad !== activePad {
            prev = nil
            activePad = pad
        }
        let snapshot = readSnapshot(gp)
        let actions = GamepadInputMapper.diff(prev: prev, next: snapshot)
        prev = snapshot
        for action in actions { apply(action) }
        #endif
    }

    #if canImport(GameController)
    /// Copy a live `GCExtendedGamepad` into a plain snapshot in the
    /// standard-mapping index order the pure mapper expects.
    ///
    /// Y is INVERTED here: `GCControllerDirectionPad.yAxis` is UP-positive, but
    /// `GamepadInputMapper` (a 1:1 port of the W3C/Gamepad-API web source) uses
    /// the DOWN-positive convention. Inverting at the boundary keeps the mapper's
    /// `y > threshold = down` rule (and its ported tests) untouched.
    private func readSnapshot(_ gp: GCExtendedGamepad) -> GamepadSnapshot {
        var buttons = [Bool](repeating: false, count: 16)
        buttons[GamepadInputMapper.buttonA] = gp.buttonA.isPressed
        buttons[GamepadInputMapper.buttonB] = gp.buttonB.isPressed
        buttons[GamepadInputMapper.buttonLB] = gp.leftShoulder.isPressed
        buttons[GamepadInputMapper.buttonRB] = gp.rightShoulder.isPressed
        buttons[GamepadInputMapper.buttonDpadUp] = gp.dpad.up.isPressed
        buttons[GamepadInputMapper.buttonDpadDown] = gp.dpad.down.isPressed
        buttons[GamepadInputMapper.buttonDpadLeft] = gp.dpad.left.isPressed
        buttons[GamepadInputMapper.buttonDpadRight] = gp.dpad.right.isPressed

        let x = gp.leftThumbstick.xAxis.value
        let y = -gp.leftThumbstick.yAxis.value  // UP-positive → DOWN-positive
        return GamepadSnapshot(buttons: buttons, axes: [x, y])
    }
    #endif

    // MARK: - Action dispatch

    /// Map a semantic action onto `AppNavigationModel` / focus-move intents.
    /// Mirrors the web bridge's `executeAction` priority semantics, adapted to
    /// native navigation (no DOM; SwiftUI owns focus + dismissal).
    private func apply(_ action: GamepadNavAction) {
        let nav = AppNavigationModel.shared

        // Terminal pane swallows raw input — only `back` acts there (leave the
        // terminal so the next press navigates), matching isTerminalFocused().
        if nav.terminalPaneActive {
            if action == .back { leaveTerminalOrPop(nav) }
            return
        }

        switch action {
        case .focusUp, .focusLeft:
            focusDelta = -1
            focusMove &+= 1
        case .focusDown, .focusRight:
            focusDelta = 1
            focusMove &+= 1
        case .activate:
            activateToken &+= 1
        case .back:
            // No terminal active here → pop the session detail if one is open.
            if nav.hasActiveDetail { nav.requestBack() }
        case .tabPrev, .tabNext:
            // Bumpers cycle tabs only at the top level — while a session detail
            // is open they'd yank the user off it, so suppress (web: also
            // suppressed under a modal / on the session screen's own tablist).
            guard !nav.hasActiveDetail else { break }
            cycleTab(by: action == .tabNext ? 1 : -1, nav: nav)
        }
    }

    /// B inside the Terminal pane: switch back to Chat (the always-present escape
    /// hatch); if somehow no detail context, fall through to a back request.
    private func leaveTerminalOrPop(_ nav: AppNavigationModel) {
        if nav.hasActiveDetail {
            nav.cyclePane(to: .chat)
        } else {
            nav.requestBack()
        }
    }

    /// Cycle `selectedTab` over `AppTab.allCases` with wrap (LB/RB), matching the
    /// ⌘1/2/3 targets and the web bridge's TAB_ROUTES order.
    private func cycleTab(by delta: Int, nav: AppNavigationModel) {
        let tabs = AppTab.allCases
        guard let idx = tabs.firstIndex(of: nav.selectedTab) else { return }
        let next = (idx + delta + tabs.count) % tabs.count
        nav.selectedTab = tabs[next]
    }
}
