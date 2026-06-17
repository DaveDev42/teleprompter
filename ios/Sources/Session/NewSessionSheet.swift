import SwiftUI

/// Sheet presented when the user taps "+" in the Sessions list.
///
/// Collects a working-directory path and forwards the creation request to
/// `PairingViewModel.createSession(cwd:sessionStore:)`. Validates that the
/// field is not blank before enabling the Start button.
///
/// L1 fix: after the create request is sent, waits up to 3 seconds for a new
/// non-pending session to appear in the store (mirrors Expo NewSessionModal's
/// `pendingTimerRef`). If none appears in time, shows a toast via ToastCenter.
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
        // Snapshot the current session sids so we can detect the daemon's reply
        // by identity rather than count. Count-based detection is vulnerable to
        // concurrent deletes (countAfter < countBefore satisfies <=, giving a
        // false-positive failure toast even when the new session was created).
        let sidsBefore = Set(sessionStore.sessions.keys)
        Task { @MainActor in
            pairings.createSession(cwd: trimmed, sessionStore: sessionStore)
        }
        onDismiss()

        // L1 fix: mirrors Expo NewSessionModal pendingTimerRef.
        // Wait 3 s for at least one new sid to appear that was not in the
        // snapshot. If a new sid appears, the daemon accepted the request —
        // no toast needed. Concurrent deletes/creates do not affect this check.
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            let hasNew = !Set(sessionStore.sessions.keys).subtracting(sidsBefore).isEmpty
            guard !hasNew else { return }
            ToastCenter.shared.show(
                title: "Couldn't start session",
                body: "Daemon may be offline or rejected the path."
            )
        }
    }
}
