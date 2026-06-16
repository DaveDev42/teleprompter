import SwiftUI

/// Sessions tab — root of the session navigation stack. Lists all known sessions
/// with status, search/filter, multi-select delete, and new session creation.
/// Feature-parity with the old Expo `app/(tabs)/index.tsx`.
struct SessionsTab: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    var body: some View {
        NavigationStack {
            SessionListView(sessionStore: sessionStore, pairings: pairings)
                .navigationTitle("Sessions")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
        }
    }
}

/// The actual session list (extracted for reuse + testing).
struct SessionListView: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    // MARK: - Edit mode

    @State private var isEditMode = false
    @State private var selectedSids: Set<String> = []
    @State private var showConfirmDelete = false
    @State private var showNewSession = false

    // MARK: - Search

    @State private var searchText = ""

    // MARK: - Sorted / filtered sessions

    /// All sessions sorted: running first, then by updatedAt descending.
    ///
    /// L3 note: Expo sorted purely by updatedAt desc. We intentionally diverge —
    /// pinning running sessions to the top provides better UX when there are many
    /// stopped sessions (the active session stays visible without scrolling).
    /// Within each group (running / not-running) ordering is still updatedAt desc.
    private var allSorted: [SessionMeta] {
        sessionStore.sessions.values.sorted { a, b in
            let aRunning = (a.state == "running")
            let bRunning = (b.state == "running")
            if aRunning != bRunning { return aRunning }
            return a.updatedAt > b.updatedAt
        }
    }

    /// Sessions after applying the search filter.
    private var filteredSessions: [SessionMeta] {
        guard !searchText.trimmingCharacters(in: .whitespaces).isEmpty else {
            return allSorted
        }
        let q = searchText.lowercased()
        return allSorted.filter { meta in
            meta.sid.lowercased().contains(q)
            || meta.cwd.lowercased().contains(q)
            || meta.state.lowercased().contains(q)
        }
    }

    /// Stopped sessions (the only ones selectable for deletion in edit mode).
    ///
    /// M2 fix: use `== "stopped"` (match Expo) instead of `!= "running"` so
    /// "error" sessions are excluded from Select All and the delete count.
    /// Error rows remain visible in the list and navigable; they are simply not
    /// batch-selectable.
    private var stoppedSessions: [SessionMeta] {
        sessionStore.sessions.values.filter { $0.state == "stopped" }
    }

    private var allStoppedSelected: Bool {
        !stoppedSessions.isEmpty
            && stoppedSessions.allSatisfy { selectedSids.contains($0.sid) }
    }

    /// The sessions the user has selected that still exist (avoids phantom sids).
    private var selectedForDelete: [SessionMeta] {
        sessionStore.sessions.values.filter { selectedSids.contains($0.sid) }
    }

    var body: some View {
        Group {
            if allSorted.isEmpty && !isEditMode {
                emptyState
            } else {
                sessionList
            }
        }
        // New session sheet
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(
                sessionStore: sessionStore,
                pairings: pairings,
                onDismiss: { showNewSession = false }
            )
        }
        // Confirm delete sheet
        .sheet(isPresented: $showConfirmDelete) {
            ConfirmDeleteSheet(
                sessions: selectedForDelete,
                onCancel: { showConfirmDelete = false },
                onConfirm: confirmDelete
            )
        }
        .navigationDestination(for: String.self) { sid in
            SessionDetailView(
                sid: sid,
                sessionStore: sessionStore,
                onSend: { sid, text in pairings.sendInput(sid: sid, text: text) }
            )
        }
        .toolbar { toolbarContent }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isEditMode {
            // Edit mode: Cancel + Delete count
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { exitEditMode() }
                    .accessibilityIdentifier("sessions-edit-cancel")
            }
            ToolbarItem(placement: .principal) {
                Text(selectedSids.isEmpty ? "Select Sessions" : "\(selectedSids.count) Selected")
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("sessions-edit-count")
            }
            ToolbarItem(placement: .destructiveAction) {
                Button(
                    selectedSids.isEmpty ? "Delete" : "Delete (\(selectedSids.count))",
                    role: .destructive
                ) {
                    if !selectedSids.isEmpty { showConfirmDelete = true }
                }
                .disabled(selectedSids.isEmpty)
                .accessibilityIdentifier("sessions-edit-delete")
            }
        } else {
            // Normal mode: New + Edit
            ToolbarItem(placement: .primaryAction) {
                Button { showNewSession = true } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("New session")
                .accessibilityIdentifier("sessions-new-button")
            }
            ToolbarItem(placement: .secondaryAction) {
                Button("Edit") { enterEditMode() }
                    .accessibilityIdentifier("sessions-edit-button")
            }
        }
    }

    // MARK: - Session list body

    @ViewBuilder
    private var sessionList: some View {
        List {
            // Edit mode: select-all toggle (only when stopped sessions exist)
            if isEditMode {
                if stoppedSessions.isEmpty {
                    Text("No stopped sessions to clean up")
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                        .accessibilityIdentifier("sessions-edit-no-stopped")
                } else {
                    Button {
                        toggleSelectAll()
                    } label: {
                        Label(
                            allStoppedSelected
                                ? "Deselect all"
                                : "Select all (\(stoppedSessions.count))",
                            systemImage: allStoppedSelected
                                ? "checkmark.circle.fill"
                                : "circle"
                        )
                        .foregroundStyle(allStoppedSelected ? Color.accentColor : Color.secondary)
                    }
                    .accessibilityIdentifier("sessions-select-all")
                }
            }

            // Session rows
            if filteredSessions.isEmpty {
                if !searchText.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
            } else {
                ForEach(filteredSessions, id: \.sid) { meta in
                    sessionRow(for: meta)
                }
            }
        }
        .listStyle(.plain)
        // M1 fix: pull-to-refresh — mirrors Expo handleRefresh → refreshSessionList.
        // Sends a hello request to every connected daemon; the replies land in
        // replaceSessionsForDaemon (H3 fix), refreshing the list and removing ghosts.
        .refreshable {
            pairings.refreshSessions()
            // Brief yield so SwiftUI can animate the spinner; the actual update
            // is async (relay round-trip) so we don't await a specific result.
            try? await Task.sleep(for: .milliseconds(500))
        }
        // Search bar — placement varies by platform (navigationBarDrawer is iOS-only).
        #if os(iOS)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Search sessions"
        )
        #else
        .searchable(text: $searchText, prompt: "Search sessions")
        #endif
        .accessibilityIdentifier("sessions-search")
    }

    // MARK: - Session row

    @ViewBuilder
    private func sessionRow(for meta: SessionMeta) -> some View {
        let isRunning = meta.state == "running"
        let isSelected = selectedSids.contains(meta.sid)

        if isEditMode {
            // Edit mode: stopped sessions are selectable; running are read-only.
            HStack {
                if !isRunning {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                        .font(.title3)
                        .onTapGesture { toggleSelect(meta.sid) }
                }
                SessionRow(meta: meta)
                    .opacity(isRunning ? 0.6 : 1)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if !isRunning { toggleSelect(meta.sid) }
            }
            .accessibilityIdentifier("session-\(meta.sid)")
        } else {
            // Normal mode: navigation to detail.
            NavigationLink(value: meta.sid) {
                SessionRow(meta: meta)
            }
            .accessibilityIdentifier("session-\(meta.sid)")
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        ContentUnavailableView(
            "No sessions yet",
            systemImage: "terminal",
            description: Text("Connect a daemon via Daemons to start a session, or tap + to create one.")
        )
    }

    // MARK: - Edit mode actions

    private func enterEditMode() {
        isEditMode = true
        selectedSids = []
    }

    private func exitEditMode() {
        isEditMode = false
        selectedSids = []
    }

    private func toggleSelect(_ sid: String) {
        if selectedSids.contains(sid) {
            selectedSids.remove(sid)
        } else {
            selectedSids.insert(sid)
        }
    }

    private func toggleSelectAll() {
        if allStoppedSelected {
            selectedSids = []
        } else {
            selectedSids = Set(stoppedSessions.map(\.sid))
        }
    }

    private func confirmDelete() {
        showConfirmDelete = false
        let sids = selectedForDelete.map(\.sid)
        let count = sids.count
        Task { @MainActor in
            pairings.deleteSessions(sids, from: sessionStore)
            // L2 fix: show a toast confirming deletion (matches Expo handleConfirmDelete).
            let message = count == 1 ? "1 session removed" : "\(count) sessions removed"
            ToastCenter.shared.show(title: message, body: "Removed from this app's list.")
            // L2 fix: post an accessibility announcement so VoiceOver users hear the result.
            #if os(iOS) || os(visionOS)
            UIAccessibility.post(notification: .announcement, argument: message)
            #endif
        }
        exitEditMode()
    }
}

// MARK: - SessionRow

/// One row in the session list: status dot + cwd + sid + relative timestamp.
private struct SessionRow: View {
    let meta: SessionMeta

    var body: some View {
        HStack(spacing: 10) {
            // Status dot
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                // Primary label: last cwd component (or abbreviated full path)
                Text(primaryLabel)
                    .font(.body)
                    .lineLimit(1)

                HStack(spacing: 4) {
                    Text(meta.sid.prefix(16))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if !meta.cwd.isEmpty {
                        Text("·")
                            .foregroundStyle(.tertiary)
                        Text(abbreviatePath(meta.cwd))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer()

            Text(relativeTimestamp(meta.updatedAt))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }

    private var statusColor: Color {
        switch meta.state {
        case "running": return .green
        case "error":   return .red
        default:        return Color.secondary.opacity(0.4)
        }
    }

    /// The session's last cwd path component, falling back to the full path
    /// then the sid prefix if cwd is empty (avoids blank rows).
    private var primaryLabel: String {
        if meta.cwd.isEmpty {
            return String(meta.sid.prefix(16))
        }
        let last = meta.cwd
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/")
            .last
            .map(String.init)
        return last ?? abbreviatePath(meta.cwd)
    }

    private func abbreviatePath(_ path: String) -> String {
        #if os(macOS)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        #else
        let home = NSHomeDirectory()
        #endif
        if path.hasPrefix(home) {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    private func relativeTimestamp(_ ts: Double) -> String {
        let date = Date(timeIntervalSince1970: ts / 1000) // ms → s
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
