import XCTest

@testable import Teleprompter

/// Minimal smoke test that runs on the iOS Simulator. Proves the test bundle
/// builds, links against the app target, and executes in the simulator runtime.
/// Real functional tests (codec/crypto round-trips, pairing, relay) extend this.
final class SmokeTests: XCTestCase {
    func testBootMarkerIsStable() {
        // The harness greps the Simulator log for this exact marker; if the
        // constant ever changes, scripts/ios.sh must change in lockstep.
        XCTAssertEqual(bootMarker, "TP_BOOT_OK")
    }

    func testAppTargetIsLinkable() {
        // Constructing a view from the app target confirms the test bundle is
        // wired to the host app. Compilation alone would catch link errors.
        _ = ContentView()
    }
}
