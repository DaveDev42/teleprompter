import SwiftUI

/// Sheet to rename a daemon pairing (set or clear its local label).
///
/// - The label is stored in `PairingStore` (UserDefaults) and is local-only
///   until the relay client sends a `control.rename` to the daemon peer.
/// - Saving an empty label clears it; the `DaemonsListView` then falls back
///   to showing the short daemon id.
struct RenameDaemonSheet: View {
    let daemonId: String
    let currentLabel: String
    var onSave: (String) -> Void
    var onCancel: () -> Void

    @State private var labelText: String
    @FocusState private var inputFocused: Bool

    init(daemonId: String,
         currentLabel: String,
         onSave: @escaping (String) -> Void,
         onCancel: @escaping () -> Void) {
        self.daemonId = daemonId
        self.currentLabel = currentLabel
        self.onSave = onSave
        self.onCancel = onCancel
        _labelText = State(initialValue: currentLabel)
    }

    private var isUnchanged: Bool { labelText == currentLabel }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Label (leave empty to clear)", text: $labelText)
                        .focused($inputFocused)
                        .submitLabel(.done)
                        .onSubmit { if !isUnchanged { commit() } }
                        .accessibilityIdentifier("rename-daemon-input")
                } header: {
                    Text("Name")
                } footer: {
                    Text("Empty label falls back to the daemon ID (\(daemonId.prefix(8))…).")
                        .font(.caption)
                }
            }
            .navigationTitle("Rename Daemon")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("rename-daemon-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { commit() }
                        .disabled(isUnchanged)
                        .accessibilityIdentifier("rename-daemon-save")
                }
            }
            .onAppear { inputFocused = true }
        }
    }

    private func commit() {
        onSave(labelText)
    }
}

#Preview {
    RenameDaemonSheet(
        daemonId: "daemon-abc123",
        currentLabel: "My Workstation",
        onSave: { print("saved: \($0)") },
        onCancel: { print("cancelled") }
    )
}
