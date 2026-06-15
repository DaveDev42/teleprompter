import SwiftUI
import SwiftTerm
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A SwiftUI view that wraps SwiftTerm's `TerminalView` for ANSI/VT100 emulation
/// in the Terminal tab (ADR-0001 Phase 3.x, milestone A1).
///
/// **Design: additive byte sink, not a reroute.**
/// `SessionStore.terminalOutput[sid]` (the raw String accumulator) is preserved
/// verbatim — `RelayClient.checkInputEcho` scans it for the `"tp-input-probe"` token.
/// This view registers a *parallel* `SessionStore.terminalByteSink` that feeds raw PTY
/// bytes into SwiftTerm. Both paths run independently; bad base64 in either path is
/// already gated upstream in `appendRec`.
///
/// **A1 limitation — go-forward render only.**
/// The emulator starts empty. Bytes received *before* the view appears (e.g. history
/// backfill) are not back-filled. This is the agreed A1 default: `terminalOutput` (the
/// raw String accumulator) still carries the full history; the SwiftTerm view
/// shows go-forward bytes only. Back-fill from the accumulated String is intentionally
/// skipped because `String.utf8` re-encoding vs raw `Data` diverges on split multi-byte
/// sequences → U+FFFD artifacts.
///
/// **A1 limitation — columns/rows not negotiated.**
/// The terminal uses SwiftTerm's default (80×24). The daemon/runner does not receive a
/// resize signal from the frontend in A1.
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

    func makeCoordinator() -> Coordinator {
        Coordinator(sid: sid, store: store, onSend: onSend)
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
    /// Adapts `SwiftTerm.TerminalViewDelegate` for the display-only A1 milestone.
    /// Also manages the `terminalByteSink` registration lifecycle.
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

        init(sid: String, store: SessionStore, onSend: @escaping (String, String) -> Void) {
            self.currentSid = sid
            self.currentStore = store
            self.onSend = onSend
        }

        // MARK: - Sink lifecycle

        @MainActor
        func attach(to view: SwiftTerm.TerminalView) {
            terminalView = view
            registerSink()
        }

        @MainActor
        func reattach(sid: String, store: SessionStore, to view: SwiftTerm.TerminalView) {
            guard sid != currentSid || store !== currentStore else { return }
            currentSid = sid
            currentStore = store
            terminalView = view
            registerSink()
        }

        @MainActor
        func detach() {
            currentStore?.terminalByteSink = nil
        }

        @MainActor
        private func registerSink() {
            let capSid = currentSid
            weak var weakView = terminalView
            currentStore?.terminalByteSink = { [weak self] incomingSid, data in
                guard incomingSid == capSid else { return }
                guard let view = weakView else {
                    self?.currentStore?.terminalByteSink = nil
                    return
                }
                // feed(byteArray:) is defined on SwiftTerm.TerminalView
                // (AppleTerminalView.swift:1916) — accepts ArraySlice<UInt8>.
                view.feed(byteArray: [UInt8](data)[...])
            }
        }

        // MARK: - TerminalViewDelegate (required stubs)

        // Required: terminal emulator requested the host resize the view.
        // A1: cols/rows negotiation not wired — ignore.
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {}

        // Required: remote application set the window title.
        // A1: title bar not updated — ignore.
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}

        // Required: OSC 7 "current directory" update.
        // A1: not surfaced — ignore.
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}

        // Required: the terminal emulator is asking to *send* bytes to the PTY.
        // A1 is display-only; hardware keyboard input is disabled — no-op.
        // The TextField composer calls onSend directly (not through this delegate).
        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {}

        // Required: terminal scrolled; position ∈ [0,1].
        // A1: scroll indicator not synced externally — ignore.
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}

        // Required: user activated a hyperlink (OSC 8 or implicit URL).
        // A1: not handled — ignore.
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {}

        // Required: OSC 52 clipboard copy.
        // A1: not handled — ignore.
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {}

        // Required: visual range changed (notifyUpdateChanges must be true to receive).
        // A1: not used — ignore.
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

        // bell and iTermContent have default implementations in SwiftTerm's
        // extension TerminalViewDelegate (iOSTerminalView.swift:2657–2668).
    }
}
