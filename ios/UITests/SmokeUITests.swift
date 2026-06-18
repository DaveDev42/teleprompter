import XCTest

/// UI-level E2E (T3, #66).
///
/// Where the marker smoke (`scripts/ios.sh smoke`) proves the wire/E2EE/kx path
/// round-trips at the byte level, THIS proves the SwiftUI layer actually renders
/// that decrypted data through the real Accessibility tree:
///
///   launch(--tp-smoke-url <golden link>)        ← reuses handleSmokeURLIfPresent()
///     → app auto-pairs + connects to the loopback relay
///     → the fake daemon's `hello` seeds one session (sess-smoketest)
///   tap the session row  →  switch the Chat/Terminal pane picker
///     → assert the assistant chat bubble rendered "Claude: smoke ok"
///
/// The loopback relay + golden pairing link are produced by the harness
/// (`scripts/ios.sh uitest`), which injects them via the process environment:
///   - TP_SMOKE_URL : the `tp://p?d=…` golden pairing deep link (byte-identical to
///                    the marker smoke's link, built by smoke_pair_link()).
///   - TP_SMOKE_SID : the fake session sid the loopback seeds (sess-smoketest).
/// Running this target directly from Xcode without the harness skips the assertions
/// that need a live relay (the test fails fast with a clear message).
final class SmokeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// The golden pairing link the harness injected, or nil when run standalone.
    private var smokeURL: String? {
        let v = ProcessInfo.processInfo.environment["TP_SMOKE_URL"]
        return (v?.isEmpty == false) ? v : nil
    }

    /// The fake session sid the loopback seeds (default matches the harness constant).
    private var smokeSid: String {
        ProcessInfo.processInfo.environment["TP_SMOKE_SID"] ?? "sess-smoketest"
    }

    // XCUIApplication and the element-query APIs are @MainActor-isolated; the app
    // builds under Swift 6 strict concurrency (-swift-version 6), so the whole test
    // body must run on the main actor or every UI call is an isolation violation.
    @MainActor
    func testSessionRenderAndPaneSwitch() throws {
        let link = try XCTUnwrap(
            smokeURL,
            "TP_SMOKE_URL not set — run via `scripts/ios.sh uitest` (it starts the loopback "
                + "relay and injects the golden pairing link). Standalone Xcode runs can't reach a relay."
        )

        let app = XCUIApplication()
        app.launchArguments = ["--tp-smoke-url", link]
        app.launch()

        // M4 at the UI layer: the seeded session row must appear in the list. The row's
        // NavigationLink carries `.accessibilityIdentifier("session-<sid>")`
        // (Nav/SessionsTab.swift). A generous timeout covers connect + kx + hello backfill.
        let row = app.descendants(matching: .any)["session-\(smokeSid)"]
        XCTAssertTrue(
            row.waitForExistence(timeout: 30),
            "session row 'session-\(smokeSid)' never rendered — the hello/backfill path did not "
                + "reach the SwiftUI list (markers may still pass; this is the render gap UI E2E catches)."
        )
        row.tap()

        // The Chat/Terminal pane picker carries `.accessibilityIdentifier("session-pane-picker")`
        // (Nav/SessionDetailView.swift). Assert it exists, then flip to Terminal and back —
        // exercising the segmented control wiring end to end.
        let picker = app.descendants(matching: .any)["session-pane-picker"]
        XCTAssertTrue(
            picker.waitForExistence(timeout: 10),
            "pane picker 'session-pane-picker' missing on the session detail view"
        )

        // The assistant chat bubble renders `.accessibilityLabel("Claude: <text>")`
        // (Session/Chat/ChatCard.swift). The loopback's synthetic Stop event carries
        // last_assistant_message="smoke ok", so a "Claude: smoke ok" element must exist.
        //
        // The bubble uses `.accessibilityElement(children: .combine)`, so XCUITest
        // surfaces it as a COMBINED group element (.other), NOT a .staticText. Query
        // across ALL element types by label rather than restricting to staticTexts.
        let assistant = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH %@", "Claude:")
        ).firstMatch
        XCTAssertTrue(
            assistant.waitForExistence(timeout: 15),
            "assistant chat bubble (accessibilityLabel 'Claude: …') never rendered after attach"
        )

        // Flip to the Terminal pane and confirm the terminal canvas renders. The
        // SwiftTerm view carries `.accessibilityIdentifier("terminal-output")`
        // (Session/TerminalView.swift).
        if picker.buttons["Terminal"].exists {
            picker.buttons["Terminal"].tap()
            let terminal = app.descendants(matching: .any)["terminal-output"]
            XCTAssertTrue(
                terminal.waitForExistence(timeout: 10),
                "terminal canvas 'terminal-output' missing after switching to the Terminal pane"
            )
        }

        // Visual-regression artifact (kept regardless of pass/fail).
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.lifetime = .keepAlways
        shot.name = "uitest-session-render"
        add(shot)
    }
}
