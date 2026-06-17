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
///   - `PermissionRequest`  → warning/lock card (M5)
///   - `Elicitation`        → input-requested card (M5)
///   - everything else      → centred system pill (e.g. `Notification`)
///
/// When the session is still running (last event is not a Stop) an animated
/// "working" indicator is shown below the last card.
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

    /// `true` when the session is still running (last event is not a Stop).
    private var isWorking: Bool {
        guard let last = items.last else { return false }
        switch ChatEventCardKind(item: last) {
        case .assistant: return false
        default: return true
        }
    }

    /// `true` when the session's state is "stopped" (no more input accepted).
    private var sessionStopped: Bool {
        guard let sid else { return false }
        return store.sessions[sid]?.state == "stopped"
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
                                    ChatItemCard(item: item)
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
