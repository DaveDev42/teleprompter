import Foundation
import ObjectiveC

// MARK: - Terminal context for voice prompt injection
//
// Ported from terminal-context.ts. Reads the visible terminal viewport via
// the associated-object closure pattern (mirrors TerminalOps.swift / Tranche E).

private enum TerminalContextKey {
    // Address-only associated-object key token (see TerminalOps.swift) — the Int
    // value is never accessed, so nonisolated(unsafe) is the correct Swift 6
    // annotation.
    nonisolated(unsafe) static var readText = 0
}

/// Extension of `SessionStore` that exposes a closure for reading the current
/// terminal viewport text (set by `SwiftTermView.Coordinator` via the Voice tranche).
///
/// The closure is set by `TerminalView` when it mounts a `SwiftTermView`, and
/// cleared when the view dismantles. Voice reads it to inject terminal context
/// into the Realtime API system prompt.
@MainActor
extension SessionStore {
    /// Returns the current visible terminal text for a given session, or nil when
    /// no terminal coordinator is attached.
    var terminalReadText: ((String) -> String?)? {
        get {
            objc_getAssociatedObject(self, &TerminalContextKey.readText)
                as? (String) -> String?
        }
        set {
            objc_setAssociatedObject(
                self,
                &TerminalContextKey.readText,
                newValue,
                .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }
    }
}

// MARK: - Terminal context formatting

/// Format the visible terminal content for inclusion in the Realtime API system prompt.
///
/// Returns empty string when the store has no terminal coordinator attached for `sid`.
/// Format matches terminal-context.ts's `formatTerminalContext`.
@MainActor
func formatTerminalContext(store: SessionStore, sid: String, maxLines: Int = 30) -> String {
    guard let reader = store.terminalReadText,
        let raw = reader(sid),
        !raw.isEmpty
    else {
        return ""
    }

    // Split, trim trailing empty lines (mirrors TypeScript's pop loop).
    var lines = raw.components(separatedBy: "\n")
    while lines.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
        lines.removeLast()
    }
    if lines.isEmpty { return "" }

    // Take the last `maxLines` lines.
    let slice = lines.suffix(maxLines)
    return
        "\n\n--- Terminal Output (last \(slice.count) lines) ---\n\(slice.joined(separator: "\n"))\n--- End Terminal ---"
}
