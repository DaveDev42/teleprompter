import SwiftUI

/// Confirmation sheet shown before deleting one or more sessions.
///
/// Lists up to 5 affected sessions by their last cwd path component.
/// The delete is **local-only** today (relay has no `session.delete`; see
/// `PairingViewModel.deleteSessions` for the TODO). A footer note informs
/// the user that the daemon still has the data until `tp session delete` is run.
struct ConfirmDeleteSheet: View {
    let sessions: [SessionMeta]
    let onCancel: () -> Void
    let onConfirm: () -> Void

    private static let maxListed = 5

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(listed, id: \.sid) { meta in
                        Label {
                            Text(displayName(for: meta))
                                .font(.body.monospaced())
                        } icon: {
                            Image(systemName: "terminal")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if extra > 0 {
                        Text("…and \(extra) more")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Sessions to remove")
                } footer: {
                    Text(
                        "Removes from this app's list only. To delete daemon data, run: tp session delete <sid>"
                    )
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { onCancel() }
                        .accessibilityIdentifier("confirm-delete-sessions-cancel")
                }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Delete", role: .destructive) { onConfirm() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("confirm-delete-sessions-confirm")
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Helpers

    private var count: Int { sessions.count }

    private var title: String {
        count == 1 ? "Delete 1 Session?" : "Delete \(count) Sessions?"
    }

    private var listed: [SessionMeta] {
        Array(sessions.prefix(Self.maxListed))
    }

    private var extra: Int {
        max(0, count - Self.maxListed)
    }

    private func displayName(for meta: SessionMeta) -> String {
        let lastSegment = meta.cwd
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/")
            .last
            .map(String.init)
        if let seg = lastSegment { return seg }
        return meta.cwd.isEmpty ? meta.sid : meta.cwd
    }
}
