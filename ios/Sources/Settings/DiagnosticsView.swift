import SwiftUI

// MARK: - DiagnosticsView

/// Full diagnostics panel (feature-parity port of the old DiagnosticsPanel.tsx).
///
/// H10: Wired with PairingViewModel + SessionStore (read-only) so the relay WS
/// state, E2EE status, and session counts are live data rather than TODO stubs.
/// M12: Exposes RTT metric with a "Ping" button that triggers an on-demand
/// relay.ping and displays the round-trip time with a VoiceOver announcement.
///
/// Sections mirror the old app: Build, Connection, Relay/Pairing, E2EE Crypto
/// (tp-core round-trip), Session Summary.
struct DiagnosticsView: View {
    /// Rust-core FFI self-check result, forwarded from the app shell.
    let coreStatus: String
    /// H10: PairingViewModel for relay WS state, E2EE status, RTT (M12).
    /// Optional so the caller in SettingsTab can inject it without API breakage.
    var pairings: PairingViewModel? = nil
    /// H10: SessionStore for session counts and per-session cursors (lastSeq).
    /// Optional — nil falls back to the old "TODO" placeholder text.
    var sessionStore: SessionStore? = nil

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
            DiagRow(label: "Paired Daemons", value: "\(daemonIds.count)")
            // H10: relay WS state from RelayClient.state via PairingViewModel.
            if let pairings {
                ForEach(pairings.daemonIds, id: \.self) { did in
                    DiagRow(
                        label: "Relay WS (\(String(did.prefix(8))))",
                        value: relayStateString(for: did, pairings: pairings)
                    )
                }
                if pairings.daemonIds.isEmpty {
                    DiagRow(label: "Relay WS", value: "No pairings")
                }
            } else {
                DiagRow(label: "Relay WS", value: "—")
            }
            // H10: active session count from SessionStore.
            if let store = sessionStore {
                DiagRow(
                    label: "Active Session",
                    value: store.sessions.values.first(where: { $0.state == "running" })
                        .map { String($0.sid.prefix(12)) } ?? "None"
                )
            } else {
                DiagRow(label: "Active Session", value: "—")
            }
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
                        // H10: E2EE status from PairingViewModel.isOnline / isConnected.
                        DiagRow(
                            label: "E2EE",
                            value: e2eeStatusString(for: did)
                        )
                        // M12: RTT row with Ping button.
                        rttRow(for: did)
                    }
                }
            }
        }
    }

    /// Human-readable relay WS state string for the given daemon.
    private func relayStateString(for daemonId: String, pairings: PairingViewModel) -> String {
        guard let client = pairings.client(for: daemonId) else { return "Not connected" }
        switch client.state {
        case .idle:                          return "Idle"
        case .connecting:                    return "Connecting…"
        case .authenticating:                return "Authenticating…"
        case .authenticated(let did):        return "Authenticated (\(String(did.prefix(8))))"
        case .failed(let reason):            return "Failed: \(reason)"
        }
    }

    /// Human-readable E2EE status string for the given daemon.
    private func e2eeStatusString(for daemonId: String) -> String {
        guard let pairings else { return "—" }
        if pairings.isOnline(daemonId) { return "OK (online + kx complete)" }
        if pairings.isConnected(daemonId) { return "KX complete (offline)" }
        return "Not ready"
    }

    // MARK: M12 RTT Row

    /// RTT metric row: shows the latest ping RTT and a "Ping" button that
    /// triggers an on-demand relay.ping. Includes a VoiceOver live-region
    /// announcement when the result arrives.
    @ViewBuilder
    private func rttRow(for daemonId: String) -> some View {
        if pairings != nil {
            RTTRow(daemonId: daemonId, pairings: pairings!)
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

    /// H10: Session counts from SessionStore (total / running / stopped).
    private var sessionSummarySection: some View {
        Section("SESSION SUMMARY") {
            if let store = sessionStore {
                let all = store.sessions.values
                let total = all.count
                let running = all.filter { $0.state == "running" }.count
                let stopped = all.filter { $0.state == "stopped" }.count
                DiagRow(label: "Total", value: "\(total)")
                DiagRow(label: "Running", value: "\(running)")
                DiagRow(label: "Stopped", value: "\(stopped)")
                // Per-session last seq (cursor) from store.cursor(for:).
                if !all.isEmpty {
                    ForEach(Array(store.sessions.keys.prefix(5)), id: \.self) { sid in
                        DiagRow(
                            label: "seq (\(String(sid.prefix(8))))",
                            value: "\(store.cursor(for: sid))"
                        )
                    }
                }
            } else {
                DiagRow(label: "Total", value: "—")
                DiagRow(label: "Running", value: "—")
                DiagRow(label: "Stopped", value: "—")
            }
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

// MARK: - RTTRow (M12)

/// Inline RTT metric row for one daemon in the Diagnostics panel.
///
/// Shows the latest measured round-trip time (in ms) and a "Ping" button
/// that triggers an on-demand relay.ping for an immediate measurement.
/// Announces the result via a VoiceOver live-region (polite) once it arrives.
private struct RTTRow: View {
    let daemonId: String
    let pairings: PairingViewModel

    @State private var pinging = false
    @State private var announcement: String = ""

    private var rttValue: String {
        if let ms = pairings.rtt(for: daemonId) { return "\(ms)ms" }
        return "—"
    }

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Ping RTT")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(pinging ? "Pinging…" : rttValue)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.primary)
                    // SR live-region: announces the RTT result to VoiceOver.
                    .accessibilityLabel(announcement.isEmpty ? "Ping RTT: \(rttValue)" : announcement)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            Spacer()
            Button {
                sendPing()
            } label: {
                Text("Ping")
                    .font(.footnote)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(pinging)
            .accessibilityLabel("Send ping to measure round-trip time")
        }
        // Watch the rtt value so we can clear the pinging state and announce.
        .onChange(of: pairings.rtt(for: daemonId)) { _, newRTT in
            if pinging, let ms = newRTT {
                pinging = false
                announcement = "Ping round-trip time: \(ms) milliseconds"
                postAccessibilityAnnouncement(announcement)
            }
        }
    }

    private func sendPing() {
        guard !pinging else { return }
        pinging = true
        announcement = ""
        pairings.sendPing(to: daemonId)
        // Safety fallback: clear pinging state after 5s if no pong arrives.
        Task {
            try? await Task.sleep(for: .seconds(5))
            await MainActor.run {
                if pinging {
                    pinging = false
                    announcement = "Ping timed out"
                    postAccessibilityAnnouncement("Ping timed out")
                }
            }
        }
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
