import SwiftUI

/// Daemons tab — lists paired daemons with swipe-to-delete. Minimal in Tranche 0;
/// richer daemon UX (status, rename, QR scanner) lands in a later tranche.
struct DaemonsTab: View {
    let pairings: PairingViewModel

    var body: some View {
        NavigationStack {
            DaemonsListView(pairings: pairings)
                .navigationTitle("Daemons")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
        }
    }
}

struct DaemonsListView: View {
    let pairings: PairingViewModel

    var body: some View {
        List {
            if pairings.daemonIds.isEmpty {
                ContentUnavailableView(
                    "No daemons paired",
                    systemImage: "server.rack",
                    description: Text("Open a tp:// pairing link to connect a daemon."))
            } else {
                ForEach(pairings.daemonIds, id: \.self) { did in
                    HStack(spacing: 10) {
                        Image(systemName: "server.rack")
                            .foregroundStyle(.tint)
                        Text(did)
                            .font(.callout.monospaced())
                            .lineLimit(1)
                    }
                    .accessibilityIdentifier("daemon-\(did)")
                }
                .onDelete { offsets in
                    offsets.map { pairings.daemonIds[$0] }.forEach(pairings.remove)
                }
            }
        }
        .listStyle(.plain)
    }
}
