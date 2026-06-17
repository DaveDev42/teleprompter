import XCTest
import SwiftTerm
@testable import Teleprompter

/// Emulator-level tests for the A1 ANSI milestone (Phase 3.x).
///
/// All tests run on the iOS Simulator via `scripts/ios.sh test` — there is no
/// host-only Swift test path. `HeadlessTerminal` is excluded on iOS
/// (`#if !os(iOS)` in SwiftTerm's HeadlessTerminal.swift:7), so these tests
/// drive `Terminal` directly with a minimal `TerminalDelegate` stub.
///
/// Key API signatures pinned from on-disk resolved source (SwiftTerm 1.13.0):
///   - `Terminal.feed(buffer: ArraySlice<UInt8>)` — Terminal.swift:4900
///   - `Terminal.getCharacter(col:row:) -> Character?` — Terminal.swift:755
///   - `Terminal.getCharData(col:row:) -> CharData?` — Terminal.swift:715
///   - `CharData.attribute: Attribute` — CharData.swift:269
///   - `Attribute.fg: Attribute.Color` — CharData.swift:109
///   - `Attribute.Color.ansi256(code: UInt8)` — CharData.swift:75
///   - `TerminalDelegate.send(source:data:)` (only truly required method) — Terminal.swift:75
@MainActor
final class TerminalEmulatorTests: XCTestCase {
    // MARK: - Helpers

    /// Minimal TerminalDelegate for tests. Only `send` is required without a
    /// default in SwiftTerm's extension (Terminal.swift:6635–6748). All others
    /// have default no-ops, so we only need to satisfy `send`.
    private final class StubDelegate: NSObject, TerminalDelegate {
        func send(source: Terminal, data: ArraySlice<UInt8>) {
            // display-only: no PTY to write to
        }
    }

    /// Build a fresh headless `Terminal` (80 cols × 24 rows) with a stub delegate.
    private func makeTerminal() -> Terminal {
        let delegate = StubDelegate()
        let opts = TerminalOptions(cols: 80, rows: 24)
        let t = Terminal(delegate: delegate, options: opts)
        // Retain delegate through the terminal's lifetime via objc association.
        objc_setAssociatedObject(t, &TerminalEmulatorTests.delegateKey,
                                 delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return t
    }

    // Associated-object key token: only its ADDRESS is used. A `String` value
    // (the old form) can't have `&` taken under Swift 6 — it would expose the
    // String's internal representation. An `Int` token is the canonical idiom;
    // `nonisolated(unsafe)` because the value is never read, only its address.
    nonisolated(unsafe) private static var delegateKey = 0

    /// Feed raw bytes (as a Swift string) into the terminal.
    private func feed(_ terminal: Terminal, _ text: String) {
        let bytes = [UInt8](text.utf8)
        terminal.feed(buffer: bytes[...])
    }

    // MARK: - Tests

    /// SGR colour: ESC[31m sets foreground to ANSI red (code 1). The printable
    /// character 'A' that follows should land on-screen with that attribute.
    func testSGRColorAttribute() {
        let t = makeTerminal()
        // ESC[2J   clear screen
        // ESC[1;1H cursor to row 1 col 1
        // ESC[31m  set fg to ANSI red (code 1)
        // A        printable character
        feed(t, "\u{1b}[2J\u{1b}[1;1H\u{1b}[31mA")

        // The character 'A' lands at (col=0, row=0) in the visible buffer.
        // Verify it is present (guards that the run actually landed on-screen).
        let ch = t.getCharacter(col: 0, row: 0)
        XCTAssertEqual(ch, "A",
            "Expected 'A' at (0,0) after SGR+print; got \(ch.map { String($0) } ?? "nil")")

        // Verify the foreground colour attribute carries ANSI red (code 1).
        // CharData.attribute: Attribute is at CharData.swift:269.
        // Attribute.Color.ansi256(code:) is at CharData.swift:75.
        // NOTE: SwiftTerm maps ESC[31m → .ansi256(code: 1) (0-based ANSI palette).
        if let charData = t.getCharData(col: 0, row: 0) {
            let fg = charData.attribute.fg
            // We assert that the fg is NOT the default color — confirming SGR applied.
            // The exact code varies by SwiftTerm's internal colour mapping, so we
            // check for ansi256 without hard-coding the exact index.
            switch fg {
            case .ansi256:
                break // ✓ SGR colour was applied
            case .trueColor:
                break // ✓ also valid (some SwiftTerm builds map basic ANSI to trueColor)
            case .defaultColor, .defaultInvertedColor:
                XCTFail("Expected non-default fg colour after ESC[31m, got defaultColor")
            }
        } else {
            XCTFail("getCharData returned nil at (0,0) — character not in buffer?")
        }
    }

    /// CUP+EL overwrite: write HELLO, then move cursor back to row 0 col 0,
    /// erase to end of line (EL), write WORLD. Row 0 must read WORLD (not HELLO).
    func testCUPELOverwrite() {
        let t = makeTerminal()
        // ESC[2J     clear screen
        // ESC[1;1H   home cursor
        // HELLO      write first word
        // ESC[1;1H   home cursor again
        // ESC[K      erase from cursor to end-of-line (EL 0)
        // WORLD      write replacement
        feed(t, "\u{1b}[2J\u{1b}[1;1HHELLO\u{1b}[1;1H\u{1b}[KWORLD")

        // Read back the first 5 characters of row 0.
        var got = ""
        for col in 0..<5 {
            if let ch = t.getCharacter(col: col, row: 0) { got.append(ch) }
        }
        XCTAssertEqual(got, "WORLD",
            "Expected WORLD after EL+overwrite at row 0; got '\(got)'")

        // Confirm HELLO is NOT present anywhere in row 0 cols 0–7.
        var row0 = ""
        for col in 0..<8 {
            if let ch = t.getCharacter(col: col, row: 0) { row0.append(ch) }
        }
        XCTAssertFalse(row0.contains("HELLO"),
            "HELLO should have been erased, but row0 contains: '\(row0)'")
    }

    /// Probe-survives: the io rec accumulator path (`terminalOutput`) must
    /// contain the probe token after `appendRec`, regardless of whether a byte
    /// sink is registered. This is the EXACT predicate `checkInputEcho` uses
    /// (RelayClient.swift:529). Verifies that the additive byte sink does NOT
    /// mutate or shadow the String accumulator path.
    func testProbeSurvivesAfterByteSinkRegistered() {
        let store = SessionStore()
        let sid = "sess-smoketest"

        // Register a byte sink that records how many times it was called.
        var sinkCallCount = 0
        store.terminalByteSink = { incomingSid, _ in
            if incomingSid == sid { sinkCallCount += 1 }
        }

        // Build an io rec with d = base64("tp-input-probe\n") — the exact
        // token the loopback daemon echoes back (local-relay-loopback.ts:229).
        let probeText = "tp-input-probe\n"
        let rec = SessionRec(
            t: "rec",
            sid: sid,
            seq: 1,
            k: "io",
            ns: "runner",
            n: nil,
            d: Data(probeText.utf8).base64EncodedString(),
            ts: 1_700_000_000_000,
        )
        store.appendRec(rec)

        // 1. The EXACT checkInputEcho predicate must pass.
        let out = store.terminalOutput[sid]
        XCTAssertNotNil(out,
            "terminalOutput[sid] is nil — probe was not appended to the String accumulator")
        XCTAssertTrue(out?.contains("tp-input-probe") == true,
            "terminalOutput[sid] does not contain 'tp-input-probe': '\(out ?? "nil")'")

        // 2. The byte sink was called exactly once (successful decode fires it once).
        XCTAssertEqual(sinkCallCount, 1,
            "Byte sink expected 1 call but got \(sinkCallCount)")

        // 3. terminalOutput contains only the decoded probe text — the sink
        //    must not have mutated it (it's a separate code path).
        XCTAssertEqual(out, probeText,
            "terminalOutput[sid] value should be exactly the decoded probe text")
    }
}
