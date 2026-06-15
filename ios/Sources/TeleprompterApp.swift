import SwiftUI
import os

/// Entry point for the native Teleprompter iOS app (ADR-0001 rewrite).
///
/// Boots on the iOS Simulator and routes inbound `tp://` deep links (pairing
/// bundles) to `DeepLinkHandler` via SwiftUI's `.onOpenURL`. Real features
/// (relay client, sessions, chat, terminal) land on top of this shell as the
/// rewrite progresses (Phase 3 M2+).
///
/// `.onOpenURL` only fires once the Info.plist declares a scene manifest
/// (`UIApplicationSceneManifest`); without it the iOS 26 Simulator drops inbound
/// URL contexts. The manifest is set in `project.yml` (`info.properties`).
@main
struct TeleprompterApp: App {
    @State private var pairings = PairingViewModel()
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "deeplink")

    var body: some Scene {
        WindowGroup {
            RootView(pairings: pairings)
                .onOpenURL { url in
                    self.log.notice("onOpenURL url=\(url.absoluteString, privacy: .public)")
                    _ = DeepLinkHandler.handle(url)
                    pairings.reload()
                }
        }
    }
}

/// Observable list of paired daemons, backed by `PairingStore`.
@Observable
final class PairingViewModel {
    private(set) var daemonIds: [String] = []
    private let store: PairingStore

    init(store: PairingStore = .shared) {
        self.store = store
        reload()
    }

    func reload() {
        daemonIds = store.daemonIds()
    }

    func remove(_ daemonId: String) {
        store.remove(daemonId: daemonId)
        reload()
    }
}

/// Root navigation: the FFI diagnostics header plus the paired-daemons list.
struct RootView: View {
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
