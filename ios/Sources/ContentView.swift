import SwiftUI
import os

/// Boot marker used by the Simulator harness to confirm the app launched.
/// `scripts/ios.sh smoke` greps the Simulator log for this exact string.
let bootMarker = "TP_BOOT_OK"

private let bootLog = Logger(subsystem: "dev.tpmt.teleprompter", category: "boot")

struct ContentView: View {
    @State private var coreStatus = "checking…"

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
        .onAppear {
            // Emit the boot marker to the unified log for the headless harness.
            bootLog.notice("\(bootMarker, privacy: .public)")
            // Exercise the Rust core across the FFI boundary and emit its result
            // (TP_CORE_OK / TP_CORE_FAIL) so `scripts/ios.sh smoke` can verify
            // the static library is linked AND functional, not merely present.
            let summary = TpCoreCheck.summary()
            coreStatus = summary
            bootLog.notice("\(summary, privacy: .public)")
        }
    }
}

#Preview {
    ContentView()
}
