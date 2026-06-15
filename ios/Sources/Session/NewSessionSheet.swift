import SwiftUI

/// Sheet presented when the user taps "+" in the Sessions list.
///
/// Collects a working-directory path and forwards the creation request to
/// `PairingViewModel.createSession(cwd:sessionStore:)`. Validates that the
/// field is not blank before enabling the Start button.
struct NewSessionSheet: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel
    let onDismiss: () -> Void

    @State private var cwd: String = ""
    @State private var errorMessage: String? = nil
    @FocusState private var cwdFocused: Bool

    private var isValid: Bool { !cwd.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("/path/to/project", text: $cwd)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .autocapitalization(.none)
                        .keyboardType(.URL)
                        #endif
                        .focused($cwdFocused)
                        .accessibilityIdentifier("new-session-cwd-input")
                        .onSubmit { attemptCreate() }
                } header: {
                    Text("Working directory")
                } footer: {
                    if let error = errorMessage {
                        Text(error)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("new-session-error")
                    } else {
                        Text("Absolute path where Claude Code will run (e.g. ~/projects/my-repo).")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("New Session")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { attemptCreate() }
                        .disabled(!isValid)
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("new-session-start")
                }
            }
        }
        .onAppear { cwdFocused = true }
        .presentationDetents([.medium])
    }

    private func attemptCreate() {
        let trimmed = cwd.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            errorMessage = "Working directory is required."
            return
        }
        errorMessage = nil
        Task { @MainActor in
            pairings.createSession(cwd: trimmed, sessionStore: sessionStore)
        }
        onDismiss()
    }
}
