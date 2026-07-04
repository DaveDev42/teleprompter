import Foundation
import os

/// Handles inbound `tp://` deep links (ADR-0001 Phase 3, M1).
///
/// The only link kind so far is the pairing bundle `tp://p?d=<base64url>`, which
/// the daemon prints as a QR during `tp pair new`. Decoding is delegated to the
/// Rust core (`decodePairingData`) via `PairingStore.ingest`; on success the
/// pairing is persisted to the **PENDING** namespace and a `TP_PAIR_PENDING`
/// marker is emitted to the unified log so the Simulator harness
/// (`scripts/ios.sh smoke`) can verify offline ingestion end-to-end. The
/// `TP_PAIR_OK` marker is emitted later, at promotion time
/// (`PairingViewModel.beginPending`'s confirm callback), once the pairing's relay
/// client completes the handshake.
enum DeepLinkHandler {
    /// Verification markers greppable from the Simulator unified log.
    /// Keep in sync with `scripts/ios.sh` (the `smoke` predicate).
    /// `TP_PAIR_PENDING` = QR decoded + persisted to PENDING (ingest success).
    /// `TP_PAIR_OK` = pairing promoted to COMMITTED (emitted from the viewmodel).
    static let pairPendingMarker = "TP_PAIR_PENDING"
    static let pairMarker = "TP_PAIR_OK"
    static let pairFailMarker = "TP_PAIR_FAIL"

    private static let log = Logger(subsystem: "dev.tpmt.app", category: "deeplink")

    /// Outcome of handling a single URL — surfaced to the UI and the log.
    enum Outcome: Equatable {
        /// Decode + PENDING persist succeeded. The caller starts a relay client
        /// (`beginPending`); the pairing is not yet COMMITTED.
        case pending(pairingId: String)
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
            let result = try store.ingest(deepLink: url.absoluteString)
            guard case .pending(let pairingId) = result else {
                return .failed(reason: "unexpected ingest result")
            }
            // Mark with the daemonId + pairingId only — never the secret. The
            // harness asserts `did=$SMOKE_DAEMON_ID` (real-E2E M1), so carry it.
            let daemonId = (try? store.loadPending(pairingId: pairingId))?.daemonId ?? ""
            log.notice(
                "\(pairPendingMarker, privacy: .public) did=\(daemonId, privacy: .public) pairingId=\(pairingId, privacy: .public)"
            )
            return .pending(pairingId: pairingId)
        } catch {
            let reason = "\(error)"
            log.error("\(pairFailMarker, privacy: .public) detail=\(reason, privacy: .public)")
            return .failed(reason: reason)
        }
    }
}
