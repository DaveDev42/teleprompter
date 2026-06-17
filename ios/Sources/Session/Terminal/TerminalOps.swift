import Foundation
import ObjectiveC

// MARK: - SessionStore + terminal relay callbacks (Tranche E)

/// Associated-object keys for the three relay-callback closures injected into
/// `SessionStore` by `RelayClient` (Tranche E). Using associated objects because
/// `SessionStore` is declared in a separate file and cannot receive stored
/// properties in an extension.
private enum TerminalOpsKey {
    // Only the ADDRESS of each token is used (`&TerminalOpsKey.sendBytes` as the
    // objc_getAssociatedObject key) — the Int value is never read or written, so
    // there is no shared mutable state to race on. `nonisolated(unsafe)` tells the
    // Swift 6 concurrency checker exactly that; it's the canonical annotation for
    // ObjC associated-object key tokens.
    nonisolated(unsafe) static var sendBytes  = 0
    nonisolated(unsafe) static var resize     = 0
    nonisolated(unsafe) static var history    = 0
}

/// Extension of `SessionStore` that exposes relay-backed terminal callbacks.
/// These closures are set by `RelayClient` (which owns the relay connection and
/// session keys) and read by `TerminalView` / `SwiftTermView.Coordinator`.
///
/// **Thread safety**: `SessionStore` is `@MainActor`-isolated, so all accesses
/// to these associated-object values MUST be on the main actor.
@MainActor
extension SessionStore {
    /// Send raw PTY bytes into a session (`in.term`). Set by `RelayClient`.
    /// Arguments: (sid, bytes).
    var terminalSendBytes: ((String, [UInt8]) -> Void)? {
        get {
            objc_getAssociatedObject(self, &TerminalOpsKey.sendBytes)
                as? (String, [UInt8]) -> Void
        }
        set {
            objc_setAssociatedObject(
                self,
                &TerminalOpsKey.sendBytes,
                newValue,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }

    /// Resize the PTY of a running session (`resize`). Set by `RelayClient`.
    /// Arguments: (sid, cols, rows).
    var terminalResize: ((String, Int, Int) -> Void)? {
        get {
            objc_getAssociatedObject(self, &TerminalOpsKey.resize)
                as? (String, Int, Int) -> Void
        }
        set {
            objc_setAssociatedObject(
                self,
                &TerminalOpsKey.resize,
                newValue,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }

    /// Fetch buffered raw io bytes for history replay. Set by `RelayClient`.
    /// Argument: sid → Data? (nil when no history buffered yet).
    var terminalHistory: ((String) -> Data?)? {
        get {
            objc_getAssociatedObject(self, &TerminalOpsKey.history)
                as? (String) -> Data?
        }
        set {
            objc_setAssociatedObject(
                self,
                &TerminalOpsKey.history,
                newValue,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }
}
