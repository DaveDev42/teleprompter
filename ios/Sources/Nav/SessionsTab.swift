import SwiftUI

/// Sessions tab — root of the session navigation stack. Lists all known sessions
/// with status, search/filter, multi-select delete, and new session creation.
/// Feature-parity with the old Expo `app/(tabs)/index.tsx`.
///
/// M13: Holds a controlled `navPath` so notification-tap navigation (via
/// `SessionNavigator.shared.pendingSid`) can programmatically push the session
/// detail view. The existing `NavigationLink(value:)` + `.navigationDestination`
/// tap-driven navigation continues to work unchanged because both paths share the
/// same `navPath` binding.
struct SessionsTab: View {
    @ObservedObject var sessionStore: SessionStore
    let pairings: PairingViewModel

    /// M13: Controlled navigation path so programmatic pushes (notification taps)
    /// can open the session detail view without user interaction.
    @State private var navPath: [String] = []

    /// Keyboard-shortcut nav intents (⌘[/⌘] step, ⌘K quick switch) are owned here
    /// because they mutate `navPath` (the controlled stack). See `orderedSids`.
    private let nav = AppNavigationModel.shared

    /// Canonical session ordering for keyboard stepping / quick-switch: running
    /// first, then by `updatedAt` descending. This deliberately mirrors
    /// `SessionListView.allSorted` (the *unfiltered* order) rather than its
    /// `filteredSessions`: stepping and quick-switch are global navigation intents
    /// over every session, so they must not skip rows hidden by an ephemeral
    /// in-list search query (which is private view state of `SessionListView`).
    private var orderedSids: [String] {
        sessionStore.sessions.values
            .sorted { a, b in
                let aRunning = (a.state == "running")
                let bRunning = (b.state == "running")
                if aRunning != bRunning { return aRunning }
                return a.updatedAt > b.updatedAt
            }
            .map(\.sid)
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            SessionListView(sessionStore: sessionStore, pairings: pairings)
                .navigationTitle("Sessions")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.large)
                #endif
        }
        // M13: Consume pendingSid from SessionNavigator so notification taps open the
        // detail view. RootView has already switched the tab to .sessions before this
        // onChange fires, so navPath = [sid] pushes immediately.
        // Clearing pendingSid after acting prevents spurious re-fires if subsequent
        // nil→value transitions occur.
        .onChange(of: SessionNavigator.shared.pendingSid) { _, sid in
            guard let sid else { return }
            navPath = [sid]
            SessionNavigator.shared.pendingSid = nil
        }
        // ⌘[ / ⌘] step: SessionDetailView calls nav.step(±1), bumping a monotonic
        // token. We compute the current sid from navPath.last, find it in the
        // canonical ordered list, move by the requested delta (clamped to bounds),
        // and drive the SAME navPath — no parallel nav state.
        .onChange(of: nav.sessionStep) { _, _ in
            stepSession(by: nav.stepDirection)
        }
        // ⌘K quick switch: present a sheet over the controlled stack. Tapping a row
        // sets navPath = [sid] (same stack) and dismisses.
        .sheet(isPresented: Bindable(nav).showQuickSwitcher) {
            QuickSwitcherSheet(
                sessionStore: sessionStore,
                currentSid: navPath.last,
                onSelect: { sid in
                    navPath = [sid]
                    nav.showQuickSwitcher = false
                },
                onCancel: { nav.showQuickSwitcher = false }
            )
        }
    }

    /// Move the open session by `delta` (−1 = prev, +1 = next) within `orderedSids`,
    /// clamped to the ends. No-op if no session is open or the open sid vanished.
    private func stepSession(by delta: Int) {
        guard delta != 0 else { return }
        let order = orderedSids
        guard !order.isEmpty else { return }
        // Resolve the currently-open session from the controlled stack.
        guard let currentSid = navPath.last,
              let idx = order.firstIndex(of: currentSid)
        else { return }
        let next = min(max(idx + delta, 0), order.count - 1)
        guard next != idx else { return } // already at an end
        navPath = [order[next]]
    }
}

/// ⌘K quick-switcher: a flat searchable list of every session. Tapping one pushes
/// it onto the shared `navPath`. Ordering matches the Sessions list (running first,
/// then updatedAt desc); the open session is marked.
private struct QuickSwitcherSheet: View {
    @ObservedObject var sessionStore: SessionStore
    let currentSid: String?
    let onSelect: (String) -> Void
    let onCancel: () -> Void

    @State private var query = ""

    private var sessions: [SessionMeta] {
        let sorted = sessionStore.sessions.values.sorted { a, b in
            let aRunning = (a.state == "running")
            let bRunning = (b.state == "running")
            if aRunning != bRunning { return aRunning }
            return a.updatedAt > b.updatedAt
        }
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return sorted }
        let q = trimmed.lowercased()
        return sorted.filter {
            $0.sid.lowercased().contains(q)
                || $0.cwd.lowercased().contains(q)
                || $0.state.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            List(sessions, id: \.sid) { meta in
                Button {
                    onSelect(meta.sid)
                } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(meta.state == "running" ? Color.green
                                : (meta.state == "error" ? Color.red
                                    : Color.secondary.opacity(0.4)))
                            .frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(quickLabel(meta))
                                .font(.body)
                                .lineLimit(1)
                            Text(meta.sid.prefix(16))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if meta.sid == currentSid {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                                .font(.caption)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("quick-switch-\(meta.sid)")
            }
            .listStyle(.plain)
            .searchable(text: $query, prompt: "Switch to session")
            .navigationTitle("Quick Switch")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("quick-switch-cancel")
                }
            }
        }
        .accessibilityIdentifier("quick-switch-sheet")
    }

    private func quickLabel(_ meta: SessionMeta) -> String {
        if meta.cwd.isEmpty { return String(meta.sid.prefix(16)) }
        let last = meta.cwd
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/")
            .last
            .map(String.init)
        return last ?? meta.cwd
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
