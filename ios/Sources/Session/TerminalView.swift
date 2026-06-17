import SwiftUI

/// Terminal pane (ADR-0001 Phase 3, M5 → Tranche E interactive upgrade). Renders the
/// `k == "io"` byte stream for a session using a real VT100/xterm emulator
/// (SwiftTerm) and offers a composer for `in.chat` input.
///
/// When `sid` is provided (SessionDetailView), it shows exactly that session's
/// terminal. When `sid` is nil (legacy standalone use), it falls back to
/// `store.sessions.keys.sorted().first` so the smoke harness / direct use still works.
///
/// **ANSI emulation**: `SwiftTermView` handles cursor movement, SGR colour,
/// erase/clear, alt-screen, and scrollback.
///
/// **Interactive (Tranche E)**:
/// - Hardware keyboard input (iPad / macOS) routes through SwiftTerm's `send`
///   delegate → `store.terminalSendBytes` → `RelayClient.sendInput(kind:.term)`.
/// - The on-screen text composer sends `in.chat` lines via `onSend`.
/// - `sizeChanged` → `store.terminalResize` → `RelayClient.sendResize`.
/// - History backfill: `store.terminalHistory` is called at attach time to replay
///   io bytes already buffered by `RelayClient.ioHistory` before the view appeared.
///
/// The three relay callbacks are installed on `store` by `RelayClient` (Tranche E,
/// `TerminalOps.swift`) so `SessionDetailView` does not need to be changed.
///
/// **Probe accumulator preserved**: `SessionStore.terminalOutput[sid]` (the raw
/// String accumulator used by `RelayClient.checkInputEcho` to detect the
/// `"tp-input-probe"` echo) is NOT rerouted through SwiftTerm. Both paths run
/// independently — the probe/smoke invariant is unaffected by this upgrade.
/// PTY io lives here, never in Chat (CLAUDE.md: Chat is hooks-only).
///
/// **M3: In-buffer search** — a collapsible search bar (Cmd+F / toolbar button)
/// delegates to SwiftTerm's built-in `findNext`/`findPrevious` API via a
/// `TerminalSearchProxy` owned by this view and passed into `SwiftTermView`.
struct TerminalView: View {
    @ObservedObject var store: SessionStore
    /// When non-nil, show exactly this session. When nil, fall back to first known.
    var sid: String? = nil
    /// Sends a chat line (in.chat) into the given session. Wired to
    /// `RelayClient.sendInput(kind:.chat)` by the app; takes (sid, text).
    let onSend: (String, String) -> Void

    /// L9: True once ~500 ms has elapsed since the current session was attached,
    /// mirroring the Expo `replaySettled` timer. Prevents flashing the "no output"
    /// empty-state during initial history replay.
    @State private var replaySettled = false
    /// M3: Search proxy — owned here, passed into SwiftTermView.
    @StateObject private var searchProxy = TerminalSearchProxy()
    /// M3: Current search query text.
    @State private var searchQuery = ""
    /// M3: Whether the last findNext/findPrevious call found a match.
    @State private var searchHasMatch: Bool? = nil

    /// Resolved session id: explicit `sid` param wins; fallback to first known session.
    private var resolvedSid: String? {
        if let sid { return sid }
        return store.sessions.keys.sorted().first
    }

    var body: some View {
        VStack(spacing: 0) {
            if resolvedSid == nil {
                ContentUnavailableView(
                    "No session",
                    systemImage: "terminal",
                    description: Text("Attach a running session to see its terminal."))
            } else {
                let sid = resolvedSid!

                // M3: Collapsible search bar.
                if searchProxy.isVisible {
                    searchBar
                        .transition(.move(edge: .top).combined(with: .opacity))
                }

                ZStack {
                    SwiftTermView(
                        store: store,
                        sid: sid,
                        onSend: onSend,
                        onTermInput: { bytes in store.terminalSendBytes?(sid, bytes) },
                        onResize: { cols, rows in store.terminalResize?(sid, cols, rows) },
                        fetchHistory: { store.terminalHistory?(sid) },
                        searchProxy: searchProxy
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("terminal-output")

                    // L9: Empty-state overlay for stopped sessions with no io output.
                    // Only shown once the replay-settle timer has fired, to avoid
                    // flashing during the initial 500 ms history backfill window.
                    // Mirrors Expo SessionTerminalView hasIo + replaySettled logic.
                    if replaySettled && emptyStateVisible(sid: sid) {
                        ContentUnavailableView(
                            "No terminal output",
                            systemImage: "terminal",
                            description: Text("No terminal output was captured for this session.")
                        )
                        .background(.background)
                        .accessibilityIdentifier("terminal-empty-state")
                    }
                }

                // Terminal composer — raw keystroke / control-sequence forwarding
                // with a practical key-row (Esc/Tab/Ctrl/arrows/symbols). Distinct
                // from the Chat composer because terminal input is keystrokes, not
                // whole prompts (CLAUDE.md: PTY io lives here, never in Chat).
                TerminalComposer(
                    sid: sid,
                    sendBytes: { bytes in store.terminalSendBytes?(sid, bytes) },
                    sessionStopped: sessionStopped(sid: sid)
                )
            }
        }
        // L9: Reset and restart the settle timer whenever the resolved session changes.
        .onChange(of: resolvedSid) { _, _ in
            replaySettled = false
            scheduleSettle()
        }
        .onAppear {
            replaySettled = false
            scheduleSettle()
        }
        // M3: Clear search state when the bar is dismissed.
        .onChange(of: searchProxy.isVisible) { _, visible in
            if !visible {
                searchQuery = ""
                searchHasMatch = nil
            }
        }
        // M3: Toolbar search button (macOS / iPadOS).
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    withAnimation { searchProxy.toggle() }
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .help("Find in terminal (⌘F)")
                .keyboardShortcut("f", modifiers: .command)
                .accessibilityLabel("Search terminal")
                .accessibilityIdentifier("terminal-search-button")
            }
        }
    }

    // MARK: - M3: Search bar

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)

            TextField("Find in terminal…", text: $searchQuery)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                #if os(iOS) || os(visionOS)
            .autocapitalization(.none)
                #endif
                .accessibilityIdentifier("terminal-search-field")
                .onSubmit { performSearch(next: true) }
                .onChange(of: searchQuery) { _, _ in
                    searchHasMatch = nil
                    if searchQuery.isEmpty { searchProxy.clearSearch() }
                }

            // Match indicator.
            if let hasMatch = searchHasMatch {
                Image(systemName: hasMatch ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(hasMatch ? Color.green : Color.red)
                    .accessibilityLabel(hasMatch ? "Match found" : "No match")
            }

            // Previous / Next buttons.
            Button {
                performSearch(next: false)
            } label: {
                Image(systemName: "chevron.up")
            }
            .buttonStyle(.plain)
            .disabled(searchQuery.isEmpty)
            .accessibilityLabel("Previous match")
            .accessibilityIdentifier("terminal-search-prev")

            Button {
                performSearch(next: true)
            } label: {
                Image(systemName: "chevron.down")
            }
            .buttonStyle(.plain)
            .disabled(searchQuery.isEmpty)
            .accessibilityLabel("Next match")
            .accessibilityIdentifier("terminal-search-next")

            // Close button.
            Button {
                withAnimation { searchProxy.hide() }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close search")
            .accessibilityIdentifier("terminal-search-close")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        .accessibilityIdentifier("terminal-search-bar")
    }

    private func performSearch(next: Bool) {
        guard !searchQuery.isEmpty else { return }
        let found =
            next
            ? searchProxy.findNext(query: searchQuery)
            : searchProxy.findPrevious(query: searchQuery)
        searchHasMatch = found
    }

    // MARK: - L9 helpers

    /// True when the empty-state overlay should be shown:
    /// session is stopped (or error) AND no io bytes have arrived.
    private func emptyStateVisible(sid: String) -> Bool {
        let state = store.sessions[sid]?.state ?? ""
        let isStopped = state == "stopped" || state == "error"
        let hasIo = !(store.terminalOutput[sid]?.isEmpty ?? true)
        return isStopped && !hasIo
    }

    /// Fire the settle flag after ~500 ms, matching the Expo replaySettled timer.
    private func scheduleSettle() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(500))
            replaySettled = true
        }
    }

    /// Whether the given session is stopped (no more input accepted).
    private func sessionStopped(sid: String) -> Bool {
        let state = store.sessions[sid]?.state ?? ""
        return state == "stopped" || state == "error"
    }
}
