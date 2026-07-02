import SwiftUI

// MARK: - Sentinel geometry helpers (M6 near-bottom detection)

/// Carries the sentinel view's maxY and the scroll viewport's maxY in global coordinates.
private struct SentinelOffset: Equatable {
    var sentinelMaxY: CGFloat
    var viewportMaxY: CGFloat
    static let zero = SentinelOffset(sentinelMaxY: 0, viewportMaxY: 0)
}

/// PreferenceKey used by the bottom-sentinel GeometryReader to propagate
/// its frame up the view tree to the ScrollView's onPreferenceChange handler.
private struct SentinelOffsetKey: PreferenceKey {
    static var defaultValue: SentinelOffset { .zero }
    static func reduce(value: inout SentinelOffset, nextValue: () -> SentinelOffset) {
        value = nextValue()
    }
}

/// Chat pane (ADR-0001 Phase 3, M4 → Tranche D). Renders hook-event records as
/// rich, visually-differentiated message cards — **hooks-only** by design
/// (CLAUDE.md "Key Design Decisions"): PTY `io` records never reach here; they
/// belong exclusively to the Terminal pane.
///
/// Card styles by hook event:
///   - `UserPromptSubmit`   → right-aligned user bubble
///   - `Stop` / `StopFailure` → left-aligned assistant bubble with markdown
///   - `PreToolUse`         → tool-running card (orange dot)
///   - `PostToolUse`        → tool-done card (green dot)
///   - `PermissionRequest`  → warning/lock card with Approve/Deny buttons (M5,
///                            actionable as of Batch C — replies over the same
///                            channel the composer uses)
///   - `Elicitation`        → input-requested card with an inline reply field
///                            (M5, actionable as of Batch C)
///   - everything else      → centred system pill (e.g. `Notification`)
///
/// When the session is still running AND the latest event is an open turn
/// (`UserPromptSubmit` with no closing `Stop`/`StopFailure` yet) an animated
/// "working" indicator is shown below the last card. A pending
/// `PermissionRequest`/`Elicitation` does NOT show the indicator — Claude is
/// blocked on the user, not "thinking" (FIX #5, Batch C; see
/// `SessionStore.isWorking`).
///
/// When `sid` is provided (SessionDetailView), only that session's items are
/// shown. When `sid` is nil, all sessions are flattened oldest-first.
///
/// M6: auto-scroll only fires when the user is already near the bottom, so
/// reading history is not interrupted by incoming events.
struct ChatView: View {
    @ObservedObject var store: SessionStore
    /// When non-nil, show only this session's chat items.
    var sid: String? = nil
    /// `(sid, text)` — routes chat input to RelayClient.sendInput via the host.
    var onSend: ((String, String) -> Void)? = nil
    /// Whether the daemon owning this session is currently reachable.
    /// Defaults `true` (assume connected) so existing callers keep compiling
    /// and behaving as before this param existed.
    ///
    /// TODO(Batch B follow-up): `SessionStore` itself carries no connectivity
    /// signal (it's pure session/chat state) — that lives in `PairingViewModel`
    /// (`daemonOnline`/`isOnline`, see `TeleprompterApp.swift`), which this file
    /// intentionally does not import per this batch's file-scope constraint.
    /// `SessionDetailView` already computes an equivalent `daemonOnline` for its
    /// `ConnectionBanner` — wire that same value through to `ChatView(daemonOnline:)`
    /// at the (single) call site in `SessionDetailView.swift` to make this gate
    /// live. Until then this param is inert (always `true`) and the composer
    /// gates on session state only (`stopped`/`error`), never on connectivity.
    var daemonOnline: Bool = true

    // M6: track whether the user is near the bottom of the scroll view.
    // Starts true so the initial render scrolls to bottom on appear.
    // Updated via geometry measurement (not onAppear/onDisappear) so content
    // insertions that push the sentinel out of the viewport do not falsely set
    // this to false — only a real user scroll-up suppresses auto-scroll.
    @State private var isNearBottom: Bool = true

    /// Chat items to display — scoped to `sid` when provided, else all sessions.
    private var items: [ChatItem] {
        if let sid {
            return store.chatItems[sid] ?? []
        }
        return store.chatItems.values.flatMap { $0 }.sorted {
            $0.ts != $1.ts ? $0.ts < $1.ts : $0.seq < $1.seq
        }
    }

    /// `true` when Claude is actively working on a turn: a prompt was submitted
    /// and no matching Stop has arrived yet. Delegates to `SessionStore.isWorking`
    /// (the unit-tested SoT) — see that method for the inversion bug this fixes.
    private var isWorking: Bool {
        store.isWorking(sid: sid)
    }

    /// `true` when the composer must refuse input: the session is stopped or
    /// errored (both terminal — CLAUDE.md/protocol `SessionState` is exactly
    /// `"running" | "stopped" | "error"`), OR the owning daemon is unreachable.
    /// A `nil` sid (aggregated view, no composer) is never "stopped" — matches
    /// the prior behavior since the composer never renders in that case anyway.
    ///
    /// FIX #3/#7 (Batch B): previously this only checked `state == "stopped"`,
    /// so a crashed ("error") session left the composer enabled and a typed
    /// message would silently vanish (fire-and-forget `onSend`, no ack — see
    /// `sendIfReady`). Broadened to state-terminal OR offline.
    ///
    /// Internal (not `private`) so `ChatRenderTests` can exercise this pure
    /// gate directly against fake `SessionStore` states without standing up
    /// a SwiftUI render pass.
    var sessionStopped: Bool {
        guard let sid else { return false }
        let state = store.sessions[sid]?.state
        return state == "stopped" || state == "error" || !daemonOnline
    }

    /// Short inline reason shown under the composer when it's disabled, so the
    /// gate isn't a silent dead end. Not a promise of queuing/offline-send —
    /// there is none (see CLAUDE.md `sendInput` fire-and-forget note).
    /// Internal (not `private`) for the same testability reason as `sessionStopped`.
    var disabledReason: String? {
        guard let sid, sessionStopped else { return nil }
        switch store.sessions[sid]?.state {
        case "stopped": return "Session ended — read-only."
        case "error": return "Session crashed — read-only."
        default: return daemonOnline ? nil : "Daemon offline — can't send."
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if items.isEmpty {
                ContentUnavailableView(
                    "No messages yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Attach a running session to see its hook events.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // Outer GeometryReader captures the scroll view's frame in global
                // coordinates so the inner sentinel can compare against it.
                GeometryReader { scrollGeo in
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 8) {
                                ForEach(items) { item in
                                    // FIX #1/#9 (Batch C): thread sid/onSend so
                                    // permission/elicitation cards can reply
                                    // in-place over the same channel the
                                    // composer uses. Both are nil in the
                                    // aggregated (sid == nil) view, where the
                                    // cards fall back to read-only rendering.
                                    ChatItemCard(item: item, sid: sid, onSend: onSend)
                                        .padding(.horizontal, 12)
                                        .id(item.id)
                                }
                                // Animated "working" indicator while the assistant is responding.
                                if isWorking {
                                    AssistantWorkingIndicator()
                                        .padding(.horizontal, 12)
                                        .id("__working__")
                                }
                                // Near-bottom sentinel (M6): a 1pt invisible view placed at
                                // the very bottom of the scroll content. We measure its
                                // position in the global coordinate space and compare it to
                                // the scroll view's own frame — if the sentinel is within
                                // 80pt of the visible bottom we are "near bottom".
                                // Using geometry (not onAppear/onDisappear) means content
                                // insertions that push the sentinel offscreen only update
                                // isNearBottom when the sentinel's minY actually moves
                                // outside the visible area due to a user drag, not due to
                                // a layout pass triggered by inserting the working indicator.
                                Color.clear
                                    .frame(height: 1)
                                    .id("__bottom__")
                                    .background(
                                        GeometryReader { sentinelGeo in
                                            Color.clear.preference(
                                                key: SentinelOffsetKey.self,
                                                value: SentinelOffset(
                                                    sentinelMaxY: sentinelGeo.frame(in: .global)
                                                        .maxY,
                                                    viewportMaxY: scrollGeo.frame(in: .global).maxY
                                                )
                                            )
                                        }
                                    )
                            }
                            .padding(.vertical, 8)
                        }
                        // M6: only auto-scroll when the user is already at/near the bottom.
                        .onChange(of: items.count) { _, _ in
                            guard isNearBottom else { return }
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo("__bottom__", anchor: .bottom)
                            }
                        }
                        .onChange(of: isWorking) { _, _ in
                            guard isNearBottom else { return }
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo("__bottom__", anchor: .bottom)
                            }
                        }
                        .onAppear {
                            // Initial render: always scroll to bottom.
                            proxy.scrollTo("__bottom__", anchor: .bottom)
                            isNearBottom = true
                        }
                        // Update isNearBottom from real geometry, not lifecycle events.
                        .onPreferenceChange(SentinelOffsetKey.self) { value in
                            // Sentinel is "near bottom" when it is within 80pt of or below
                            // the visible bottom edge of the scroll view. A positive delta
                            // means the sentinel is still below the viewport bottom (clipped
                            // content), which means the user has NOT scrolled to the bottom.
                            let threshold: CGFloat = 80
                            isNearBottom = value.sentinelMaxY <= value.viewportMaxY + threshold
                        }
                    }
                }
            }

            // Chat composer — only shown when a sid is known and onSend is wired.
            // Pass `store` so the VoiceButton (Tranche G) can read terminal context.
            if let sid, let onSend {
                if let disabledReason {
                    Text(disabledReason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.top, 4)
                        .accessibilityIdentifier("chat-composer-disabled-reason")
                }
                ChatComposer(
                    sid: sid,
                    onSend: onSend,
                    sessionStore: store,
                    sessionStopped: sessionStopped
                )
            }
        }
    }
}
