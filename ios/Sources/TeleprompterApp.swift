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
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "deeplink")

    init() {
        let store = SessionStore()
        _sessionStore = State(initialValue: store)
        _pairings = State(initialValue: PairingViewModel(sessionStore: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView(pairings: pairings, sessionStore: sessionStore)
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
        }
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
}

/// Root navigation: a Sessions/diagnostics tab plus the live Chat tab (M4).
struct RootView: View {
    let pairings: PairingViewModel
    @ObservedObject var sessionStore: SessionStore

    var body: some View {
        TabView {
            SessionsView(pairings: pairings)
                .tabItem { Label("Sessions", systemImage: "list.bullet") }
            ChatView(store: sessionStore)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
        }
    }
}

/// The FFI diagnostics header plus the paired-daemons list (pre-M4 RootView body).
struct SessionsView: View {
    let pairings: PairingViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ContentView()
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
