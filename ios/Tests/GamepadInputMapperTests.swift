import XCTest

@testable import Teleprompter

/// Unit tests for `GamepadInputMapper.diff` — a 1:1 port of the old Expo web
/// bridge's `gamepad-input-mapper.test.ts` (PR #624, 12 tests). Pinning the
/// edge-trigger, 0.5 threshold, D-pad∪stick merge, deterministic emit order, and
/// down-positive-Y conventions keeps the native mapper byte-compatible with the
/// web behavior it replaces. Pure value types → no GameController / Simulator.
final class GamepadInputMapperTests: XCTestCase {

    /// Build a snapshot from a sparse list of pressed button indices + axes,
    /// mirroring the TS test helper `snap(pressed, axes)`.
    private func snap(_ pressed: [Int] = [], _ axes: [Float] = [0, 0]) -> GamepadSnapshot {
        let maxIdx = pressed.max() ?? -1
        var buttons = [Bool](repeating: false, count: maxIdx + 1)
        for i in pressed { buttons[i] = true }
        return GamepadSnapshot(buttons: buttons, axes: axes)
    }

    private typealias M = GamepadInputMapper

    // MARK: - diff

    func testButtonPressEdgesMapToSemanticActions() {
        let idle = snap()
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonA])), [.activate])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonB])), [.back])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonLB])), [.tabPrev])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonRB])), [.tabNext])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonDpadUp])), [.focusUp])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonDpadDown])), [.focusDown])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonDpadLeft])), [.focusLeft])
        XCTAssertEqual(M.diff(prev: idle, next: snap([M.buttonDpadRight])), [.focusRight])
    }

    func testHeldButtonDoesNotRefire() {
        let held = snap([M.buttonA])
        XCTAssertEqual(M.diff(prev: held, next: held), [])
        XCTAssertEqual(M.diff(prev: held, next: snap([M.buttonA, M.buttonRB])), [.tabNext])
    }

    func testReleasingAButtonEmitsNothing() {
        XCTAssertEqual(M.diff(prev: snap([M.buttonB]), next: snap()), [])
    }

    func testNilPrevTreatsActiveInputsAsFreshPresses() {
        XCTAssertEqual(M.diff(prev: nil, next: snap([M.buttonA])), [.activate])
        XCTAssertEqual(M.diff(prev: nil, next: snap()), [])
    }

    func testSimultaneousPressesEmitInDeterministicOrder() {
        // Direction before activate, matching the TS ACTION_BY_KEY ordering.
        XCTAssertEqual(
            M.diff(prev: snap(), next: snap([M.buttonA, M.buttonDpadDown])),
            [.focusDown, .activate]
        )
    }

    func testLeftStickPastThresholdActsAsDpadPress() {
        let idle = snap()
        // DOWN-POSITIVE Y: -1 = up, +1 = down.
        XCTAssertEqual(M.diff(prev: idle, next: snap([], [0, -1])), [.focusUp])
        XCTAssertEqual(M.diff(prev: idle, next: snap([], [0, 1])), [.focusDown])
        XCTAssertEqual(M.diff(prev: idle, next: snap([], [-1, 0])), [.focusLeft])
        XCTAssertEqual(M.diff(prev: idle, next: snap([], [1, 0])), [.focusRight])
    }

    func testStickDeflectionInsideThresholdIsIgnored() {
        let idle = snap()
        XCTAssertEqual(
            M.diff(prev: idle, next: snap([], [M.axisThreshold, -M.axisThreshold])),
            []
        )
        XCTAssertEqual(M.diff(prev: idle, next: snap([], [0.3, -0.3])), [])
    }

    func testHeldStickDeflectionDoesNotRefireUntilRecenter() {
        let deflected = snap([], [0, 1])
        XCTAssertEqual(M.diff(prev: deflected, next: deflected), [])
        XCTAssertEqual(M.diff(prev: deflected, next: snap([], [0, 0.9])), [])
        // Recenter, then deflect again → fresh edge.
        let centered = snap()
        XCTAssertEqual(M.diff(prev: deflected, next: centered), [])
        XCTAssertEqual(M.diff(prev: centered, next: snap([], [0, 1])), [.focusDown])
    }

    func testDpadButtonAndStickMapToSameDirectionNoDoubleFire() {
        // Stick already holds "down"; pressing the D-pad down button is not a
        // new edge because the merged digital state was already active.
        XCTAssertEqual(
            M.diff(prev: snap([], [0, 1]), next: snap([M.buttonDpadDown], [0, 1])),
            []
        )
    }

    func testMissingButtonIndicesAndShortAxesReadAsReleased() {
        XCTAssertEqual(
            M.diff(
                prev: GamepadSnapshot(buttons: [], axes: []),
                next: GamepadSnapshot(buttons: [], axes: [])),
            []
        )
        XCTAssertEqual(
            M.diff(prev: nil, next: GamepadSnapshot(buttons: [true], axes: [])),
            [.activate]
        )
    }

    // MARK: - GamepadSnapshot value semantics
    //
    // The TS `readGamepadSnapshot` (live Gamepad → plain data) has no Swift
    // equivalent — GameController reading lives in GamepadCoordinator. These pin
    // the snapshot value type the coordinator constructs: a short/absent axes
    // array reads as centered (0), and Equatable holds for caching prev frames.

    func testSnapshotDefaultsAndEquatable() {
        let a = GamepadSnapshot(buttons: [true, false], axes: [0.25, -0.75])
        let b = GamepadSnapshot(buttons: [true, false], axes: [0.25, -0.75])
        XCTAssertEqual(a, b)
        // Absent axes default to [0, 0] → centered, no direction fires.
        let empty = GamepadSnapshot()
        XCTAssertEqual(empty.axes, [0, 0])
        XCTAssertEqual(M.diff(prev: nil, next: empty), [])
    }
}
