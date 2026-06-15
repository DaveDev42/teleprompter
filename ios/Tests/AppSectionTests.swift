import XCTest
@testable import Teleprompter

/// Guards the shared navigation model (`AppSection`) that both platform shells
/// drive: the iOS `TabView` and the macOS `NavigationSplitView` sidebar (A4,
/// ADR-0002). The section list and its labels/icons live in one place so the two
/// shells can never drift; this test pins that contract.
final class AppSectionTests: XCTestCase {
    func testSectionOrderAndIdentity() {
        // Sessions first (the default macOS sidebar selection + first iOS tab),
        // then Chat, then Terminal. Order is user-facing on both shells.
        XCTAssertEqual(AppSection.allCases, [.sessions, .chat, .terminal])
        XCTAssertEqual(AppSection.sessions.id, "sessions")
        XCTAssertEqual(AppSection.chat.id, "chat")
        XCTAssertEqual(AppSection.terminal.id, "terminal")
    }

    func testEverySectionHasLabelAndIcon() {
        for section in AppSection.allCases {
            XCTAssertFalse(section.title.isEmpty, "\(section) has no title")
            XCTAssertFalse(section.systemImage.isEmpty, "\(section) has no SF Symbol")
        }
    }

    func testTitlesAreStable() {
        XCTAssertEqual(AppSection.sessions.title, "Sessions")
        XCTAssertEqual(AppSection.chat.title, "Chat")
        XCTAssertEqual(AppSection.terminal.title, "Terminal")
    }
}
