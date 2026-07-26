// Scoped to the two platforms that actually form a phone↔watch pair.
//
// `#if canImport(WatchConnectivity)` is NOT enough: visionOS ships the framework
// (so `canImport` succeeds) but declares a different required `WCSessionDelegate`
// member set, which fails to compile as `type 'PairingSyncBridge' does not conform
// to protocol 'WCSessionDelegate'`. Since visionOS has no companion watch, the
// honest predicate is the platform pair itself. macOS lacks the framework outright.
#if os(iOS) || os(watchOS)

    import Foundation
    import WatchConnectivity
    import os

    /// Mirrors the iPhone's committed pairings to its companion watch.
    ///
    /// **Why this exists at all.** iCloud Keychain does not deliver third-party
    /// synchronizable items to watchOS. Sharing the keychain-access-group between
    /// the two apps (#944) was a necessary precondition but not a transport: on real
    /// hardware an Apple Watch Ultra 1 with that entitlement in place still showed
    /// zero pairings. WatchConnectivity is the only channel Apple offers between a
    /// phone app and its companion, so the phone hands the set over directly.
    ///
    /// **One-way, phone-authoritative.** The watch never publishes. It has no
    /// pairing UI to originate a change from, and — more importantly — a two-way
    /// channel would need a conflict rule that coexists with the store's
    /// latest-`ts`-wins reconciliation. One-way removes that whole class of problem.
    ///
    /// **`updateApplicationContext`, not `transferUserInfo`/`sendMessage`.** The
    /// payload is a full snapshot of current state, which is exactly what a single
    /// coalesced latest-wins slot models. It needs no reachability (the watch picks
    /// the context up whenever it next runs), it cannot back up into a queue, and a
    /// missed intermediate update is harmless because only the newest set matters.
    ///
    /// `@unchecked Sendable`: `WCSession` is thread-safe, and the two closure
    /// properties are assigned exactly once during app init before `activate()`.
    final class PairingSyncBridge: NSObject, @unchecked Sendable {
        static let shared = PairingSyncBridge()

        private let log = Logger(subsystem: "dev.tpmt.app", category: "pairing-sync")
        private let store: PairingStore
        /// Serializes snapshot application so two deliveries can never interleave
        /// inside `applyPeerSnapshot`'s read-modify-write of the pointer map.
        private let queue = DispatchQueue(label: "dev.tpmt.app.pairing-sync")

        /// The key under which the encoded `PairingSnapshot` travels.
        ///
        /// Load-bearing for the never-received vs. deliberately-empty distinction:
        /// `WCSession.receivedApplicationContext` is `[:]` both when the phone has
        /// never sent and when it sent an empty set. Only the presence of THIS key
        /// tells them apart, and only the receiver holding the raw dictionary can
        /// check it — which is why `applyPeerSnapshot` is never called at all for a
        /// context lacking it, rather than being called with an empty snapshot.
        private static let contextKey = "pairings.v1"

        /// Called on the main actor after a snapshot is applied, with the pending
        /// pairingIds whose relay clients the caller must dispose. watchOS only.
        var onSnapshotApplied: (@MainActor ([String]) -> Void)?

        private init(store: PairingStore = .shared) {
            self.store = store
            super.init()
        }

        // MARK: - Lifecycle

        /// Activate the session, unless this is a smoke launch.
        ///
        /// The smoke harness owns pairing state end-to-end (it wipes committed
        /// records at launch and injects its own via `--tp-smoke-url`); a live WC
        /// session would race both. Guarding at activation means the smoke run never
        /// even has a delegate attached — `applyPeerSnapshot` guards again on its own
        /// so the outcome does not depend on which of the two runs first.
        func activate() {
            guard !RelayClient.isSmokeMode else {
                log.info("skipping WCSession activation (smoke mode)")
                return
            }
            guard WCSession.isSupported() else {
                log.info("WCSession unsupported on this device")
                return
            }
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }

        // MARK: - Phone side

        #if os(iOS)
            /// Publish the current committed set. Safe to call redundantly — the
            /// context is a single slot, so a repeat is at worst a no-op write.
            func publish() {
                guard !RelayClient.isSmokeMode, WCSession.isSupported() else { return }
                let session = WCSession.default
                guard session.activationState == .activated else { return }
                // No watch paired, or the companion app not installed on it: there is
                // nothing to mirror to. `updateApplicationContext` would fail with
                // `WCErrorCodeDeviceNotPaired` anyway; skipping keeps us from
                // enumerating the Keychain on every pairing change for nothing.
                guard session.isPaired, session.isWatchAppInstalled else { return }
                // `committedSnapshot()` returns nil when the Keychain cannot be
                // enumerated. Publishing an empty set in that window would tell the
                // watch every pairing had been revoked, so we simply do not publish;
                // the next mutation (or the next activation) republishes.
                guard let snapshot = store.committedSnapshot() else {
                    log.error("skipping publish — committed set unavailable")
                    return
                }
                do {
                    let data = try JSONEncoder().encode(snapshot)
                    try session.updateApplicationContext([Self.contextKey: data])
                    // Count only — the payload carries pairing secrets (see
                    // `PairingSnapshot`) and must never be logged.
                    log.info("published \(snapshot.pairings.count, privacy: .public) pairing(s)")
                } catch {
                    log.error("publish failed: \(error, privacy: .public)")
                }
            }
        #endif

        // MARK: - Watch side

        #if os(watchOS)
            /// The snapshot payload inside a received context, or nil if it carries
            /// none.
            ///
            /// A context without `contextKey` means "the phone has never sent" and is
            /// dropped right here — deliberately at the boundary, so the
            /// never-received case can never reach `applyPeerSnapshot` as an empty
            /// set (which would read as "every pairing was revoked").
            ///
            /// Extracting here also keeps the non-`Sendable` `[String: Any]` from
            /// crossing onto `queue` — only the `Data` does. Swift 6.0 (Xcode 26, the
            /// CI runner) rejects that capture outright while 6.4 accepts it, so a
            /// local-only build will not catch a regression here.
            private static func snapshotPayload(in context: [String: Any]) -> Data? {
                context[Self.contextKey] as? Data
            }

            /// Apply a received snapshot. A payload that fails to decode is ignored —
            /// failing safe, because the alternative (treating it as an empty set)
            /// would hide every pairing on the strength of a corrupt message.
            private func ingest(_ data: Data) {
                guard let snapshot = try? JSONDecoder().decode(PairingSnapshot.self, from: data)
                else {
                    log.error("ignoring undecodable pairing snapshot")
                    return
                }
                let result = store.applyPeerSnapshot(snapshot)
                guard case .applied(_, _, _, let sweptPending) = result else {
                    log.info("snapshot not applied: \(String(describing: result), privacy: .public)")
                    return
                }
                // Read the hook on the main actor rather than capturing it here: the
                // closure type is not `@Sendable`, so hoisting it into a local and
                // capturing that is exactly the shape Swift 6.0 rejects. Capturing
                // `self` (`@unchecked Sendable`) and `sweptPending` (`[String]`) is
                // the same idiom `RelayClient` already uses throughout.
                Task { @MainActor [weak self] in self?.onSnapshotApplied?(sweptPending) }
            }
        #endif
    }

    // MARK: - WCSessionDelegate

    extension PairingSyncBridge: WCSessionDelegate {
        func session(
            _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
            error: Error?
        ) {
            if let error {
                log.error("activation failed: \(error.localizedDescription, privacy: .public)")
                return
            }
            log.info("WCSession activated state=\(activationState.rawValue, privacy: .public)")
            #if os(iOS)
                // The watch may have launched first and be waiting; publish the
                // current set as soon as we can talk.
                queue.async { [weak self] in self?.publish() }
            #elseif os(watchOS)
                // A context delivered while this app was not running is waiting in
                // `receivedApplicationContext` — the delegate callback does NOT replay
                // it, so activation must read it explicitly or a watch that launches
                // after the phone published would never see the pairings.
                guard let pending = Self.snapshotPayload(in: session.receivedApplicationContext)
                else { return }
                queue.async { [weak self] in self?.ingest(pending) }
            #endif
        }

        #if os(watchOS)
            func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
                guard let data = Self.snapshotPayload(in: context) else { return }
                queue.async { [weak self] in self?.ingest(data) }
            }
        #endif

        #if os(iOS)
            // Required on iOS so the session can be handed to a different paired
            // watch. Re-activating is the documented handling; there is no
            // per-watch state on this side to tear down.
            func sessionDidBecomeInactive(_ session: WCSession) {}

            func sessionDidDeactivate(_ session: WCSession) {
                session.activate()
            }
        #endif
    }

#endif
