import SwiftUI

// MARK: - DiagnosticsView

/// Full diagnostics panel (feature-parity port of the old DiagnosticsPanel.tsx).
///
/// Wires real data where available; clearly marks anything not yet exposed with
/// a "TODO" note. Sections mirror the old app: Build, Connection, Relay/Pairing,
/// E2EE Crypto (tp-core round-trip), Session Summary.
///
/// Reads from `PairingStore.shared` directly (no PairingViewModel required) so
/// the caller only needs to pass `coreStatus` from the app shell.
struct DiagnosticsView: View {
    /// Rust-core FFI self-check result, forwarded from the app shell.
    let coreStatus: String

    @State private var daemonIds: [String] = []

    var body: some View {
        List {
            buildSection
            connectionSection
            relayPairingSection
            cryptoSection
            sessionSummarySection
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #else
        .listStyle(.inset)
        #endif
        .onAppear { daemonIds = PairingStore.shared.daemonIds() }
    }

    // MARK: Build / Version

    private var buildSection: some View {
        Section("BUILD") {
            DiagRow(label: "Version", value: appVersion)
            DiagRow(label: "Bundle ID", value: Bundle.main.bundleIdentifier ?? "—")
            DiagRow(label: "Platform", value: platformString)
            DiagRow(label: "tp-core FFI", value: coreStatus)
        }
    }

    // MARK: Connection

    private var connectionSection: some View {
        Section("CONNECTION") {
            // Relay WebSocket connected state is not yet exposed as an observable
            // property on PairingViewModel / RelayClient. The relay client has a
            // `state` enum but it's not surfaced through a shared observable yet.
            DiagRow(label: "Paired Daemons", value: "\(daemonIds.count)")
            DiagRow(label: "Relay WS", value: "TODO — relay state not yet wired")
            DiagRow(label: "Active Session", value: "TODO — session state not yet wired")
        }
    }

    // MARK: Relay / Pairing

    private var relayPairingSection: some View {
        Section("RELAY / PAIRING") {
            if daemonIds.isEmpty {
                DiagRow(label: "Pairing", value: "None")
            } else {
                ForEach(daemonIds, id: \.self) { did in
                    let pairing = try? PairingStore.shared.load(daemonId: did)
                    Group {
                        DiagRow(label: "Daemon ID", value: did)
                        DiagRow(label: "Relay URL", value: pairing?.relayURL ?? "—")
                        // E2EE state requires access to per-daemon RelayClient which
                        // is held in PairingViewModel (not accessible here without
                        // threading it through). TODO: expose via environment object.
                        DiagRow(label: "E2EE", value: "TODO — relay client state not yet wired")
                    }
                }
            }
        }
    }

    // MARK: E2EE / Crypto Self-Test

    @State private var cryptoResult: CryptoTestResult = .notRun
    @State private var cryptoRunning = false

    private var cryptoSection: some View {
        Section("E2EE CRYPTO (tp-core)") {
            DiagRow(label: "Platform", value: platformString)
            DiagRow(label: "Core self-test", value: cryptoSummary)

            Button {
                runCryptoTest()
            } label: {
                HStack {
                    if cryptoRunning {
                        ProgressView()
                            .scaleEffect(0.7)
                            .frame(width: 14, height: 14)
                    }
                    Text(cryptoRunning ? "Running…" : "Run tp-core Self-Test")
                        .font(.callout)
                        .foregroundStyle(cryptoRunning ? AnyShapeStyle(.secondary) : AnyShapeStyle(Color.accentColor))
                }
            }
            .disabled(cryptoRunning)
        }
    }

    private var cryptoSummary: String {
        switch cryptoResult {
        case .notRun:      return "—"
        case .ok(let ms):  return "OK (\(ms)ms)"
        case .fail(let e): return "FAIL: \(e)"
        }
    }

    private enum CryptoTestResult {
        case notRun
        case ok(ms: Int)
        case fail(String)
    }

    private func runCryptoTest() {
        guard !cryptoRunning else { return }
        cryptoRunning = true
        cryptoResult = .notRun
        Task.detached(priority: .userInitiated) {
            let t0 = Date()
            // TpCoreCheck.summary() runs encode→encrypt→decrypt→decode via UniFFI,
            // exercising the entire Rust core path from Swift. This is the same
            // self-test that fires at launch to emit TP_CORE_OK/TP_CORE_FAIL.
            let summary = TpCoreCheck.summary()
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            let result: CryptoTestResult = summary.hasPrefix("TP_CORE_OK")
                ? .ok(ms: ms)
                : .fail(summary)
            await MainActor.run {
                cryptoResult = result
                cryptoRunning = false
            }
        }
    }

    // MARK: Session Summary

    private var sessionSummarySection: some View {
        Section("SESSION SUMMARY") {
            // TODO: SessionStore is not yet injected into Settings. Session counts
            // will be wired once the Session tranche exposes the store through the
            // environment (SwiftUI environment object or @Observable singleton).
            DiagRow(label: "Total", value: "TODO — session store not yet wired")
            DiagRow(label: "Running", value: "TODO — session store not yet wired")
            DiagRow(label: "Stopped", value: "TODO — session store not yet wired")
        }
    }

    // MARK: Helpers

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        return "\(v) (\(b))"
    }

    private var platformString: String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #else
        return "unknown"
        #endif
    }
}

// MARK: - DiagRow

private struct DiagRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top) {
            Text(label)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.footnote.monospaced())
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
        }
    }
}
