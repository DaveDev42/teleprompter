import XCTest

@testable import Teleprompter

/// Guards the shared navigation model (`AppTab` + `SessionPane`) that both platform
/// shells drive: the iOS `TabView` and the macOS `NavigationSplitView` sidebar.
/// The tab list and its labels/icons live in one place so the two shells can never
/// drift; this test pins that contract.
final class AppTabTests: XCTestCase {
    func testTabOrderAndIdentity() {
        // Sessions first (the default macOS sidebar selection + first iOS tab),
        // then Daemons, then Settings.
        XCTAssertEqual(AppTab.allCases, [.sessions, .daemons, .settings])
        XCTAssertEqual(AppTab.sessions.id, "sessions")
        XCTAssertEqual(AppTab.daemons.id, "daemons")
        XCTAssertEqual(AppTab.settings.id, "settings")
    }

    func testEveryTabHasLabelAndIcon() {
        for tab in AppTab.allCases {
            XCTAssertFalse(tab.title.isEmpty, "\(tab) has no title")
            XCTAssertFalse(tab.systemImage.isEmpty, "\(tab) has no SF Symbol")
        }
    }

    func testTabTitlesAreStable() {
        XCTAssertEqual(AppTab.sessions.title, "Sessions")
        XCTAssertEqual(AppTab.daemons.title, "Daemons")
        XCTAssertEqual(AppTab.settings.title, "Settings")
    }

    func testSessionPaneOrderAndTitles() {
        XCTAssertEqual(SessionPane.allCases, [.chat, .terminal])
        XCTAssertEqual(SessionPane.chat.title, "Chat")
        XCTAssertEqual(SessionPane.terminal.title, "Terminal")
    }

    func testAppThemeColorSchemes() {
        XCTAssertNil(AppTheme.system.colorScheme)
        XCTAssertEqual(AppTheme.dark.colorScheme, .dark)
        XCTAssertEqual(AppTheme.light.colorScheme, .light)
    }
}
