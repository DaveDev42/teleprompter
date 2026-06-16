import SwiftUI

/// Daemons tab — lists paired daemons with online/offline status, rename,
/// unpair, and in-app QR / manual pairing (Tranche B + integration pass).
///
/// Online/offline status reads `PairingViewModel.isConnected(_:)` (kx complete);
/// rename/unpair notify the peer via `control.rename` / `control.unpair`.
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

// MARK: - Daemon list

struct DaemonsListView: View {
    let pairings: PairingViewModel

    /// Which sheet is currently presented.
    enum ActiveSheet: Identifiable {
        case scanner
        case manual
        case rename(daemonId: String)
        case confirmUnpair(daemonId: String)

        var id: String {
            switch self {
            case .scanner:                    return "scanner"
            case .manual:                     return "manual"
            case .rename(let did):            return "rename-\(did)"
            case .confirmUnpair(let did):     return "unpair-\(did)"
            }
        }
    }

    @State private var activeSheet: ActiveSheet? = nil
    @State private var pairingError: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            if let err = pairingError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08))
                    .accessibilityIdentifier("pairing-error-banner")
            }

            if pairings.daemonIds.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(pairings.daemonIds, id: \.self) { did in
                        // M9: pass label from the observable `pairings.labels` dict
                        // so DaemonRow re-renders immediately after any rename (local
                        // via sheet or inbound control.rename). No onAppear read needed.
                        DaemonRow(
                            daemonId: did,
                            label: pairings.label(for: did),
                            isConnected: pairings.isConnected(did),
                            onRename: { activeSheet = .rename(daemonId: did) },
                            onUnpair: { activeSheet = .confirmUnpair(daemonId: did) }
                        )
                        .accessibilityIdentifier("daemon-\(did)")
                    }
                }
                .listStyle(.plain)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                addMenu
            }
        }
        .sheet(item: $activeSheet) { sheet in
            sheetContent(sheet)
        }
    }

    // MARK: - Empty state

    @ViewBuilder
    private var emptyState: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "server.rack")
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("No Daemons Connected")
                .font(.title2.bold())
            Text("Run `tp pair` on your machine to generate a pairing QR code, then scan it below.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button {
                pairingError = nil
                activeSheet = .scanner
            } label: {
                Label("Scan QR Code to Pair", systemImage: "qrcode.viewfinder")
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("pair-scan-btn")

            Button("Enter code manually") {
                pairingError = nil
                activeSheet = .manual
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("pair-manual-btn")
            Spacer()
        }
        .padding()
    }

    // MARK: - Add menu

    private var addMenu: some View {
        Menu {
            Button {
                pairingError = nil
                activeSheet = .scanner
            } label: {
                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
            }
            .accessibilityIdentifier("pair-scan-menu-btn")

            Button {
                pairingError = nil
                activeSheet = .manual
            } label: {
                Label("Enter Code Manually", systemImage: "keyboard")
            }
            .accessibilityIdentifier("pair-manual-menu-btn")
        } label: {
            Image(systemName: "plus")
                .accessibilityLabel("Add daemon")
        }
        .accessibilityIdentifier("add-daemon-menu")
    }

    // MARK: - Sheet content

    @ViewBuilder
    private func sheetContent(_ sheet: ActiveSheet) -> some View {
        switch sheet {

        case .scanner:
            NavigationStack {
                QRScannerView(
                    onDecoded: { raw in
                        activeSheet = nil
                        handleScanned(raw: raw)
                    },
                    onManualFallback: {
                        activeSheet = .manual
                    },
                    onCancel: {
                        activeSheet = nil
                    }
                )
            }

        case .manual:
            ManualPairingView(
                onPaired: { daemonId in
                    activeSheet = nil
                    pairings.reload()
                    pairings.connect(daemonId: daemonId)
                },
                onCancel: {
                    activeSheet = nil
                }
            )

        case .rename(let did):
            RenameDaemonSheet(
                daemonId: did,
                currentLabel: PairingStore.shared.label(for: did) ?? "",
                onSave: { newLabel in
                    activeSheet = nil
                    let trimmed = newLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                    let label = trimmed.isEmpty ? nil : trimmed
                    PairingStore.shared.setLabel(label, for: did)
                    // Notify the peer of the label change (best-effort).
                    pairings.renameLabel(label, for: did)
                },
                onCancel: {
                    activeSheet = nil
                }
            )

        case .confirmUnpair(let did):
            let label = PairingStore.shared.label(for: did) ?? String(did.prefix(8))
            ConfirmUnpairView(
                daemonId: did,
                displayName: label,
                onConfirm: {
                    activeSheet = nil
                    // `remove` notifies the peer via control.unpair before disconnect.
                    pairings.remove(did)
                },
                onCancel: {
                    activeSheet = nil
                }
            )
        }
    }

    // MARK: - QR decode handler

    private func handleScanned(raw: String) {
        // Route through DeepLinkHandler (same path as the system URL open).
        // If `raw` is a `tp://` URL use it directly; otherwise pass to ingest directly.
        let outcome: DeepLinkHandler.Outcome
        if let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           url.scheme == "tp" {
            outcome = DeepLinkHandler.handle(url)
        } else {
            do {
                let pairing = try PairingStore.shared.ingest(deepLink: raw)
                outcome = .paired(daemonId: pairing.daemonId)
            } catch {
                outcome = .failed(reason: "\(error)")
            }
        }
        switch outcome {
        case .paired(let daemonId):
            pairings.reload()
            pairings.connect(daemonId: daemonId)
            pairingError = nil
        case .ignored(let reason):
            pairingError = "Not a pairing code (\(reason))"
        case .failed(let reason):
            pairingError = "Pairing failed: \(reason)"
        }
    }
}

// MARK: - Daemon row

/// One row in the daemon list: display name (label or short id), relay info,
/// and Rename / Unpair action buttons.
///
/// M9: `label` is now a `let` driven from `PairingViewModel.labels` (observable)
/// rather than a `@State` set in `onAppear`. This means the row re-renders
/// immediately when a rename completes (local sheet or inbound control.rename).
private struct DaemonRow: View {
    let daemonId: String
    /// M9: Reactive label from PairingViewModel. Nil = not set, falls back to short ID.
    var label: String? = nil
    var isConnected: Bool = false
    var onRename: () -> Void
    var onUnpair: () -> Void

    private var displayName: String { label ?? String(daemonId.prefix(8)) }
    private var hasLabel: Bool { label != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header: status dot + name + action buttons
            HStack(spacing: 8) {
                Circle()
                    .fill(isConnected ? Color.green : Color.secondary.opacity(0.5))
                    .frame(width: 9, height: 9)
                    .accessibilityLabel(isConnected ? "Online" : "Offline")
                    .accessibilityIdentifier("daemon-status-\(daemonId)")
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName)
                        .font(.headline)
                        .accessibilityIdentifier("daemon-name-\(daemonId)")
                    if hasLabel {
                        Text(daemonId)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                Button("Rename", action: onRename)
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("daemon-rename-\(daemonId)")
                Button("Unpair") { onUnpair() }
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.red)
                    .accessibilityIdentifier("daemon-unpair-\(daemonId)")
            }

            // Relay info row
            if let relay = loadRelayURL() {
                HStack {
                    Text("Relay")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(relay.replacing("wss://", with: ""))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func loadRelayURL() -> String? {
        (try? PairingStore.shared.load(daemonId: daemonId))?.relayURL
    }
}

// MARK: - Confirm unpair sheet

/// Confirmation sheet before removing a pairing.
private struct ConfirmUnpairView: View {
    let daemonId: String
    let displayName: String
    var onConfirm: () -> Void
    var onCancel: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()
                Image(systemName: "trash.circle.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.red)
                    .accessibilityHidden(true)
                Text("Remove \(displayName)?")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("unpair-confirm-title")
                Text("You'll need to scan a new QR code from the daemon to reconnect.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Text(daemonId)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("unpair-confirm-did")
                Spacer()
                Button(role: .destructive) {
                    onConfirm()
                } label: {
                    Text("Remove Pairing")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
                .padding(.horizontal)
                .accessibilityIdentifier("unpair-confirm-btn")

                Button("Cancel", action: onCancel)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("unpair-cancel-btn")
                    .padding(.bottom)
            }
            .padding()
            .navigationTitle("Remove Daemon")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}
