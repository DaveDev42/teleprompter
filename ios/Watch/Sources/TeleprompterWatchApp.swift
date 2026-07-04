import SwiftUI
import os

/// Entry point for the standalone Teleprompter watchOS app (ADR-0002 Phase B3).
///
/// Emits TP_BOOT_OK + TP_CORE_OK markers at process launch (same pattern as
/// TeleprompterApp.swift on iOS/macOS) so the harness can verify launch + Rust
/// FFI linkage without a full smoke UI pass.
///
/// This is a standalone WKApplication (INFOPLIST_KEY_WKApplication_IsIndependentApp
/// = YES) — not a watchOS extension of the iOS app. It shares the relay/pairing/
/// session layers with the main app but exposes a glance-only UI: session list +
/// last assistant message + approve/deny buttons.
@main
struct TeleprompterWatchApp: App {
    @State private var sessionStore: SessionStore
    @State private var pairings: WatchPairingViewModel

    private static let bootLog = Logger(subsystem: "dev.tpmt.app", category: "boot")
    private static let smokeLog = Logger(subsystem: "dev.tpmt.app", category: "deeplink")

    init() {
        let store = SessionStore()
        _sessionStore = State(initialValue: store)
        _pairings = State(initialValue: WatchPairingViewModel(sessionStore: store))

        // Emit boot + core markers at process launch — not from a view's onAppear
        // (same rationale as TeleprompterApp.swift: app struct is instantiated
        // before any window appears, so this fires reliably on every platform).
        Self.bootLog.notice("TP_BOOT_OK")
        let summary = TpCoreCheck.summary()
        Self.bootLog.notice("\(summary, privacy: .public)")
    }

    // MARK: - Smoke harness deep-link injection

    /// Handle `--tp-smoke-url <url>` launch argument — allows the harness to
    /// inject a `tp://` pairing deep link without going through LaunchServices.
    /// Only fires if the argument is present; strict no-op in normal execution.
    ///
    /// Called from `onAppear` after the window is established.
    private func handleSmokeURLIfPresent() {
        let args = ProcessInfo.processInfo.arguments
        guard let idx = args.firstIndex(of: "--tp-smoke-url"),
            idx + 1 < args.count
        else { return }
        let raw = args[idx + 1]
        Self.smokeLog.notice("smoke url injection: \(raw, privacy: .public)")
        guard let url = URL(string: raw) else {
            Self.smokeLog.error("smoke url invalid: \(raw, privacy: .public)")
            return
        }
        if case .pending(let pairingId) = DeepLinkHandler.handle(url) {
            pairings.reloadPending()
            pairings.beginPending(pairingId: pairingId)
        } else {
            pairings.reloadPending()
        }
    }

    var body: some Scene {
        WindowGroup {
            WatchRootView(sessionStore: sessionStore, pairings: pairings)
                .onOpenURL { url in
                    Self.smokeLog.notice("onOpenURL url=\(url.absoluteString, privacy: .public)")
                    if case .pending(let pairingId) = DeepLinkHandler.handle(url) {
                        pairings.reloadPending()
                        pairings.beginPending(pairingId: pairingId)
                    } else {
                        pairings.reloadPending()
                    }
                }
                .onAppear {
                    handleSmokeURLIfPresent()
                }
        }
    }
}

// MARK: - WatchPairingViewModel

/// Minimal pairing/relay view-model scoped to the watch app.
///
/// Mirrors the relevant surface of `PairingViewModel` in TeleprompterApp.swift
/// without pulling in UIKit-only or macOS-only dependencies. The watch app is
/// read-mostly (glance), so the full feature set (QR scan, rename, remove) is
/// not needed here.
@MainActor
@Observable
final class WatchPairingViewModel {
    private(set) var daemonIds: [String] = []
    private let store: PairingStore
    @ObservationIgnored private let sessionStore: SessionStore
    @ObservationIgnored private var clients: [String: RelayClient] = [:]
    /// PR-4 (connect-on-pending): relay clients for PENDING pairings, keyed by
    /// pairingId. Mirrors `PairingViewModel` — a pending client runs the full
    /// handshake and promotes to `clients` on kx completion.
    @ObservationIgnored private var pendingClients: [String: RelayClient] = [:]
    @ObservationIgnored private let pendingMaxAge: TimeInterval = 24 * 60 * 60

    init(store: PairingStore = .shared, sessionStore: SessionStore) {
        self.store = store
        self.sessionStore = sessionStore
        for pid in store.gcPending(olderThan: pendingMaxAge) {
            pendingClients[pid]?.disconnect()
            pendingClients.removeValue(forKey: pid)
        }
        reload()
        // Reconnect any committed pairing that survived a relaunch.
        for did in daemonIds { connect(daemonId: did) }
        // Resume connect-on-pending for every pending pairing (§1.5).
        for pid in store.pendingIds() { beginPending(pairingId: pid) }
    }

    func reload() {
        daemonIds = store.daemonIds()
    }

    /// The watch glance has no pending-row UI; this exists so the ingest hooks can
    /// call it symmetrically with the phone app (a no-op refresh).
    func reloadPending() {}

    /// Open a relay connection for one daemon and authenticate.
    func connect(daemonId: String) {
        guard let pairing = try? store.load(daemonId: daemonId) else { return }
        clients[daemonId]?.disconnect()
        let client = RelayClient(pairing: pairing)
        client.sessionStore = sessionStore
        clients[daemonId] = client
        client.connect()
    }

    /// Connect-on-pending (PR-4): drive a PENDING pairing through kx; on completion
    /// promote it (re-keying the same live client into `clients`, no reconnect).
    func beginPending(pairingId: String) {
        guard pendingClients[pairingId] == nil else { return }
        guard let pairing = try? store.loadPending(pairingId: pairingId) else { return }
        let client = RelayClient(pairing: pairing)
        client.sessionStore = sessionStore
        client.onPairingConfirmed = { [weak self] pid in
            Task { @MainActor [weak self] in self?.promoteConfirmed(pairingId: pid) }
        }
        pendingClients[pairingId] = client
        client.connect()
    }

    private func promoteConfirmed(pairingId: String) {
        guard let client = pendingClients[pairingId] else { return }
        guard let pending = try? store.loadPending(pairingId: pairingId) else {
            client.disconnect()
            pendingClients.removeValue(forKey: pairingId)
            return
        }
        let daemonId = pending.daemonId
        do { try store.promote(pairingId: pairingId) } catch { return }
        pendingClients.removeValue(forKey: pairingId)
        if let stale = clients[daemonId], stale !== client { stale.disconnect() }
        client.onPairingConfirmed = nil
        clients[daemonId] = client
        reload()
    }

    /// Connection readiness for a daemon — `true` once kx completes.
    func isConnected(_ daemonId: String) -> Bool {
        clients[daemonId]?.isReady ?? false
    }

    /// Send a text line into a session (approve / deny).
    func sendInput(sid: String, text: String) {
        clients.values.first?.sendInput(sid: sid, kind: .chat, text: text)
    }

    /// Read-only: the first connected daemon id, if any.
    var firstDaemonId: String? { daemonIds.first }

    /// Overall connection status (at least one daemon connected).
    var anyConnected: Bool { daemonIds.contains { isConnected($0) } }
}
