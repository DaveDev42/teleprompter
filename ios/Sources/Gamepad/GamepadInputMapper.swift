import Foundation

// MARK: - GamepadInputMapper
//
// Pure mapping from standard-layout gamepad snapshots to semantic navigation
// actions (see GamepadCoordinator.swift for the GameController/SwiftUI side).
// A faithful Swift port of the old Expo web bridge's `gamepad-input-mapper.ts`
// (PR #624) — the wire conventions are preserved byte-for-byte so behavior
// matches the web app the rewrite replaces:
//
//   - Standard-mapping button indices (A=0, B=1, LB=4, RB=5, D-pad 12-15).
//   - 0.5 stick threshold (not a drift deadzone — the stick emulates discrete
//     D-pad taps, so a half-press makes accidental moves from a grazed stick
//     impossible).
//   - DOWN-POSITIVE Y: y > threshold = down, y < -threshold = up. This matches
//     the W3C Gamepad axis convention used by the TS source. GameController's
//     `GCControllerDirectionPad.yAxis` is UP-positive, so `GamepadCoordinator`
//     inverts Y when reading a live pad into a snapshot — this type always sees
//     the down-positive convention.
//   - Edge-triggered diff (an action fires only on the released→pressed frame;
//     no auto-repeat in v1).
//   - D-pad and left stick merge into one digital direction (pressing both does
//     not double-fire).
//
// Kept dependency-free (snapshots are plain value types) so the edge-trigger and
// threshold rules are unit-testable without GameController, exactly as the TS
// version was testable without `navigator.getGamepads()`.

/// Digital pad state sampled once per tick.
struct GamepadSnapshot: Equatable {
    /// `pressed` per standard-mapping button index (missing index = `false`).
    var buttons: [Bool]
    /// Analog axes; only 0 (left stick X) and 1 (left stick Y, down-positive)
    /// are read.
    var axes: [Float]

    init(buttons: [Bool] = [], axes: [Float] = [0, 0]) {
        self.buttons = buttons
        self.axes = axes
    }
}

/// Semantic navigation actions produced by `GamepadInputMapper.diff`.
enum GamepadNavAction: String, Equatable, Sendable {
    case focusUp = "focus-up"
    case focusDown = "focus-down"
    case focusLeft = "focus-left"
    case focusRight = "focus-right"
    case activate
    case back
    case tabPrev = "tab-prev"
    case tabNext = "tab-next"
}

enum GamepadInputMapper {

    // Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping):
    // 0=A, 1=B, 4=LB, 5=RB, 12-15=D-pad up/down/left/right.
    static let buttonA = 0
    static let buttonB = 1
    static let buttonLB = 4
    static let buttonRB = 5
    static let buttonDpadUp = 12
    static let buttonDpadDown = 13
    static let buttonDpadLeft = 14
    static let buttonDpadRight = 15

    /// The left stick must travel past this fraction of full deflection before
    /// it counts as a digital direction press. 0.5 (not the usual 0.1-0.2 drift
    /// deadzone) because the stick emulates discrete D-pad taps here — a
    /// half-press threshold makes accidental focus moves from a resting or
    /// grazed stick impossible.
    static let axisThreshold: Float = 0.5

    /// Collapsed digital state per semantic key (D-pad ∪ stick for directions).
    private struct DigitalState: Sendable {
        var up = false
        var down = false
        var left = false
        var right = false
        var activate = false
        var back = false
        var tabPrev = false
        var tabNext = false
    }

    /// Collapse buttons + left stick into one digital state per direction.
    private static func toDigitalState(_ snap: GamepadSnapshot) -> DigitalState {
        func b(_ i: Int) -> Bool { i >= 0 && i < snap.buttons.count && snap.buttons[i] }
        let x = snap.axes.indices.contains(0) ? snap.axes[0] : 0
        let y = snap.axes.indices.contains(1) ? snap.axes[1] : 0
        var s = DigitalState()
        // DOWN-POSITIVE Y convention (matches the TS source / W3C Gamepad).
        s.up = b(buttonDpadUp) || y < -axisThreshold
        s.down = b(buttonDpadDown) || y > axisThreshold
        s.left = b(buttonDpadLeft) || x < -axisThreshold
        s.right = b(buttonDpadRight) || x > axisThreshold
        s.activate = b(buttonA)
        s.back = b(buttonB)
        s.tabPrev = b(buttonLB)
        s.tabNext = b(buttonRB)
        return s
    }

    /// Ordered (key, action) pairs — fixes the deterministic emit order for
    /// simultaneous presses (directions before activate/back, matching the TS
    /// `ACTION_BY_KEY` table so ported tests stay green).
    ///
    /// `nonisolated(unsafe)`: this is an immutable `let` constant computed once at
    /// load and never mutated, so it cannot race. The Swift 6 checker still flags
    /// it because a `[(KeyPath<…>, …)]` tuple-array type isn't provably Sendable
    /// (the element types are Sendable, but a tuple of them is not auto-Sendable),
    /// and a private `KeyPath` literal can't be hoisted to a Sendable context.
    /// Marking the constant unsafe is the right tool: there is no mutable state.
    nonisolated(unsafe) private static let actionByKey:
        [(KeyPath<DigitalState, Bool>, GamepadNavAction)] = [
            (\.up, .focusUp),
            (\.down, .focusDown),
            (\.left, .focusLeft),
            (\.right, .focusRight),
            (\.activate, .activate),
            (\.back, .back),
            (\.tabPrev, .tabPrev),
            (\.tabNext, .tabNext),
        ]

    /// Edge-triggered diff: an action fires only on the frame its input goes
    /// from released to pressed. Holding a button emits nothing further (no
    /// auto-repeat in v1), and `prev == nil` (first frame after connect / pad
    /// switch) treats every active input as a fresh press.
    static func diff(prev: GamepadSnapshot?, next: GamepadSnapshot) -> [GamepadNavAction] {
        let prevState = prev.map(toDigitalState)
        let nextState = toDigitalState(next)
        var actions: [GamepadNavAction] = []
        for (key, action) in actionByKey {
            if nextState[keyPath: key] && !(prevState?[keyPath: key] ?? false) {
                actions.append(action)
            }
        }
        return actions
    }
}
