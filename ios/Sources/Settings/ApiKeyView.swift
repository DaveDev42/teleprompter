import SwiftUI

// MARK: - ApiKeySheet

/// A sheet for entering, updating, or removing the OpenAI API key.
///
/// The key is written to the Keychain via `OpenAIKeychain`; it is NEVER
/// logged, printed, or stored in UserDefaults/AppStorage.
struct ApiKeySheet: View {
    /// Whether a key is currently stored (passed in; the sheet does not read
    /// the actual key value — only existence is needed for the "Remove" button).
    let hasKey: Bool
    /// Called after a successful save or remove so the caller can refresh the
    /// `hasKey` flag from `OpenAIKeychain.isPresent()`.
    var onKeyChanged: () -> Void = {}

    @Environment(\.dismiss) private var dismiss

    @State private var inputValue: String = ""
    @State private var showRemoveConfirm = false

    private var canSave: Bool { !inputValue.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-…", text: $inputValue)
                        .autocorrectionDisabled()
                        #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                        #endif
                        .onSubmit { if canSave { saveKey() } }
                        .accessibilityLabel("OpenAI API key")
                        .accessibilityHint("Enter your OpenAI API key for voice input")
                } header: {
                    Text("OpenAI API Key")
                } footer: {
                    Text(
                        "Required for voice input. Stored securely in the Keychain — never shared or logged."
                    )
                    .font(.footnote)
                }

                Section {
                    Button("Save") {
                        saveKey()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSave)
                    .frame(maxWidth: .infinity)
                    .fontWeight(.semibold)
                }

                if hasKey {
                    Section {
                        Button("Remove Key", role: .destructive) {
                            showRemoveConfirm = true
                        }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("OpenAI API Key")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .confirmationDialog(
                "Remove API Key",
                isPresented: $showRemoveConfirm,
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    OpenAIKeychain.delete()
                    onKeyChanged()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "Your OpenAI API key will be removed from this device. Voice features will stop working until a key is entered again."
                )
            }
        }
    }

    private func saveKey() {
        let trimmed = inputValue.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        _ = OpenAIKeychain.set(trimmed)
        onKeyChanged()
        dismiss()
    }
}
