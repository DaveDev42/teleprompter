import SwiftUI
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

    var body: some Scene {
        WindowGroup {
            RootView(pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus)
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
                // A4: a desktop window must not collapse below a usable size. The
                // sidebar (~220) + a readable terminal column needs ~640×480 floor.
                // No-op on iOS where the scene fills the device.
                #if os(macOS)
                .frame(minWidth: 640, minHeight: 480)
                #endif
        }
        // A4 (macOS): open at a comfortable desktop size and clamp shrink to the
        // content's declared minimum so the chrome never overlaps the content.
        #if os(macOS)
        .defaultSize(width: 980, height: 680)
        .windowResizability(.contentMinSize)
        .commands { MacCommands(pairings: pairings) }
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
        clients[daemonId]?.disconnect()
        clients[daemonId] = nil
        store.remove(daemonId: daemonId)
        reload()
    }

    /// Send a chat line into a session (M5). Routes to the client owning the
    /// session; for the current single-daemon flow that's the sole client. (A
    /// session→daemon map lands when N daemons each serve their own sessions.)
    func sendInput(sid: String, text: String) {
        let client = clients.values.first
        client?.sendInput(sid: sid, kind: .chat, text: text)
    }
}

/// The three top-level destinations, shared by both platform shells so the
/// labels/icons and the view bodies live in exactly one place.
enum AppSection: String, CaseIterable, Identifiable, Hashable {
    case sessions, chat, terminal
    var id: String { rawValue }

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .chat: return "Chat"
        case .terminal: return "Terminal"
        }
    }

    var systemImage: String {
        switch self {
        case .sessions: return "list.bullet"
        case .chat: return "bubble.left.and.bubble.right"
        case .terminal: return "terminal"
        }
    }
}

/// Renders the view body for a given `AppSection`. Both platform shells route
/// through this one builder so the macOS sidebar detail pane and the iOS tab
/// content are guaranteed identical — the only platform divergence is the chrome.
struct SectionView: View {
    let section: AppSection
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    /// Rust-core status string, computed in `TeleprompterApp.init` and surfaced in
    /// `SessionsView`.
    let coreStatus: String

    var body: some View {
        switch section {
        case .sessions:
            SessionsView(pairings: pairings, coreStatus: coreStatus)
        case .chat:
            ChatView(store: sessionStore)
        case .terminal:
            TerminalView(store: sessionStore) { sid, text in
                pairings.sendInput(sid: sid, text: text)
            }
        }
    }
}

/// Root navigation. iOS/iPadOS use a bottom `TabView`; native macOS uses a
/// `NavigationSplitView` sidebar (A4 — a bottom tab bar reads as foreign on the
/// desktop). Both shells render the same `SectionView` bodies, so the only
/// platform divergence is the chrome, not the content.
///
/// `coreStatus` is computed once at app launch (`TeleprompterApp.init`) and passed
/// in for display — the boot/core *markers* are emitted there, not from any view,
/// so verification is independent of which section/tab is on screen.
struct RootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    let coreStatus: String

    var body: some View {
        #if os(macOS)
        MacRootView(pairings: pairings, sessionStore: sessionStore, coreStatus: coreStatus)
        #else
        TabView {
            ForEach(AppSection.allCases) { section in
                SectionView(section: section,
                            pairings: pairings,
                            sessionStore: sessionStore,
                            coreStatus: coreStatus)
                    .tabItem { Label(section.title, systemImage: section.systemImage) }
            }
        }
        #endif
    }
}

#if os(macOS)
/// macOS sidebar shell (A4). A `NavigationSplitView` with the three sections in
/// the sidebar and the selected section's view in the detail pane. Selection is
/// keyboard-navigable (↑/↓ in the sidebar `List`), satisfying the A4
/// keyboard-first goal without bespoke key handling.
struct MacRootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore
    let coreStatus: String
    @State private var selection: AppSection? = .sessions

    var body: some View {
        NavigationSplitView {
            List(AppSection.allCases, selection: $selection) { section in
                Label(section.title, systemImage: section.systemImage)
                    .tag(section)
                    .accessibilityIdentifier("sidebar-\(section.rawValue)")
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 320)
            .navigationTitle("Teleprompter")
        } detail: {
            SectionView(section: selection ?? .sessions,
                        pairings: pairings,
                        sessionStore: sessionStore,
                        coreStatus: coreStatus)
        }
    }
}
#endif

/// The FFI diagnostics header plus the paired-daemons list (pre-M4 RootView body).
struct SessionsView: View {
    let pairings: PairingViewModel
    /// Rust-core status, produced by `RootView`'s boot probe and shown in the header.
    var coreStatus: String = "checking…"

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ContentView(coreStatus: coreStatus)
                        .frame(maxWidth: .infinity)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                Section("Paired daemons") {
                    if pairings.daemonIds.isEmpty {
                        Text("No pairings yet. Open a tp://p?d=… link.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(pairings.daemonIds, id: \.self) { did in
                            Text(did)
                                .font(.callout.monospaced())
                                .accessibilityIdentifier("daemon-\(did)")
                        }
                        .onDelete { offsets in
                            offsets.map { pairings.daemonIds[$0] }.forEach(pairings.remove)
                        }
                    }
                }
            }
            .navigationTitle("Teleprompter")
        }
    }
}
