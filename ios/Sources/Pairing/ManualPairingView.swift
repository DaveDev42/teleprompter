import SwiftUI

/// Manual pairing fallback — a text field to paste a `tp://` pairing URL or
/// JSON blob.
///
/// Before committing, the input is decoded via the Rust FFI (`decodePairingData`
/// through `PairingStore.ingest`) and a preview card shows the daemon id / relay
/// URL so the user can confirm they are pairing with the expected daemon.
///
/// This view is used when:
/// - The camera is unavailable (Simulator, macOS).
/// - The user taps "Enter code manually" from the QR scanner.
struct ManualPairingView: View {
    /// Called on a successful pairing with the new daemonId.
    var onPaired: (String) -> Void
    /// Called to dismiss without pairing.
    var onCancel: () -> Void

    @State private var rawInput = ""
    @State private var preview: PairPreview? = nil
    @State private var ingestError: String? = nil
    @State private var isProcessing = false

    /// The confirmed daemonId from a successful `decodePairingData` preview.
    private struct PairPreview: Equatable {
        let daemonId: String
        let relayURL: String
        let version: UInt8
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Paste pairing URL or code", text: $rawInput, axis: .vertical)
                        .lineLimit(4, reservesSpace: true)
                        #if os(iOS)
                    .textInputAutocapitalization(.never)
                        #endif
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))
                        .accessibilityIdentifier("pairing-code-input")
                        .onChange(of: rawInput) { _, _ in
                            preview = nil
                            ingestError = nil
                        }
                } header: {
                    Text("Pairing Code")
                } footer: {
                    Text("Run `tp pair` on your machine to generate the pairing code.")
                        .font(.caption)
                }

                if let preview {
                    Section("Preview") {
                        LabeledContent("Daemon ID") {
                            Text(preview.daemonId)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("pairing-preview-did")
                        }
                        LabeledContent("Relay") {
                            Text(preview.relayURL.replacing("wss://", with: ""))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("pairing-preview-relay")
                        }
                        LabeledContent("Version") {
                            Text("v\(preview.version)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if let err = ingestError {
                    Section {
                        Text(err)
                            .foregroundStyle(.red)
                            .font(.caption)
                            .accessibilityIdentifier("pairing-ingest-error")
                    }
                }

                Section {
                    // "Preview" decodes without persisting.
                    Button("Preview") {
                        runPreview()
                    }
                    .disabled(rawInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("pairing-preview-btn")

                    // "Pair" runs the full ingest (persists to Keychain + defaults).
                    Button("Pair") {
                        runIngest()
                    }
                    .disabled(
                        rawInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || isProcessing
                    )
                    .accessibilityIdentifier("pairing-pair-btn")
                }
            }
            .navigationTitle("Enter Pairing Code")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
            .disabled(isProcessing)
            .overlay {
                if isProcessing {
                    ProgressView()
                        .padding(32)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    // MARK: - Actions

    /// Decode for preview only (no Keychain write). Uses the Rust FFI directly
    /// so we can show the daemon id / relay without persisting anything.
    private func runPreview() {
        let raw = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        do {
            let ffi = try decodePairingData(raw: raw)
            preview = PairPreview(
                daemonId: ffi.did,
                relayURL: ffi.relay,
                version: ffi.v)
            ingestError = nil
        } catch {
            preview = nil
            ingestError = "Could not decode pairing data: \(error)"
        }
    }

    /// Full ingest: persist to Keychain + UserDefaults, then notify the caller.
    private func runIngest() {
        let raw = rawInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        isProcessing = true
        ingestError = nil
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let pairing = try PairingStore.shared.ingest(deepLink: raw)
                DispatchQueue.main.async {
                    isProcessing = false
                    onPaired(pairing.daemonId)
                }
            } catch {
                let msg = "\(error)"
                DispatchQueue.main.async {
                    isProcessing = false
                    ingestError = "Pairing failed: \(msg)"
                }
            }
        }
    }
}

#Preview {
    ManualPairingView(
        onPaired: { did in print("paired: \(did)") },
        onCancel: { print("cancelled") }
    )
}
