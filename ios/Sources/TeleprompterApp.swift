import SwiftUI
import UserNotifications
import os

/// Entry point for the native Teleprompter iOS app (ADR-0001 rewrite).
///
/// Boots on the iOS Simulator and routes inbound `tp://` deep links (pairing
/// bundles) to `DeepLinkHandler` via SwiftUI's `.onOpenURL`. On a successful
/// pairing (and on relaunch with existing pairings) it opens a relay connection
/// and authenticates as `role=frontend` (M2). Sessions/chat/terminal land on top
/// of this shell as the rewrite progresses (Phase 3 M3+).
///
/// `.onOpenURL` only fires once the Info.plist declares a scene manifest
/// (`UIApplicationSceneManifest`); without it the iOS 26 Simulator drops inbound
/// URL contexts. The manifest is set in `project.yml` (`info.properties`).
@main
struct TeleprompterApp: App {
    // APNs device-token callbacks are only delivered to the platform's app
    // delegate, which SwiftUI's App lifecycle does not expose. Install a minimal
    // adaptor per platform so `didRegisterForRemoteNotificationsWithDeviceToken`
    // reaches `PushTokenStore` → relay clients (`relay.push.register`).
    //
    // iOS + visionOS are UIKit-backed → `UIApplicationDelegate`. macOS is
    // AppKit-backed → `NSApplicationDelegate` (a separate adaptor type). The
    // adaptors are inert until APNs calls them, so installing them on every
    // platform is safe even before the `aps-environment` entitlement ships
    // (see PushRegistration.swift / NotificationService.swift).
    #if os(iOS) || os(visionOS)
    @UIApplicationDelegateAdaptor(TeleprompterAppDelegate.self) private var appDelegate
    #elseif os(macOS)
    @NSApplicationDelegateAdaptor(TeleprompterMacAppDelegate.self) private var appDelegate
    #endif

    /// The single session store, shared by every relay client (each writes the
    /// sessions it serves) and observed by the Chat tab (M4).
    @State private var sessionStore: SessionStore
    @State private var pairings: PairingViewModel
    /// Rust-core self-check result, computed once at launch and surfaced in the UI.
    private let coreStatus: String
    private let log = Logger(subsystem: "dev.tpmt.app", category: "deeplink")
    private static let bootLog = Logger(subsystem: "dev.tpmt.app", category: "boot")

    init() {
        let store = SessionStore()
        _sessionStore = State(initialValue: store)
        _pairings = State(initialValue: PairingViewModel(sessionStore: store))

        // Emit the boot + core markers at process launch — NOT from a view's
        // onAppear. The app struct is instantiated before any window appears, so
        // this fires regardless of platform chrome. macOS (A4) launches its
        // window in the background during the headless smoke (`open -gn`) and its
        // NavigationSplitView detail pane mounts lazily, so a view-appearance hook
        // is unreliable there. "Did the app launch + is the Rust core live" is an
        // app-level fact, so the app shell is the correct emitter.
        Self.bootLog.notice("\(bootMarker, privacy: .public)")
        let summary = TpCoreCheck.summary()
        Self.bootLog.notice("\(summary, privacy: .public)")
        coreStatus = summary
    }

    // MARK: - Smoke harness deep-link injection

    /// Handle `--tp-smoke-url <url>` launch argument — allows the harness to
    /// inject a `tp://` deep link without going through LaunchServices routing
    /// (which requires OS-level URL-scheme approval on Simulator builds with
    /// ad-hoc signing). Only fires if the argument is present, so it is a
    /// strict no-op in normal app execution.
    ///
    /// Called from `onAppear` after the window is established (required on iOS
    /// so `PairingViewModel` bindings are wired before `connect()` is called).
    private func handleSmokeURLIfPresent() {
        let args = ProcessInfo.processInfo.arguments
        guard let idx = args.firstIndex(of: "--tp-smoke-url"),
            idx + 1 < args.count
        else { return }
        let raw = args[idx + 1]
        let smokeLog = Logger(subsystem: "dev.tpmt.app", category: "deeplink")
        smokeLog.notice("smoke url injection: \(raw, privacy: .public)")
        guard let url = URL(string: raw) else {
            smokeLog.error("smoke url invalid: \(raw, privacy: .public)")
            return
        }
        if case .pending(let pairingId) = DeepLinkHandler.handle(url) {
            pairings.reloadPending()
            pairings.beginPending(pairingId: pairingId)
        } else {
            pairings.reloadPending()
        }
    }

    /// Set up notification authorization + APNs scaffold at scene-connection
    /// time (after the window scene is established, which is required for
    /// `UIApplication.shared.registerForRemoteNotifications` on iOS).
    ///
    /// `NotificationService.setup()` is Simulator-safe: it requests
    /// UNUserNotificationCenter authorization (works everywhere) and guards the
    /// APNs registration call behind `#if os(iOS)` so macOS never calls it.
    private func setupNotifications() {
        Task { @MainActor in
            NotificationService.shared.setup()
        }
    }

    /// Keyboard shortcut help sheet visibility (driven from Commands menu + ⌘/).
    @State private var showShortcutHelp = false

    var body: some Scene {
        WindowGroup {
            RootView(
                pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus,
                showShortcutHelp: $showShortcutHelp
            )
            // Start observing MFi/Xbox/PlayStation controllers. Idempotent —
            // the coordinator's `started` guard makes re-appearances no-ops.
            // The tick only runs while ≥1 pad is connected (self-stops at zero).
            .onAppear { GamepadCoordinator.shared.activate() }
            .onOpenURL { url in
                self.log.notice("onOpenURL url=\(url.absoluteString, privacy: .public)")
                if case .pending(let pairingId) = DeepLinkHandler.handle(url) {
                    pairings.reloadPending()
                    // M2: connect to the relay as soon as a pairing lands so the
                    // auth round-trip happens on-device (emits TP_RELAY_AUTH_OK).
                    pairings.beginPending(pairingId: pairingId)
                } else {
                    pairings.reloadPending()
                }
            }
            // M13: toast overlay with session navigation wired up.
            // When the user taps a toast that carries a `sid`, the closure
            // posts to SessionNavigator so the root view switches to the
            // Sessions tab (and SessionsTab pushes the detail once it
            // observes the pendingSid).
            .toastOverlay(onNavigateToSession: { sid in
                SessionNavigator.shared.pendingSid = sid
            })
            // Shortcut help sheet, toggled by ⌘/ or the Help menu (macOS).
            .shortcutHelpSheet(isPresented: $showShortcutHelp)
            // Notification setup after the scene is ready.
            // Also handle --tp-smoke-url harness injection (bypasses
            // LaunchServices URL routing, which is unreliable for sideloaded
            // apps on iOS 26.5 Simulator with ad-hoc signing).
            .onAppear {
                setupNotifications()
                handleSmokeURLIfPresent()
            }
            // A4: a desktop window must not collapse below a usable size. The
            // sidebar (~220) + a readable terminal column needs ~640×480 floor.
            // No-op on iOS/visionOS where the scene fills the device/space.
            #if os(macOS)
            .frame(minWidth: 640, minHeight: 480)
            #endif
        }
        // A4 (macOS): open at a comfortable desktop size and clamp shrink to the
        // content's declared minimum so the chrome never overlaps the content.
        #if os(macOS)
        .defaultSize(width: 980, height: 680)
        .windowResizability(.contentMinSize)
        // Suppress SwiftUI's auto-generated File > New Window for the MAIN
        // window. Without this, the system "New Window" command clones the
        // main window (the app is single-instance by design — one sidebar +
        // detail; a duplicate main window is the bug Dave hit). Per-session
        // pop-outs go through the value-carrying "session" WindowGroup below
        // instead. `.commandsRemoved()` only drops THIS group's default
        // commands; our explicit `.commands { MacCommands }` menu bar is
        // unaffected.
        .commandsRemoved()
        .commands {
            MacCommands(
                pairings: pairings, showShortcutHelp: $showShortcutHelp,
                nav: AppNavigationModel.shared)
        }
        #elseif os(visionOS)
        // B2 (visionOS): open at a comfortable spatial-window size — wide enough
        // for the terminal column, tall enough for the tab bar and content. The
        // system may adjust for the user's environment; this is the initial size.
        .defaultSize(width: 960, height: 640)
        #endif

        // Per-session window (messenger-style pop-out, macOS). A VALUE-carrying
        // WindowGroup, kept as a SEPARATE top-level Scene (not chained onto the
        // main group's modifier list — a value-carrying WindowGroup can't be a
        // continuation of another group's `.commands`/`.defaultSize` chain
        // inside one `#if`, which the SceneBuilder rejects). `openWindow(id:
        // "session", value: sid)` opens (or re-focuses — SwiftUI dedups by
        // presentation value) a window bound to one session's sid, so a
        // specific session lives in its own window instead of the main window
        // being cloned. `sessionStore`/`pairings` are the same app-lifetime
        // instances the main window uses, so records stream into both.
        #if os(macOS)
        WindowGroup(id: "session", for: String.self) { $sid in
            if let sid {
                SessionWindowView(
                    sid: sid, sessionStore: sessionStore, pairings: pairings)
            }
        }
        .defaultSize(width: 820, height: 620)
        .windowResizability(.contentMinSize)
        // Do NOT auto-open a window for this scene at launch. On macOS SwiftUI
        // instantiates one window per top-level Scene at startup; for a
        // value-carrying WindowGroup(id:for:) that means an EMPTY window with a
        // nil binding (the `if let sid` renders no content, but the NSWindow
        // chrome still exists — a phantom 2nd window on every fresh launch,
        // caught by testMacPerSessionWindowAndNoDuplicateMain). `.suppressed`
        // keeps the scene registered so `openWindow(id:"session", value: sid)`
        // still pops out a per-session window on demand, but nothing opens
        // unbidden at launch. macOS 15+ (deployment floor raised to 15.0).
        .defaultLaunchBehavior(.suppressed)
        #endif
    }
}

/// A PENDING pairing surfaced to the UI as a "Confirming…" row (PR-4).
///
/// A pending pairing has decoded + persisted but not yet completed the kx
/// handshake, so it has no COMMITTED daemon record. `daemonId`/`hostname` are for
/// display only; the identity key is `pairingId`.
struct PendingPairing: Identifiable, Equatable {
    let pairingId: String
    let daemonId: String
    let hostname: String
    /// Present when the last connection attempt surfaced an error (retryable).
    var lastError: String?

    var id: String { pairingId }
}

/// Observable list of paired daemons, backed by `PairingStore`.
///
/// Also owns the live relay clients (M2): one per paired daemon, started on
/// pairing and on a relaunch with existing pairings. Holding the clients here
/// keeps their sockets alive for the app's lifetime.
///
/// `@MainActor`: an `@Observable` view-model consumed by SwiftUI. Its mutable
/// state (`daemonIds`, `daemonOnline`, `clients`) is driven from views and from
/// RelayClient callbacks that already hop here via `Task { @MainActor in }`, so
/// main-actor isolation is the natural home and lets those `@Sendable` callbacks
/// capture `self` legally.
@MainActor
@Observable
final class PairingViewModel {
    private(set) var daemonIds: [String] = []
    private let store: PairingStore
    /// Shared session store injected into every relay client so decrypted records
    /// land in one place the Chat tab observes (M4).
    @ObservationIgnored private let sessionStore: SessionStore
    /// Retained relay clients keyed by daemon id (kept out of observation —
    /// the socket lifecycle is not view state).
    @ObservationIgnored private var clients: [String: RelayClient] = [:]
    /// PR-4 (connect-on-pending): retained relay clients for PENDING pairings,
    /// keyed by **pairingId** (§1.6 — a re-pair reuses the daemon but mints a new
    /// pairingId, so daemonId would collide). A pending client runs the full
    /// connect→auth→kx handshake; on kx completion it promotes to `clients`.
    @ObservationIgnored private var pendingClients: [String: RelayClient] = [:]
    /// Age cutoff for GC'ing pending pairings that never completed kx (§1.3).
    @ObservationIgnored private let pendingMaxAge: TimeInterval = 24 * 60 * 60

    /// PR-4: observable list of PENDING pairings for the "Confirming…" UI rows.
    /// Populated from `store.pendingIds()`; a row drops off when its pairing
    /// promotes to COMMITTED or is GC'd.
    private(set) var pendingPairings: [PendingPairing] = []
    /// M8: Per-daemon online presence, as observed by status dots.
    /// Keyed by daemonId; true = daemon is connected to relay & has signalled presence.
    /// Observable (NOT @ObservationIgnored) so status dots update reactively.
    private(set) var daemonOnline: [String: Bool] = [:]
    /// BATCH F (#10/#15): per-daemon reason for the current disconnected/
    /// degraded state (e.g. "relay busy (backpressure)", "network lost",
    /// "sending too fast"), or absent when the connection is healthy. Mirrors
    /// `daemonOnline`'s wiring — set from `RelayClient.onConnectionCauseChange`,
    /// cleared automatically by the client on the next successful auth.
    /// Observable so `ConnectionBanner` can render it reactively.
    private(set) var connectionCause: [String: String] = [:]

    private let log = Logger(subsystem: "dev.tpmt.app", category: "pairing-vm")

    init(store: PairingStore = .shared, sessionStore: SessionStore) {
        self.store = store
        self.sessionStore = sessionStore
        // Sweep pending pairings that never completed kx across prior sessions,
        // disposing any leftover client for each (§1.6). Runs before we enumerate.
        for pid in store.gcPending(olderThan: pendingMaxAge) {
            pendingClients[pid]?.disconnect()
            pendingClients.removeValue(forKey: pid)
        }
        reload()
        reloadPending()
        // Reconnect any COMMITTED pairing that survived a relaunch.
        for did in daemonIds { connect(daemonId: did) }
        // Resume connect-on-pending for every PENDING pairing (§1.5): while the app
        // is up, a client-less PENDING cannot structurally exist — this closes the
        // chicken-and-egg where a pending record could never reach kx.
        for pid in store.pendingIds() { beginPending(pairingId: pid) }
    }

    func reload() {
        daemonIds = store.daemonIds()
        // M9: refresh observable label cache so DaemonRow re-renders after any rename.
        refreshLabels()
    }

    /// Refresh the observable `pendingPairings` list from the store, preserving any
    /// `lastError` already surfaced for a still-pending row.
    func reloadPending() {
        let priorErrors = Dictionary(
            pendingPairings.map { ($0.pairingId, $0.lastError) }, uniquingKeysWith: { a, _ in a })
        pendingPairings = store.pendingIds().compactMap { pid in
            guard let p = try? store.loadPending(pairingId: pid) else { return nil }
            return PendingPairing(
                pairingId: pid, daemonId: p.daemonId, hostname: p.hostname,
                lastError: priorErrors[pid] ?? nil)
        }
    }

    /// Open a relay connection for one daemon and authenticate.
    ///
    /// Always rebuilds the client from the freshly-loaded pairing: a re-pair can
    /// change the secret or relay URL, and a stale client would auth with the old
    /// secret (wrong token). Any existing client for this daemon is torn down first.
    func connect(daemonId: String) {
        guard let pairing = try? store.load(daemonId: daemonId) else { return }
        clients[daemonId]?.disconnect()
        let client = RelayClient(pairing: pairing)
        client.sessionStore = sessionStore

        // M8: wire presence callback → observable daemonOnline dict.
        client.onPresence = { [weak self] did, online in
            Task { @MainActor [weak self] in
                self?.daemonOnline[did] = online
            }
        }

        // BATCH F (#10/#15): wire connection-cause callback → observable
        // connectionCause dict. `nil` means "clear the entry" (reconnected).
        client.onConnectionCauseChange = { [weak self] cause in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let cause {
                    self.connectionCause[daemonId] = cause
                } else {
                    self.connectionCause.removeValue(forKey: daemonId)
                }
            }
        }

        // H7: inbound control.unpair from daemon → remove our side of the pairing.
        client.onUnpair = { [weak self] did, reason in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log.notice(
                    "control.unpair from daemon \(did, privacy: .public) reason=\(reason, privacy: .public) — removing pairing"
                )
                // Remove local pairing (do NOT send another control.unpair back — we received this).
                self.clients[did]?.disconnect()
                self.clients[did] = nil
                self.daemonOnline.removeValue(forKey: did)
                self.connectionCause.removeValue(forKey: did)
                self.store.remove(daemonId: did)
                self.reload()
            }
        }

        // H8: inbound control.rename from daemon → persist new label.
        client.onRename = { [weak self] did, newLabel in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log.notice(
                    "control.rename from daemon \(did, privacy: .public) label=\(newLabel ?? "(clear)", privacy: .public)"
                )
                self.store.setLabel(newLabel, for: did)
                // Trigger observation by reloading (daemonIds array itself didn't change,
                // but downstream consumers reading label(for:) should refresh).
                self.reload()
            }
        }

        clients[daemonId] = client
        client.connect()
    }

    /// Connect-on-pending (PR-4, §1.6): open a relay client for a PENDING pairing
    /// and drive it through connect→auth→kx. On kx completion the pairing promotes
    /// to COMMITTED (`promoteConfirmed`) — the SAME live client is re-keyed into
    /// `clients`, never reconnected (the confirming kx epoch IS the confirmation).
    ///
    /// Idempotent: a second call for the same pairingId (double-scan / re-ingest of
    /// the same QR) is a no-op while a client already exists, so we never run two
    /// kx exchanges for one frontendId and clobber the daemon's peers map (§1.6).
    func beginPending(pairingId: String) {
        guard pendingClients[pairingId] == nil else { return }
        guard let pairing = try? store.loadPending(pairingId: pairingId) else { return }
        let client = RelayClient(pairing: pairing)
        client.sessionStore = sessionStore

        // Surface online/offline for the "Confirming…" row.
        client.onPresence = { [weak self] _, online in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if online {
                    self.clearPendingError(pairingId: pairingId)
                }
            }
        }

        // Backoff/auth failures keep the pairing PENDING; surface the reason.
        client.onConnectionCauseChange = { [weak self] cause in
            Task { @MainActor [weak self] in
                self?.setPendingError(pairingId: pairingId, cause: cause)
            }
        }

        // kx complete → promote PENDING → COMMITTED (legacy semantics; PCT
        // verification is PR-5). Re-keys this client into `clients`.
        client.onPairingConfirmed = { [weak self] pid in
            Task { @MainActor [weak self] in
                self?.promoteConfirmed(pairingId: pid)
            }
        }

        pendingClients[pairingId] = client
        client.connect()
    }

    /// Promote a confirmed PENDING pairing to COMMITTED, re-keying its live client
    /// from `pendingClients` (by pairingId) into `clients` (by daemonId) WITHOUT
    /// reconnecting (§1.6). Idempotent + safe against the GC race: if the pending
    /// record is already gone, `store.promote` no-ops and we still dispose any
    /// leftover client so no record-less zombie survives.
    private func promoteConfirmed(pairingId: String) {
        guard let client = pendingClients[pairingId] else { return }
        // Recover the daemonId from the pending record BEFORE promote deletes it.
        guard let pending = try? store.loadPending(pairingId: pairingId) else {
            // Record vanished (GC) between kx and here — dispose the orphan client.
            client.disconnect()
            pendingClients.removeValue(forKey: pairingId)
            return
        }
        let daemonId = pending.daemonId

        do {
            try store.promote(pairingId: pairingId)
        } catch {
            log.error(
                "promote failed pairingId=\(pairingId, privacy: .public): \(String(describing: error), privacy: .public)"
            )
            return
        }

        // Re-key: move THIS client into the committed map. If a stale committed
        // client for the same daemon exists (re-pair with a fresh pairingId),
        // dispose it and drop the old committed record (unpair semantics, §1.6).
        pendingClients.removeValue(forKey: pairingId)
        if let stale = clients[daemonId], stale !== client {
            stale.disconnect()
        }
        rewirePromotedClient(client, daemonId: daemonId)
        clients[daemonId] = client

        // Emit TP_PAIR_OK at promotion time — the marker moved here from ingest.
        log.notice(
            "\(DeepLinkHandler.pairMarker, privacy: .public) did=\(daemonId, privacy: .public)"
        )

        reload()
        reloadPending()
    }

    /// Re-point a promoted pending client's daemonId-scoped callbacks (unpair /
    /// rename / connection-cause) at the committed maps. The pending client was
    /// wired with pairingId-scoped closures in `beginPending`; now that it is
    /// committed it must behave like a `connect(daemonId:)` client.
    private func rewirePromotedClient(_ client: RelayClient, daemonId: String) {
        client.onPresence = { [weak self] did, online in
            Task { @MainActor [weak self] in
                self?.daemonOnline[did] = online
            }
        }
        client.onConnectionCauseChange = { [weak self] cause in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let cause {
                    self.connectionCause[daemonId] = cause
                } else {
                    self.connectionCause.removeValue(forKey: daemonId)
                }
            }
        }
        client.onUnpair = { [weak self] did, reason in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.log.notice(
                    "control.unpair from daemon \(did, privacy: .public) reason=\(reason, privacy: .public) — removing pairing"
                )
                self.clients[did]?.disconnect()
                self.clients[did] = nil
                self.daemonOnline.removeValue(forKey: did)
                self.connectionCause.removeValue(forKey: did)
                self.store.remove(daemonId: did)
                self.reload()
            }
        }
        client.onRename = { [weak self] did, newLabel in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.store.setLabel(newLabel, for: did)
                self.reload()
            }
        }
        // A promoted pairing already has its keys; the confirm callback is spent.
        client.onPairingConfirmed = nil
    }

    private func setPendingError(pairingId: String, cause: String?) {
        guard let idx = pendingPairings.firstIndex(where: { $0.pairingId == pairingId }) else {
            return
        }
        pendingPairings[idx].lastError = cause
    }

    private func clearPendingError(pairingId: String) {
        setPendingError(pairingId: pairingId, cause: nil)
    }

    /// Cancel a PENDING pairing: dispose its client and drop the record.
    func cancelPending(pairingId: String) {
        pendingClients[pairingId]?.disconnect()
        pendingClients.removeValue(forKey: pairingId)
        store.removePending(pairingId: pairingId)
        reloadPending()
    }

    func remove(_ daemonId: String) {
        // Notify the peer (control.unpair) BEFORE tearing down the socket — the
        // frame can't leave once disconnected. Best-effort: no-op if kx is not
        // complete, in which case the daemon prunes the dead pairing on its own.
        clients[daemonId]?.sendControlUnpair()
        clients[daemonId]?.disconnect()
        clients[daemonId] = nil
        daemonOnline.removeValue(forKey: daemonId)
        connectionCause.removeValue(forKey: daemonId)
        store.remove(daemonId: daemonId)
        reload()
    }

    /// Rename a daemon's local label and notify the peer (`control.rename`).
    /// The label is persisted by the caller (`PairingStore.setLabel`); this only
    /// pushes the change to the connected daemon. Pass `nil` to clear.
    func renameLabel(_ label: String?, for daemonId: String) {
        clients[daemonId]?.sendControlRename(label: label)
    }

    /// Request the daemon to create a new session at `cwd`. Routes to the client
    /// for `daemonId` when given, else the sole connected client (single-daemon
    /// flow). Returns whether the control frame was published.
    @discardableResult
    func createSession(cwd: String, daemonId: String? = nil) -> Bool {
        let client = daemonId.flatMap { clients[$0] } ?? clients.values.first
        return client?.createSession(cwd: cwd) ?? false
    }

    /// Read-only accessor: the relay client for a daemon (status dots, diagnostics).
    func client(for daemonId: String) -> RelayClient? { clients[daemonId] }

    /// Read-only accessor: the sole connected client (single-daemon convenience).
    func firstClient() -> RelayClient? { clients.values.first }

    /// Connection readiness for a daemon — `true` once kx completes (E2EE keys
    /// derived). Drives the online/offline status dot in DaemonsTab.
    func isConnected(_ daemonId: String) -> Bool {
        clients[daemonId]?.isReady ?? false
    }

    /// M8: Whether a daemon is currently online per relay.presence.
    /// `true` only after the daemon signals presence AND kx is complete.
    func isOnline(_ daemonId: String) -> Bool {
        daemonOnline[daemonId] == true && isConnected(daemonId)
    }

    /// BATCH F (#10/#15): the current disconnect/throttle cause for a daemon,
    /// or `nil` when there isn't one (healthy connection, or never observed a
    /// close/throttle event yet). `ConnectionBanner` renders this instead of
    /// a generic "Disconnected" string when available.
    func connectionCause(for daemonId: String) -> String? {
        connectionCause[daemonId]
    }

    // MARK: - M9: Observable label cache

    /// M9: Per-daemon label cache. Keyed by daemonId; value is the human-readable
    /// label (or nil if not set). Observable (NOT @ObservationIgnored) so any view
    /// reading `labels[did]` re-renders immediately after a rename — both local
    /// (DaemonsTab rename sheet) and inbound control.rename (H8) paths.
    private(set) var labels: [String: String?] = [:]

    /// M9: Reactive label accessor — reads from the observable cache (so SwiftUI
    /// tracks this as a dependency). Falls back to `PairingStore` on cache miss
    /// (e.g. before the first `reload` for a freshly-booted session).
    func label(for daemonId: String) -> String? {
        if let cached = labels[daemonId] { return cached }
        return store.label(for: daemonId)
    }

    /// M9: Refresh the label cache from PairingStore for all known daemons.
    /// Call after any `setLabel` so the observable dict drives SwiftUI re-renders.
    func refreshLabels() {
        for did in daemonIds {
            labels[did] = store.label(for: did)
        }
    }

    // MARK: - M12: RTT / Ping

    /// M12: Latest measured round-trip time (ms) for a daemon's relay connection.
    /// Nil when no pong has been received yet or the connection is down.
    func rtt(for daemonId: String) -> Int? {
        clients[daemonId]?.latestRTT
    }

    /// M12: Send an immediate relay.ping to the daemon, triggering a RTT measurement.
    /// The result is available via `rtt(for:)` after the next pong arrives (~30ms–2s).
    func sendPing(to daemonId: String) {
        clients[daemonId]?.sendManualPing()
    }

    /// Send a chat line into a session (M5). Routes to the client owning the
    /// session; for the current single-daemon flow that's the sole client. (A
    /// session→daemon map lands when N daemons each serve their own sessions.)
    func sendInput(sid: String, text: String) {
        let client = clients.values.first
        client?.sendInput(sid: sid, kind: .chat, text: text)
    }
}

/// The three top-level navigation destinations. Both platform shells (iOS TabView
/// and macOS NavigationSplitView sidebar) are driven by this enum so labels, icons,
/// and ordering live in exactly one place.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case sessions, daemons, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .daemons: return "Daemons"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .sessions: return "list.bullet"
        case .daemons: return "server.rack"
        case .settings: return "gearshape"
        }
    }
}

/// Root navigation. iOS/iPadOS use a bottom `TabView`; native macOS uses a
/// `NavigationSplitView` sidebar (A4 — a bottom tab bar reads as foreign on the
/// desktop). Both shells render the same tab bodies so the only platform divergence
/// is the chrome, not the content.
///
/// `coreStatus` is computed once at app launch (`TeleprompterApp.init`) and passed
/// in for display — the boot/core *markers* are emitted there, not from any view,
/// so verification is independent of which tab is on screen.
///
/// M13: Observes `SessionNavigator.shared.pendingSid` to handle notification-tap
/// navigation. When `pendingSid` is set, the shell switches to the Sessions tab
/// so the user lands in the right context. The actual session detail push is
/// driven by `SessionsTab` once it observes the same `pendingSid`.
struct RootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    let coreStatus: String
    @Binding var showShortcutHelp: Bool

    @AppStorage("theme") private var theme: AppTheme = .system

    // Tab selection is now the single source of truth on AppNavigationModel, so
    // the macOS menu-bar (⌘1/2/3) and the iOS hidden shortcut buttons mutate the
    // same value the TabView/sidebar render. The local @State was removed.
    private var nav: AppNavigationModel { AppNavigationModel.shared }
    // M13: shared navigator — observe pendingSid for notification-tap navigation.
    private var navigator: SessionNavigator { SessionNavigator.shared }

    var body: some View {
        content
            .preferredColorScheme(theme.colorScheme)
            // M13: react to notification tap → switch to Sessions tab.
            .onChange(of: navigator.pendingSid) { _, sid in
                guard sid != nil else { return }
                nav.selectedTab = .sessions
                // Note: clearing pendingSid is done by SessionsTab after it pushes
                // the detail view. If SessionsTab hasn't been updated yet, the sid
                // persists until it is consumed — zero-cost, zero-crash.
            }
            // Tab-nav shortcuts (⌘1/2/3) are global — they stay active even while a
            // composer is focused, so they live on the root content (not in the
            // session detail). macOS registers these via MacCommands instead, so
            // guard the iOS attach to avoid a duplicate-shortcut registration.
            #if !os(macOS)
        .background(tabNavShortcuts)
            #endif
    }

    #if !os(macOS)
    /// Hidden zero-opacity buttons carrying the ⌘1/⌘2/⌘3 tab-switch chords and the
    /// global ⌘/ shortcut-help chord for iOS/iPadOS/visionOS (no menu bar). Mirrors
    /// the macOS MacCommands tab group + Help → Keyboard Shortcuts. Without the ⌘/
    /// button here the help sheet would be unreachable on every non-macOS platform
    /// (it is only wired in MacCommands, which never compiles off macOS).
    @ViewBuilder
    private var tabNavShortcuts: some View {
        ZStack {
            Button("") { nav.selectedTab = .sessions }
                .keyboardShortcut("1", modifiers: .command)
            Button("") { nav.selectedTab = .daemons }
                .keyboardShortcut("2", modifiers: .command)
            Button("") { nav.selectedTab = .settings }
                .keyboardShortcut("3", modifiers: .command)
            // ⌘/ opens the shortcut-help sheet (the macOS Help menu item's iOS
            // counterpart). Global — no focus/detail gate, matching MacCommands.
            Button("") { showShortcutHelp = true }
                .keyboardShortcut("/", modifiers: .command)
        }
        .opacity(0)
    }
    #endif

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        MacRootView(
            pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus,
            showShortcutHelp: $showShortcutHelp)
        #elseif os(visionOS)
        // B2 (visionOS): use a TabView like iOS (bottom ornament-style tab bar
        // rendered by the system in a spatial window). Apply glass background to
        // the outermost container so the window material reads well in immersive
        // and passthrough environments. The .tabViewStyle default is correct for
        // visionOS — no override needed; the platform renders an appropriate tab
        // bar ornament automatically.
        TabView(
            selection: Binding(
                get: { nav.selectedTab },
                set: { nav.selectedTab = $0 })
        ) {
            ForEach(AppTab.allCases) { tab in
                tabContent(tab)
                    .glassBackgroundEffect()
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        #else
        // M13: bind selection so notification/toast taps can switch tabs.
        TabView(
            selection: Binding(
                get: { nav.selectedTab },
                set: { nav.selectedTab = $0 })
        ) {
            ForEach(AppTab.allCases) { tab in
                tabContent(tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        #endif
    }

    @ViewBuilder
    private func tabContent(_ tab: AppTab) -> some View {
        switch tab {
        case .sessions:
            SessionsTab(sessionStore: sessionStore, pairings: pairings)
        case .daemons:
            DaemonsTab(pairings: pairings)
        case .settings:
            // H10: pass pairings + sessionStore so DiagnosticsView can show
            // live relay WS state, E2EE status, session counts, and RTT (M12).
            SettingsTab(coreStatus: coreStatus, pairings: pairings, sessionStore: sessionStore)
        }
    }
}

#if os(macOS)
/// macOS sidebar shell (A4). A `NavigationSplitView` with the three tabs in
/// the sidebar and the selected tab's view in the detail pane. Selection is
/// keyboard-navigable (↑/↓ in the sidebar `List`), satisfying the A4
/// keyboard-first goal without bespoke key handling.
struct MacRootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    let coreStatus: String
    @Binding var showShortcutHelp: Bool
    // Sidebar selection is driven by the shared AppNavigationModel so ⌘1/2/3 (and
    // ↑/↓ in the List) all move the one selectedTab. The List wants an optional
    // binding, so adapt nil → .sessions on read and ignore nil on write.
    private var nav: AppNavigationModel { AppNavigationModel.shared }
    private var selection: Binding<AppTab?> {
        Binding(
            get: { nav.selectedTab },
            set: { if let tab = $0 { nav.selectedTab = tab } })
    }

    var body: some View {
        NavigationSplitView {
            List(AppTab.allCases, selection: selection) { tab in
                Label(tab.title, systemImage: tab.systemImage)
                    .tag(tab)
                    .accessibilityIdentifier("sidebar-\(tab.rawValue)")
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
            .navigationTitle("Teleprompter")
        } detail: {
            switch nav.selectedTab {
            case .sessions:
                SessionsTab(sessionStore: sessionStore, pairings: pairings)
            case .daemons:
                DaemonsTab(pairings: pairings)
            case .settings:
                // H10: pass pairings + sessionStore for DiagnosticsView wiring.
                SettingsTab(coreStatus: coreStatus, pairings: pairings, sessionStore: sessionStore)
            }
        }
    }
}
#endif
