import SwiftUI
import os

/// Per-daemon git worktree management surface, presented as a sheet from the
/// Daemons tab. Lists the daemon's worktrees (`worktree.list`), lets the user
/// create a new one (`worktree.create` — the daemon auto-spawns a session in it),
/// and remove non-main worktrees (`worktree.remove`).
///
/// State lives in `WorktreeStore.shared` (keyed by daemonId), fed by the inbound
/// `worktree.list` / `worktree.created` / `worktree.removed` / `err` replies
/// decoded in `RelayClient.onRelayFrame`. The view re-requests `worktree.list` on
/// appear and applies incremental deltas in between, mirroring how `SessionStore`
/// drives the sessions list.
struct WorktreesView: View {
    let daemonId: String
    let displayName: String
    /// Resolves the live `RelayClient` for this daemon. Returns nil when the
    /// daemon is offline (no kx), which disables the worktree controls.
    let client: () -> RelayClient?
    var onDismiss: () -> Void

    @ObservedObject private var store = WorktreeStore.shared
    @State private var showCreate = false

    private let log = Logger(subsystem: "dev.tpmt.app", category: "worktrees-view")

    private var worktrees: [WorktreeInfo] { store.worktrees(for: daemonId) }
    private var lastError: String? { store.error(for: daemonId) }
    private var isOnline: Bool { client()?.isReady ?? false }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let err = lastError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal)
                        .padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.08))
                        .accessibilityIdentifier("worktree-error-banner")
                }

                if !isOnline {
                    offlineState
                } else if worktrees.isEmpty {
                    emptyState
                } else {
                    worktreeList
                }
            }
            .navigationTitle("Worktrees")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                        .accessibilityIdentifier("worktrees-done-btn")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showCreate = true
                    } label: {
                        Image(systemName: "plus")
                            .accessibilityLabel("Create worktree")
                    }
                    .disabled(!isOnline)
                    .accessibilityIdentifier("worktree-create-btn")
                }
            }
            .sheet(isPresented: $showCreate) {
                CreateWorktreeSheet(
                    daemonName: displayName,
                    onCreate: { branch, baseBranch in
                        showCreate = false
                        let base = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
                        client()?.createWorktree(
                            branch: branch,
                            baseBranch: base.isEmpty ? nil : base
                        )
                    },
                    onCancel: { showCreate = false }
                )
            }
            .onAppear { refresh() }
        }
    }

    // MARK: - List

    private var worktreeList: some View {
        List {
            ForEach(worktrees) { wt in
                WorktreeRow(
                    info: wt,
                    onRemove: wt.isMain ? nil : { remove(wt) }
                )
                .accessibilityIdentifier("worktree-\(wt.path)")
            }
        }
        .listStyle(.plain)
        .refreshable { refresh() }
    }

    // MARK: - Empty / offline states

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("No Worktrees")
                .font(.title3.bold())
            Text("Create a worktree to start a session on a separate branch without touching your working tree.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                showCreate = true
            } label: {
                Label("Create Worktree", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("worktree-empty-create-btn")
            Spacer()
        }
        .padding()
        .accessibilityIdentifier("worktree-empty-state")
    }

    private var offlineState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "wifi.slash")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text("\(displayName) is Offline")
                .font(.title3.bold())
                .multilineTextAlignment(.center)
            Text("Worktree management needs a live connection to the daemon.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
        .padding()
        .accessibilityIdentifier("worktree-offline-state")
    }

    // MARK: - Actions

    private func refresh() {
        guard let c = client() else {
            log.notice("worktrees: refresh skipped — daemon offline")
            return
        }
        c.listWorktrees()
    }

    private func remove(_ wt: WorktreeInfo) {
        log.notice("worktrees: remove path=\(wt.path, privacy: .public)")
        client()?.removeWorktree(path: wt.path)
    }
}

// MARK: - Worktree row

/// One worktree in the list: branch name (or detached HEAD), short path, short
/// HEAD sha, a "main" badge for the primary worktree, and a remove button for
/// non-main worktrees.
private struct WorktreeRow: View {
    let info: WorktreeInfo
    /// Nil for the main worktree (not removable); the daemon rejects removing it.
    let onRemove: (() -> Void)?

    private var branchName: String { info.branch ?? "(detached)" }
    private var shortHead: String { String(info.head.prefix(8)) }
    private var folderName: String {
        (info.path as NSString).lastPathComponent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: info.isMain ? "house.fill" : "arrow.triangle.branch")
                    .foregroundStyle(info.isMain ? Color.accentColor : .secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(branchName)
                            .font(.headline)
                            .accessibilityIdentifier("worktree-branch-\(info.path)")
                        if info.isMain {
                            Text("main")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.accentColor.opacity(0.15))
                                .clipShape(Capsule())
                                .accessibilityIdentifier("worktree-main-badge-\(info.path)")
                        }
                    }
                    Text(folderName)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                if let onRemove {
                    Button("Remove", action: onRemove)
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .tint(.red)
                        .accessibilityIdentifier("worktree-remove-\(info.path)")
                }
            }
            HStack {
                Text("HEAD")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(shortHead)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
    }
}

// MARK: - Create worktree sheet

/// Sheet to create a new worktree. `branch` is required (the new branch name);
/// `baseBranch` is optional (the daemon forks from its default branch when empty).
/// On submit the daemon creates the worktree AND auto-spawns a session in it.
private struct CreateWorktreeSheet: View {
    let daemonName: String
    var onCreate: (_ branch: String, _ baseBranch: String) -> Void
    var onCancel: () -> Void

    @State private var branch = ""
    @State private var baseBranch = ""

    private var trimmedBranch: String {
        branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canCreate: Bool { !trimmedBranch.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Branch name", text: $branch)
                        #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                        #endif
                        .accessibilityIdentifier("worktree-branch-field")
                } header: {
                    Text("New Branch")
                } footer: {
                    Text("A new git worktree and a Claude session will be created on this branch.")
                }

                Section {
                    TextField("Base branch (optional)", text: $baseBranch)
                        #if os(iOS)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled(true)
                        #endif
                        .accessibilityIdentifier("worktree-base-field")
                } header: {
                    Text("Fork From")
                } footer: {
                    Text("Leave empty to fork from the daemon's current branch.")
                }
            }
            .navigationTitle("New Worktree")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .accessibilityIdentifier("worktree-create-cancel-btn")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        onCreate(trimmedBranch, baseBranch)
                    }
                    .disabled(!canCreate)
                    .accessibilityIdentifier("worktree-create-submit-btn")
                }
            }
        }
    }
}
