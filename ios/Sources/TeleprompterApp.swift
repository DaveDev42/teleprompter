import SwiftUI
import os
import UserNotifications

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
    /// The single session store, shared by every relay client (each writes the
    /// sessions it serves) and observed by the Chat tab (M4).
    @State private var sessionStore: SessionStore
    @State private var pairings: PairingViewModel
    /// Rust-core self-check result, computed once at launch and surfaced in the UI.
    private let coreStatus: String
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "deeplink")
    private static let bootLog = Logger(subsystem: "dev.tpmt.teleprompter", category: "boot")

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
              idx + 1 < args.count else { return }
        let raw = args[idx + 1]
        let smokeLog = Logger(subsystem: "dev.tpmt.teleprompter", category: "deeplink")
        smokeLog.notice("smoke url injection: \(raw, privacy: .public)")
        guard let url = URL(string: raw) else {
            smokeLog.error("smoke url invalid: \(raw, privacy: .public)")
            return
        }
        if case let .paired(daemonId) = DeepLinkHandler.handle(url) {
            pairings.reload()
            pairings.connect(daemonId: daemonId)
        } else {
            pairings.reload()
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
            RootView(pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus,
                     showShortcutHelp: $showShortcutHelp)
                .onOpenURL { url in
                    self.log.notice("onOpenURL url=\(url.absoluteString, privacy: .public)")
                    if case let .paired(daemonId) = DeepLinkHandler.handle(url) {
                        pairings.reload()
                        // M2: connect to the relay as soon as a pairing lands so the
                        // auth round-trip happens on-device (emits TP_RELAY_AUTH_OK).
                        pairings.connect(daemonId: daemonId)
                    } else {
                        pairings.reload()
                    }
                }
                // Wire up the app-wide toast overlay above all content.
                .toastOverlay()
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
        .commands { MacCommands(pairings: pairings, showShortcutHelp: $showShortcutHelp) }
        #elseif os(visionOS)
        // B2 (visionOS): open at a comfortable spatial-window size — wide enough
        // for the terminal column, tall enough for the tab bar and content. The
        // system may adjust for the user's environment; this is the initial size.
        .defaultSize(width: 960, height: 640)
        #endif
    }
}

/// Observable list of paired daemons, backed by `PairingStore`.
///
/// Also owns the live relay clients (M2): one per paired daemon, started on
/// pairing and on a relaunch with existing pairings. Holding the clients here
/// keeps their sockets alive for the app's lifetime.
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

    init(store: PairingStore = .shared, sessionStore: SessionStore) {
        self.store = store
        self.sessionStore = sessionStore
        reload()
        // Reconnect any pairing that survived a relaunch.
        for did in daemonIds { connect(daemonId: did) }
    }

    func reload() {
        daemonIds = store.daemonIds()
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
        clients[daemonId] = client
        client.connect()
    }

    func remove(_ daemonId: String) {
        // Notify the peer (control.unpair) BEFORE tearing down the socket — the
        // frame can't leave once disconnected. Best-effort: no-op if kx is not
        // complete, in which case the daemon prunes the dead pairing on its own.
        clients[daemonId]?.sendControlUnpair()
        clients[daemonId]?.disconnect()
        clients[daemonId] = nil
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
        case .daemons:  return "Daemons"
        case .settings: return "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .sessions: return "list.bullet"
        case .daemons:  return "server.rack"
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
struct RootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    let coreStatus: String
    @Binding var showShortcutHelp: Bool

    @AppStorage("theme") private var theme: AppTheme = .system

    var body: some View {
        content
            .preferredColorScheme(theme.colorScheme)
    }

    @ViewBuilder
    private var content: some View {
        #if os(macOS)
        MacRootView(pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus,
                    showShortcutHelp: $showShortcutHelp)
        #elseif os(visionOS)
        // B2 (visionOS): use a TabView like iOS (bottom ornament-style tab bar
        // rendered by the system in a spatial window). Apply glass background to
        // the outermost container so the window material reads well in immersive
        // and passthrough environments. The .tabViewStyle default is correct for
        // visionOS — no override needed; the platform renders an appropriate tab
        // bar ornament automatically.
        TabView {
            ForEach(AppTab.allCases) { tab in
                tabContent(tab)
                    .glassBackgroundEffect()
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
            }
        }
        #else
        TabView {
            ForEach(AppTab.allCases) { tab in
                tabContent(tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
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
            SettingsTab(coreStatus: coreStatus)
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
    @State private var selection: AppTab? = .sessions

    var body: some View {
        NavigationSplitView {
            List(AppTab.allCases, selection: $selection) { tab in
                Label(tab.title, systemImage: tab.systemImage)
                    .tag(tab)
                    .accessibilityIdentifier("sidebar-\(tab.rawValue)")
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
            .navigationTitle("Teleprompter")
        } detail: {
            switch selection ?? .sessions {
            case .sessions:
                SessionsTab(sessionStore: sessionStore, pairings: pairings)
            case .daemons:
                DaemonsTab(pairings: pairings)
            case .settings:
                SettingsTab(coreStatus: coreStatus)
            }
        }
    }
}
#endif
