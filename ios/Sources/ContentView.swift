import SwiftUI

/// Boot marker used by the Simulator harness to confirm the app launched.
/// `scripts/ios.sh smoke` greps the Simulator log for this exact string. It is
/// *emitted* at app launch in `TeleprompterApp.init` (not here) so the marker is
/// independent of which view appears — see that file for the rationale (macOS
/// NavigationSplitView mounts its detail pane lazily under a backgrounded launch).
let bootMarker = "TP_BOOT_OK"

struct ContentView: View {
    /// Core status is owned by the app shell (so the probe fires at the root) and
    /// passed down for display. Defaults to "checking…" for the SwiftUI preview.
    var coreStatus: String = "checking…"

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Teleprompter")
                .font(.title.bold())
            Text("native rewrite — tp-core FFI")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(bootMarker)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("boot-marker")
            Text(coreStatus)
                .font(.caption.monospaced())
                .foregroundStyle(coreStatus.hasPrefix("TP_CORE_OK") ? .green : .secondary)
                .accessibilityIdentifier("core-status")
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
