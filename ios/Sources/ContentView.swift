import SwiftUI
import os

/// Boot marker used by the Simulator harness to confirm the app launched.
/// `scripts/ios.sh smoke` greps the Simulator log for this exact string.
let bootMarker = "TP_BOOT_OK"

private let bootLog = Logger(subsystem: "dev.tpmt.teleprompter", category: "boot")

struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("Teleprompter")
                .font(.title.bold())
            Text("native rewrite — harness baseline")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(bootMarker)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("boot-marker")
        }
        .padding()
        .onAppear {
            // Emitted to the unified log so the headless harness can verify boot.
            bootLog.notice("\(bootMarker, privacy: .public)")
        }
    }
}

#Preview {
    ContentView()
}
