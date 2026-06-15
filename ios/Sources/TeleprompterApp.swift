import SwiftUI

/// Entry point for the native Teleprompter iOS app (ADR-0001 rewrite).
///
/// This is the harness baseline: a minimal SwiftUI app that boots on the
/// iOS Simulator. Real features (pairing, relay client, sessions, chat,
/// terminal) land on top of this shell as the rewrite progresses.
@main
struct TeleprompterApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
