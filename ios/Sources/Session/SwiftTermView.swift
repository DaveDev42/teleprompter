import SwiftTerm
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

// MARK: - TerminalSearchProxy (M3)

/// Mediates in-buffer search between the SwiftUI search bar and the underlying
/// SwiftTerm.TerminalView (UIView/NSView).
///
/// SwiftTerm.TerminalView ships `findNext(_:options:scrollToResult:)` /
/// `findPrevious(_:options:scrollToResult:)` / `clearSearch()` as public methods
/// on extensions in TerminalViewSearch.swift.  SwiftUI cannot call UIView/NSView
/// methods directly; this proxy bridges the gap:
///   1. `SwiftTermView.Coordinator.attach(to:)` registers the three actions.
///   2. `TerminalView`'s search bar calls `findNext(query:)` / `findPrevious(query:)`.
///
/// Thread-safety: all accesses on the main actor (SwiftTermView is always
/// created on the main actor and search is triggered by UI events).
@MainActor
final class TerminalSearchProxy: ObservableObject {
    /// True when the search field should be visible.
    @Published var isVisible = false

    fileprivate var _findNext: ((String) -> Bool)?
    fileprivate var _findPrevious: ((String) -> Bool)?
    fileprivate var _clearSearch: (() -> Void)?

    /// Perform findNext. Returns true if a match was found.
    @discardableResult
    func findNext(query: String) -> Bool {
        guard !query.isEmpty, let action = _findNext else { return false }
        return action(query)
    }

    /// Perform findPrevious. Returns true if a match was found.
    @discardableResult
    func findPrevious(query: String) -> Bool {
        guard !query.isEmpty, let action = _findPrevious else { return false }
        return action(query)
    }

    func clearSearch() {
        _clearSearch?()
    }

    func show() { isVisible = true }
    func hide() {
        isVisible = false
        clearSearch()
    }
    func toggle() { isVisible ? hide() : show() }
}

// MARK: - SwiftTermView

/// A SwiftUI view that wraps SwiftTerm's `TerminalView` for ANSI/VT100 emulation
/// in the Terminal tab (ADR-0001 Phase 3.x, Tranche E interactive).
///
/// **Design: additive byte sink, not a reroute.**
/// `SessionStore.terminalOutput[sid]` (the raw String accumulator) is preserved
/// verbatim — `RelayClient.checkInputEcho` scans it for the `"tp-input-probe"` token.
/// This view registers a *parallel* `SessionStore.terminalByteSink` that feeds raw PTY
/// bytes into SwiftTerm. Both paths run independently; bad base64 in either path is
/// already gated upstream in `appendRec`.
///
/// **Tranche E: fully interactive.**
/// - Keyboard input (hardware keyboard on iPad/macOS, software on iOS): SwiftTerm's
///   `send(source:data:)` delegate fires for every keystroke. Bytes are forwarded to
///   the PTY via `onTermInput` → `RelayClient.sendInput(kind:.term)`.
/// - Resize negotiation: `sizeChanged(source:newCols:newRows:)` fires when the view
///   geometry changes. The delegate calls `onResize` → `RelayClient.sendResize`.
/// - History backfill: `fetchHistory()` is called once at attach time. If the caller
///   provides buffered raw bytes (from `RelayClient.ioHistory`), they are fed into
///   SwiftTerm so reconnecting shows full scrollback.
///
/// **Terminal buffer read API (for Voice tranche)**:
/// `Coordinator.readVisibleText()` returns the current visible viewport as a plain
/// UTF-8 string by iterating `terminal.buffer.lines` from SwiftTerm's Terminal model.
///
/// **M3: In-buffer search** — pass a `TerminalSearchProxy` and call
/// `proxy.findNext(query:)` / `proxy.findPrevious(query:)` from the UI. The proxy
/// delegates to SwiftTerm's built-in `findNext(_:)` / `findPrevious(_:)` API
/// (TerminalViewSearch.swift) which highlights and scrolls to the match.
///
/// `SwiftTerm.TerminalView` is a `UIView` subclass on iOS/visionOS (`iOSTerminalView.swift`)
/// and an `NSView` subclass on macOS (`MacTerminalView.swift`). The `feed(byteArray:)` API
/// (`Apple/AppleTerminalView.swift:1916`), the `terminalDelegate` property
/// (`MacTerminalView.swift:96`), and the `TerminalViewDelegate` protocol
/// (`Apple/TerminalViewDelegate.swift`, gated `#if os(iOS) || os(visionOS) || os(macOS)`)
/// are identical across platforms — only the SwiftUI representable wrapper differs
/// (`UIViewRepresentable` vs `NSViewRepresentable`). The make/update/dismantle bodies are
/// kept in shared `_make`/`_update`/`_dismantle` helpers so the platform split is a thin
/// protocol-method shim, not duplicated logic.
struct SwiftTermView {
    let store: SessionStore
    let sid: String
    let onSend: (String, String) -> Void
    /// Called with raw PTY bytes the user typed (hardware keyboard). Takes bytes
    /// as `[UInt8]` so the caller can base64-encode them for `in.term`.
    var onTermInput: ([UInt8]) -> Void = { _ in }
    /// Called when the terminal's col/row dimensions change due to view resize.
    /// Caller sends a `resize` frame to the daemon.
    var onResize: (Int, Int) -> Void = { _, _ in }
    /// Called once at attach time to retrieve buffered io bytes for history replay.
    /// Nil return means no buffered history (fresh session or not yet backfilled).
    var fetchHistory: (() -> Data?)? = nil
    /// M3: Optional search proxy — when provided, the Coordinator registers
    /// SwiftTerm's findNext/findPrevious/clearSearch on it.
    var searchProxy: TerminalSearchProxy? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(
            sid: sid, store: store, onSend: onSend,
            onTermInput: onTermInput, onResize: onResize,
            fetchHistory: fetchHistory,
            searchProxy: searchProxy)
    }

    // MARK: - Shared make/update/dismantle (platform-agnostic)

    @MainActor
    private func _make(coordinator: Coordinator) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .zero)
        view.terminalDelegate = coordinator
        coordinator.attach(to: view)
        return view
    }

    @MainActor
    private func _update(_ view: SwiftTerm.TerminalView, coordinator: Coordinator) {
        // Re-register the sink if sid or store changed.
        coordinator.reattach(sid: sid, store: store, to: view)
    }

    @MainActor
    private static func _dismantle(_ coordinator: Coordinator) {
        coordinator.detach()
    }
}

#if os(macOS)
extension SwiftTermView: NSViewRepresentable {
    typealias NSViewType = SwiftTerm.TerminalView

    @MainActor
    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        _make(coordinator: context.coordinator)
    }

    @MainActor
    func updateNSView(_ nsView: SwiftTerm.TerminalView, context: Context) {
        _update(nsView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleNSView(_ nsView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        _dismantle(coordinator)
    }
}
#else
extension SwiftTermView: UIViewRepresentable {
    // Use SwiftTerm.TerminalView (the UIKit class) as the UIViewType, disambiguating
    // from the Teleprompter.TerminalView SwiftUI struct in this module.
    typealias UIViewType = SwiftTerm.TerminalView

    @MainActor
    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        _make(coordinator: context.coordinator)
    }

    @MainActor
    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        _update(uiView, coordinator: context.coordinator)
    }

    @MainActor
    static func dismantleUIView(_ uiView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        _dismantle(coordinator)
    }
}
#endif

// MARK: - Coordinator

extension SwiftTermView {
    /// Manages the `terminalByteSink` registration lifecycle and the
    /// `TerminalViewDelegate` protocol conformance.
    ///
    /// **Interactive (Tranche E)**:
    ///   `send(source:data:)` → `onTermInput` (hardware keyboard → PTY)
    ///   `sizeChanged(source:newCols:newRows:)` → `onResize` (PTY resize)
    ///
    /// **Terminal buffer read API (public, for Voice tranche)**:
    ///   `readVisibleText() -> String` — snapshot of the current viewport.
    ///
    /// **M3: In-buffer search**
    ///   Registers `findNext`/`findPrevious`/`clearSearch` on `searchProxy` (if set)
    ///   so the TerminalView search bar can drive SwiftTerm's built-in search.
    ///
    /// **TerminalViewDelegate conformance.**
    /// All methods in `TerminalViewDelegate` (Apple/TerminalViewDelegate.swift:12–91)
    /// except two have no default implementations and must be provided:
    ///   sizeChanged, setTerminalTitle, hostCurrentDirectoryUpdate, send,
    ///   scrolled, requestOpenLink, clipboardCopy, rangeChanged.
    /// Methods with defaults (Apple/TerminalViewDelegate.swift:64,83): bell, iTermContent.
    /// The protocol and these defaults are shared across iOS/visionOS/macOS, so this
    /// Coordinator is platform-agnostic.
    final class Coordinator: NSObject, SwiftTerm.TerminalViewDelegate {
        private var currentSid: String
        private weak var currentStore: SessionStore?
        private weak var terminalView: SwiftTerm.TerminalView?
        let onSend: (String, String) -> Void
        /// Routes raw keystroke bytes from SwiftTerm to the relay.
        private var onTermInput: ([UInt8]) -> Void
        /// Routes PTY resize events (cols, rows) to the relay.
        private var onResize: (Int, Int) -> Void
        /// Optional closure to fetch buffered io history for initial backfill.
        private var fetchHistory: (() -> Data?)?
        /// M3: Optional search proxy — registers search actions on attach.
        private weak var searchProxy: TerminalSearchProxy?

        init(
            sid: String,
            store: SessionStore,
            onSend: @escaping (String, String) -> Void,
            onTermInput: @escaping ([UInt8]) -> Void,
            onResize: @escaping (Int, Int) -> Void,
            fetchHistory: (() -> Data?)?,
            searchProxy: TerminalSearchProxy?
        ) {
            self.currentSid = sid
            self.currentStore = store
            self.onSend = onSend
            self.onTermInput = onTermInput
            self.onResize = onResize
            self.fetchHistory = fetchHistory
            self.searchProxy = searchProxy
        }

        // MARK: - Sink lifecycle

        @MainActor
        func attach(to view: SwiftTerm.TerminalView) {
            terminalView = view
            replayHistory(into: view)
            registerSink()
            registerSearch(on: view)
        }

        @MainActor
        func reattach(sid: String, store: SessionStore, to view: SwiftTerm.TerminalView) {
            guard sid != currentSid || store !== currentStore else { return }
            currentSid = sid
            currentStore = store
            terminalView = view
            replayHistory(into: view)
            registerSink()
            registerSearch(on: view)
        }

        @MainActor
        func detach() {
            currentStore?.terminalByteSink = nil
            currentStore?.terminalReadText = nil
        }

        /// Feed buffered history bytes into `view` once at attach time so
        /// the terminal shows full scrollback even when the user navigates
        /// to this tab after the backfill batch has already been processed.
        @MainActor
        private func replayHistory(into view: SwiftTerm.TerminalView) {
            guard let history = fetchHistory?() else { return }
            view.feed(byteArray: [UInt8](history)[...])
        }

        @MainActor
        private func registerSink() {
            let capSid = currentSid
            // `terminalView` is already a `weak var` property of the coordinator;
            // reach it through `self` (also captured weakly) instead of a separate
            // local weak var, which Swift 6 + WAE rejects as "never mutated".
            currentStore?.terminalByteSink = { [weak self] incomingSid, data in
                guard incomingSid == capSid else { return }
                guard let self else { return }
                guard let view = self.terminalView else {
                    self.currentStore?.terminalByteSink = nil
                    return
                }
                // feed(byteArray:) is defined on SwiftTerm.TerminalView
                // (AppleTerminalView.swift:1916) — accepts ArraySlice<UInt8>.
                view.feed(byteArray: [UInt8](data)[...])
            }
            registerReadText()
        }

        /// Publish the viewport-read closure on the store so the Voice tranche can
        /// inject terminal context into the Realtime system prompt
        /// (`formatTerminalContext` → `SessionStore.terminalReadText`). Sid-keyed:
        /// returns the snapshot only when the requested sid matches the attached
        /// terminal, mirroring `terminalByteSink`. Cleared on `detach()`.
        @MainActor
        private func registerReadText() {
            let capSid = currentSid
            currentStore?.terminalReadText = { [weak self] requestedSid in
                guard requestedSid == capSid, let self else { return nil }
                return self.readVisibleText()
            }
        }

        /// M3: Register the SwiftTerm search methods on the proxy so the
        /// TerminalView search bar can call them without holding a UIView reference.
        /// TerminalViewSearch.swift is gated `#if os(macOS) || os(iOS) || os(visionOS)`,
        /// which covers all our supported platforms.
        @MainActor
        private func registerSearch(on view: SwiftTerm.TerminalView) {
            guard let proxy = searchProxy else { return }
            proxy._findNext = { [weak view] query in
                view?.findNext(query, scrollToResult: true) ?? false
            }
            proxy._findPrevious = { [weak view] query in
                view?.findPrevious(query, scrollToResult: true) ?? false
            }
            proxy._clearSearch = { [weak view] in
                view?.clearSearch()
            }
        }

        // MARK: - Terminal buffer read API (Voice tranche)

        /// Snapshot the current visible terminal viewport as a plain UTF-8 string.
        ///
        /// Uses `Terminal.getBufferAsData(kind:.active)` (public API) to serialise
        /// the active buffer, then trims it to the last `rows` lines so the caller
        /// gets only the viewport (not the full scrollback). Each line is
        /// right-trimmed by `translateToString(trimRight:true)` inside SwiftTerm.
        ///
        /// **Signature (public, for Voice tranche)**:
        /// `Coordinator.readVisibleText() -> String`
        ///
        /// Returns an empty string when no terminal view is attached.
        @MainActor
        public func readVisibleText() -> String {
            guard let view = terminalView else { return "" }
            let terminal = view.getTerminal()
            let rows = terminal.rows
            // getBufferAsData encodes every line (scrollback + viewport) as UTF-8
            // with newline terminators. Split and take the last `rows` lines.
            let data = terminal.getBufferAsData(kind: .active)
            guard let text = String(data: data, encoding: .utf8) else { return "" }
            var allLines = text.components(separatedBy: "\n")
            // getBufferAsData appends a trailing newline after the last line, so
            // the last element is always empty — drop it before slicing.
            if allLines.last == "" { allLines.removeLast() }
            let viewportLines = allLines.suffix(rows)
            return viewportLines.joined(separator: "\n")
        }

        // MARK: - TerminalViewDelegate (required)

        // Called when the view's geometry changes and SwiftTerm recalculates cols/rows.
        // Forward to the relay so the daemon can resize the PTY to match the display.
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            onResize(newCols, newRows)
        }

        // Required: remote application set the window title.
        // Not surfaced in the current UI — ignore.
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}

        // Required: OSC 7 "current directory" update.
        // Not surfaced in the current UI — ignore.
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}

        // Required: the terminal emulator forwards keystrokes the user typed.
        // Forward the raw bytes to the relay as `in.term` (base64-encoded by the caller).
        // The TextField composer sends `in.chat` via onSend — these are independent paths.
        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            onTermInput(Array(data))
        }

        // Required: terminal scrolled; position ∈ [0,1].
        // Scroll indicator not synced externally — ignore.
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}

        // Required: user activated a hyperlink (OSC 8 or implicit URL).
        // Not handled in the current milestone — ignore.
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String])
        {}

        // Required: OSC 52 clipboard copy.
        // L8: Write the decoded string to the system clipboard so terminal apps
        // that emit OSC 52 (e.g. tmux "copy-mode") work correctly.
        // Uses the same platform-gated pasteboard pattern as ChatCard.swift.
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            guard let text = String(data: content, encoding: .utf8), !text.isEmpty else { return }
            #if os(iOS) || os(visionOS)
            UIPasteboard.general.string = text
            #elseif os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            #endif
            // Optional brief toast so the user knows a copy happened silently.
            Task { @MainActor in
                ToastCenter.shared.show(title: "Copied", body: text.prefix(60).description)
            }
        }

        // Required: visual range changed (notifyUpdateChanges must be true to receive).
        // Not used — ignore.
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

        // bell and iTermContent have default implementations in SwiftTerm's
        // extension TerminalViewDelegate (iOSTerminalView.swift:2657–2668).
    }
}
