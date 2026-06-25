import Foundation
import os

/// Handles inbound `tp://` deep links (ADR-0001 Phase 3, M1).
///
/// The only link kind so far is the pairing bundle `tp://p?d=<base64url>`, which
/// the daemon prints as a QR during `tp pair new`. Decoding is delegated to the
/// Rust core (`decodePairingData`) via `PairingStore.ingest`; on success the
/// pairing is persisted (Keychain secret + UserDefaults metadata) and a
/// `TP_PAIR_OK did=<id>` marker is emitted to the unified log so the Simulator
/// harness (`scripts/ios.sh smoke`) can verify offline ingestion end-to-end.
enum DeepLinkHandler {
    /// Verification markers greppable from the Simulator unified log.
    /// Keep in sync with `scripts/ios.sh` (the `smoke` predicate).
    static let pairMarker = "TP_PAIR_OK"
    static let pairFailMarker = "TP_PAIR_FAIL"

    private static let log = Logger(subsystem: "dev.tpmt.app", category: "deeplink")

    /// Outcome of handling a single URL — surfaced to the UI and the log.
    enum Outcome: Equatable {
        case paired(daemonId: String)
        case ignored(reason: String)
        case failed(reason: String)
    }

    /// Route a URL. Returns the outcome; also emits the marker line.
    @discardableResult
    static func handle(_ url: URL, store: PairingStore = .shared) -> Outcome {
        guard url.scheme == "tp" else {
            return .ignored(reason: "scheme \(url.scheme ?? "nil")")
        }
        // `tp://p?d=…` — host is "p" (pairing). Anything else is not ours yet.
        guard url.host == "p" else {
            return .ignored(reason: "host \(url.host ?? "nil")")
        }
        do {
            let pairing = try store.ingest(deepLink: url.absoluteString)
            // Mark with the daemon id only — never the secret.
            log.notice("\(pairMarker, privacy: .public) did=\(pairing.daemonId, privacy: .public)")
            return .paired(daemonId: pairing.daemonId)
        } catch {
            let reason = "\(error)"
            log.error("\(pairFailMarker, privacy: .public) detail=\(reason, privacy: .public)")
            return .failed(reason: reason)
        }
    }
}
