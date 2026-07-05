import Foundation
import Security
import os

/// A completed pairing with one daemon (ADR-0001 Phase 3, M1).
///
/// Produced by decoding a `tp://p?d=…` deep link via the Rust core
/// (`decodePairingData`). Holds everything the relay client needs to act as the
/// *frontend* in the E2EE handshake: the shared pairing secret, the daemon's
/// public key (delivered offline in the QR), the relay URL, the daemon id, and
/// this install's stable `frontendId` (the N:N routing key).
struct Pairing: Equatable {
    /// 32-byte shared pairing secret. Source of `derive_relay_token` /
    /// `derive_kx_key`. SECRET — stored in the Keychain, never logged.
    let pairingSecret: Data
    /// 32-byte daemon X25519 public key (from the pairing bundle, not a kx frame).
    let daemonPublicKey: Data
    /// Relay WebSocket URL the daemon chose (the frontend never configures this).
    let relayURL: String
    /// Daemon id (the `daemon-` prefix is stripped inside the wire format).
    let daemonId: String
    /// Stable per-install identity; identical in `relay.auth` and the kx payload.
    let frontendId: String
    /// Pairing wire version (2, 3, or 4).
    let version: UInt8
    /// Stable pairing identity (UUID string). Present from QR v4; for legacy v2/v3
    /// bundles it is derived device-locally from `daemonId` (`deriveLegacyPairingId`)
    /// so every pairing has one. This — never `daemonId` — is the comparison key for
    /// promote / boot reconciliation / PCT verification (a re-pair reuses the daemon
    /// but mints a new `pairingId`, so keying on `daemonId` would collide).
    let pairingId: String
    /// Daemon hostname for display. Present from QR v4; empty ("") for v2/v3.
    let hostname: String
    /// Monotonic anti-downgrade floor (PR-5, §1.3). The highest WS protocol version
    /// this pairing has ever seen — raised on kx-advertised `v` or a PCT-carrying
    /// hello, never lowered. A QR v4 ingest starts at 3 (a daemon that can emit a v4
    /// QR is v≥3 by definition, so a fresh pairing can never take the legacy branch);
    /// legacy v2/v3 records start at 0 (unknown). `effectiveV` = max(this epoch's
    /// kx-advertised v, this floor) gates the promotion decision so a replayed v=2 kx
    /// can never silently disable PCT verification on a pairing that has seen v≥3.
    let minAdvertisedV: Int
}

/// The result of ingesting a pairing bundle. A successful decode always lands in
/// the **PENDING** namespace (device-local, never synced) — the pairing only
/// becomes COMMITTED once its relay client completes the handshake and promotes
/// (see `PairingViewModel.beginPending` / `promote`). Callers drive a relay
/// connection from `.pending(pairingId:)`.
enum IngestResult: Equatable {
    case pending(pairingId: String)
}

/// Errors surfaced while ingesting or persisting a pairing.
enum PairingError: Error, CustomStringConvertible {
    case decode(String)
    case malformedSecret(field: String, bytes: Int)
    case keychain(OSStatus)
    case notFound

    var description: String {
        switch self {
        case .decode(let d): return "decode: \(d)"
        case .malformedSecret(let field, let bytes):
            return "malformed \(field): \(bytes)B (want 32)"
        case .keychain(let status): return "keychain: OSStatus \(status)"
        case .notFound: return "not found"
        }
    }
}

/// Persists pairings and the stable `frontendId`.
///
/// **COMMITTED pairings (PR-6, design §3.2 "Option A")** live as one
/// per-pairing **synchronizable Keychain blob** keyed by `pairingId`, behind the
/// `PairingRecordStore` seam. That per-item keying is what lets iCloud Keychain
/// merge multi-device adds losslessly (item-granular LWW, no shared conflict
/// unit). Enumerating that service IS the committed index — the Keychain is the
/// source of truth for *which* pairings exist. A device-local **pointer map**
/// (`tp.pairings.ptr`: daemonId→current pairingId, UserDefaults) records this
/// device's current pairingId per daemon so `remove`/`load` resolve the blob
/// without a (throwable) enumeration, and so a locked/empty enumeration never
/// wipes the visible set. A device-local **sidecar** (`Key.meta`, UserDefaults,
/// keyed by daemonId) holds the never-synced fields: the anti-downgrade `floor`
/// (§1.3), `lastConfirmedPct`/`confirmedAt` (§2.5). Labels stay device-local
/// (`PairingRelayOps`), `frontendId` install-wide. PENDING pairings are
/// unchanged: device-local UserDefaults meta + a non-synced Keychain secret.
///
/// `@unchecked Sendable`: `defaults`, `keychainService`, and `records` wrap
/// system/thread-safe APIs; the only mutable in-memory state (`lastGoodPointers`)
/// is guarded by `pointerLock`. `UserDefaults` is not `Sendable` in the stdlib,
/// so `@unchecked` records the author-verified guarantee. Instances are shared
/// across the main actor (SwiftUI) AND `RelayClient`'s off-main receive loop.
final class PairingStore: @unchecked Sendable {
    static let shared = PairingStore()

    /// Backing `UserDefaults` (injectable for tests). `internal` rather than
    /// `private` so the label accessors in `PairingRelayOps.swift` (a cross-file
    /// extension) read/write the SAME store as every other method — otherwise an
    /// injected test suite is silently bypassed and the label path leaks into
    /// `.standard` (the machine-global defaults), which both breaks test
    /// isolation and is inconsistent with how meta/index/frontendId persist.
    let defaults: UserDefaults
    /// Base Keychain service for the legacy committed secret + PENDING secrets.
    private let keychainService: String
    /// Committed-record persistence seam (Option A synced blob). `internal` for
    /// test injection of an in-memory double.
    let records: PairingRecordStore
    private let log = Logger(subsystem: "dev.tpmt.app", category: "pairing")

    /// Last successful enumeration's pointer index. Returned when a later
    /// enumeration throws `.locked` so a transient keychain window can't blank the
    /// pairing list (design §3.6 cond 2). Guarded by `pointerLock`.
    private var lastGoodPointers: Pointers?
    private let pointerLock = NSLock()

    private enum Key {
        static let frontendId = "tp.frontendId"
        static let daemonIndex = "tp.pairings.index"  // legacy [String] of daemon ids
        static func meta(_ did: String) -> String { "tp.pairing.\(did).meta" }  // [String:String]

        /// Device-local pointer map: daemonId → its current committed pairingId.
        /// Ordered membership + order cache for `daemonIds()`; the committed
        /// Keychain blobs are the source of truth, this is the ordering/last-good
        /// overlay (design §3.2 "UserDefaults index 는 캐시로 강등").
        static let pointerMap = "tp.pairings.ptr"
        /// Companion to `pointerMap`: the stable daemonId order (a dict's own key
        /// order is unspecified, so `daemonIds()` reads this array).
        static let pointerOrder = "tp.pairings.ptr.order"
        /// One-shot flag: legacy committed records migrated to Option A blobs.
        static let migratedV2 = "tp.pairings.migrated.v2"

        /// PR-7 local-hide tombstone index: the set of pairingIds hidden on THIS
        /// device via "Remove from this device". Device-local, **never synced** —
        /// a synced tombstone would wrongly hide the pairing on the user's other
        /// devices too (the whole point of local-hide vs Unpair is that it is
        /// install-scoped and non-revoking). Mirrors `pointerMap`: a plural index
        /// array plus a per-pairingId bool flag (`localHidden(_:)`) so
        /// `reconciledPointers` can filter in O(1) via a Set. **Install-scoped**:
        /// UserDefaults is wiped by an app reinstall while the synchronizable blob
        /// survives (iCloud re-adoption), so a reinstall re-surfaces a hidden
        /// pairing — acceptable because local-hide never revoked the credential.
        static let hiddenIndex = "tp.pairings.hidden"
        static func localHidden(_ pid: String) -> String { "tp.pairing.\(pid).localHidden" }

        // PENDING namespace (device-local — never synced; a synced pending record
        // would let an un-scanned device complete kx and pair, §1.3).
        static let pendingIndex = "tp.pairings.pending.index"  // [String] of pairingIds
        static func pendingMeta(_ pid: String) -> String { "tp.pairing.\(pid).pending" }
    }

    /// Keychain account prefix for a PENDING pairing's secret. Namespaced so a
    /// pending secret can never collide with the legacy committed item
    /// (`account: daemonId`) and so pending secrets are stored non-synchronizably.
    private static func pendingAccount(_ pairingId: String) -> String { "pending.\(pairingId)" }

    convenience init(
        defaults: UserDefaults = .standard,
        keychainService: String = "dev.tpmt.app.pairing"
    ) {
        // The committed blob lives under a DEDICATED service (`<base>.v2`) so
        // migration writes never collide with the legacy secret's `<base>` items.
        // macOS decides synchronizability at runtime (a signed build syncs; an
        // ad-hoc smoke build degrades to local-only) — see `PairingSyncProbe`.
        let blobService = keychainService + ".v2"
        let sync = PairingSyncProbe.syncAvailable(service: blobService)
        self.init(
            defaults: defaults, keychainService: keychainService,
            records: KeychainRecordStore(service: blobService, synchronizable: sync))
    }

    /// Designated init — injectable `records` seam for tests.
    init(
        defaults: UserDefaults,
        keychainService: String,
        records: PairingRecordStore
    ) {
        self.defaults = defaults
        self.keychainService = keychainService
        self.records = records
        migrateLegacyCommittedRecords()
    }

    // MARK: frontendId

    /// The stable per-install identity, generated once and persisted.
    ///
    /// MUST stay **device-local** — never sync via iCloud. The daemon scopes a
    /// frontend's E2EE session keys by `frontendId` (`relay-client.ts` keys its
    /// `peers` map on it), so two devices sharing one `frontendId` would silently
    /// clobber each other's session keys (the second device's kx overwrites the
    /// first's, breaking decryption on both). `UserDefaults.standard` is per-device;
    /// do NOT move this to `NSUbiquitousKeyValueStore`. Only the *pairing secret*
    /// (a shared group credential) is synced — see `keychainSet`.
    func frontendId() -> String {
        if let existing = defaults.string(forKey: Key.frontendId), !existing.isEmpty {
            return existing
        }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: Key.frontendId)
        return id
    }

    // MARK: ingestion

    /// Decode a `tp://p?d=…` deep link and persist it to the **PENDING** namespace.
    /// Returns `.pending(pairingId:)`; the caller starts a relay client from it
    /// (`beginPending`). Throws `PairingError` on any failure.
    ///
    /// Idempotent by `pairingId`: re-scanning the same QR overwrites the existing
    /// pending record without duplicating the index (§1.6).
    @discardableResult
    func ingest(deepLink: String) throws -> IngestResult {
        let pairing = try decode(deepLink: deepLink)
        // PR-7: re-scanning a hidden daemon's QR is a deliberate re-pair — un-hide it
        // on this device immediately (before kx/promote completes) so the user sees
        // the daemon reappear the moment they scan, not only after confirmation.
        // Clears both the incoming pairingId and the legacy-derived id (deterministic
        // → a legacy re-scan re-mints the same id the tombstone names).
        unhideForDaemon(daemonId: pairing.daemonId, pairingId: pairing.pairingId)
        try persistPending(pairing)
        return .pending(pairingId: pairing.pairingId)
    }

    /// Decode a `tp://p?d=…` deep link into a `Pairing` without persisting.
    /// Reads the QR v4 `pairingId`/`hostname` fields when present; for legacy
    /// v2/v3 bundles it derives a stable `pairingId` from `daemonId` (so every
    /// pairing has one identity key) and leaves `hostname` empty.
    func decode(deepLink: String) throws -> Pairing {
        let ffi: FfiPairingData
        do {
            ffi = try decodePairingData(raw: deepLink)
        } catch {
            throw PairingError.decode("\(error)")
        }

        guard let secret = Data(base64Encoded: ffi.ps) else {
            throw PairingError.malformedSecret(field: "ps", bytes: -1)
        }
        guard secret.count == 32 else {
            throw PairingError.malformedSecret(field: "ps", bytes: secret.count)
        }
        guard let daemonPk = Data(base64Encoded: ffi.pk) else {
            throw PairingError.malformedSecret(field: "pk", bytes: -1)
        }
        guard daemonPk.count == 32 else {
            throw PairingError.malformedSecret(field: "pk", bytes: daemonPk.count)
        }

        // QR v4 carries an explicit pairingId; legacy v2/v3 bundles do not, so we
        // derive one device-locally from the daemonId (byte-exact with the daemon's
        // own legacy backfill — same `derive_legacy_pairing_id` FFI).
        let pairingId =
            ffi.pairingId.isEmpty
            ? deriveLegacyPairingId(daemonId: ffi.did)
            : ffi.pairingId

        // Anti-downgrade floor initialization (§1.3): a v4 QR proves the daemon is
        // v≥3, so a fresh v4 pairing starts at floor 3 and can never take the legacy
        // (pct-less) promotion branch. Legacy v2/v3 bundles start at floor 0.
        let floor = ffi.v >= 4 ? 3 : 0

        return Pairing(
            pairingSecret: secret,
            daemonPublicKey: daemonPk,
            relayURL: ffi.relay,
            daemonId: ffi.did,
            frontendId: frontendId(),
            version: ffi.v,
            pairingId: pairingId,
            hostname: ffi.hostname,
            minAdvertisedV: floor)
    }

    // MARK: persistence

    /// Write one COMMITTED pairing as an Option A synced blob (keyed by
    /// `pairingId`), enforce the **≤1 blob per did** invariant by removing any
    /// prior blob for the same daemon under a *different* pairingId (a re-pair
    /// mints a new pairingId — leaving the old one would leak an orphan and make
    /// `load`'s "current" ambiguous, design §3.2/§3.7 item 5), point the map at
    /// the new pairingId, and ensure the device-local sidecar floor exists.
    ///
    /// `pairingId`/`hostname`/`v` ride in the blob so W7 boot reconciliation and
    /// §2.5 PCT re-verification have a stable comparison key. `floor` (PR-5,
    /// anti-downgrade §1.3) is the ONLY committed field kept device-local (in the
    /// sidecar, never synced) — persisted so a promoted pairing keeps its "seen
    /// v≥3" evidence across relaunches. A re-persist from a stale in-memory
    /// `Pairing` must never lower it, so we max against the existing sidecar value.
    private func persist(_ p: Pairing) throws {
        // Durability ordering: SAVE the new blob (and repoint) BEFORE sweeping the
        // old same-did orphans. If `save` throws (transient SecItemAdd failure —
        // device relock, disk pressure, entitlement hiccup), the prior committed
        // blob is still intact, so a re-pair never leaves the daemon with zero
        // committed blobs + a dangling pointer (a permanently-stuck phantom row).
        let blob = PairingBlob(
            ps: p.pairingSecret.base64EncodedString(),
            pk: p.daemonPublicKey.base64EncodedString(),
            relay: p.relayURL, did: p.daemonId, v: p.version,
            pairingId: p.pairingId, hostname: p.hostname,
            ts: Int(Date().timeIntervalSince1970 * 1000))
        try records.save(blob)
        setPointer(daemonId: p.daemonId, pairingId: p.pairingId)
        // PR-7: a deliberate (re)commit UN-HIDES the daemon on this device — a fresh
        // pairing action must never land invisibly behind an old tombstone. Clear the
        // incoming pairingId AND the legacy-derived id: `deriveLegacyPairingId` is
        // deterministic from daemonId, so re-pairing a hidden LEGACY (v2/v3) daemon
        // re-mints the SAME pairingId that the tombstone still names (design §6's
        // "new pairingId on re-pair" holds only for QR v4).
        unhideForDaemon(daemonId: p.daemonId, pairingId: p.pairingId)
        // Now the new blob is durable — drop any committed blob(s) for this daemon
        // under a stale pairingId (a re-pair mints a new pairingId; leaving the old
        // one would leak an orphan and break the ≤1-blob-per-did invariant). Clear
        // each swept pairingId's tombstone too — its blob is gone from this device as
        // part of a deliberate re-pair, so the tombstone can never be needed again
        // (bounds the hidden index to currently-hidden-and-live pairings).
        for old in pairingIds(forDaemon: p.daemonId) where old != p.pairingId {
            records.remove(pairingId: old)
            clearLocalHide(pairingId: old)
        }

        // Sidecar floor (device-local, never synced). Preserve a higher existing
        // floor (a re-persist must never lower it); create the dict if absent.
        var meta = (defaults.dictionary(forKey: Key.meta(p.daemonId)) as? [String: String]) ?? [:]
        let existingFloor = meta["floor"].flatMap { Int($0) } ?? 0
        meta["floor"] = String(max(p.minAdvertisedV, existingFloor))
        defaults.set(meta, forKey: Key.meta(p.daemonId))
    }

    /// All known committed daemon ids, in a stable order (surviving entries keep
    /// their prior order; peer-synced arrivals append). Reconciles the pointer map
    /// against the Keychain (source of truth) first. Non-throwing: on a locked
    /// keychain it returns the last-good order, so a transient window never blanks
    /// the list (design §3.6 cond 2).
    func daemonIds() -> [String] {
        reconciledPointers().order
    }

    /// Load a persisted (COMMITTED) pairing by daemon id, or throw `.notFound`.
    ///
    /// Resolves the daemon's *current* committed `pairingId` via the pointer map,
    /// so a re-pair (new pairingId) or a lingering orphan blob can never surface a
    /// stale record. Merges the device-local sidecar `floor` (legacy/absent → 0).
    func load(daemonId: String) throws -> Pairing {
        let pointers = reconciledPointers()
        guard let pid = pointers[daemonId] else { throw PairingError.notFound }
        let blob: PairingBlob
        do {
            guard let found = try records.loadAll().first(where: { $0.pairingId == pid })
            else { throw PairingError.notFound }
            blob = found
        } catch let e as RecordStoreError {
            throw PairingError.keychain(e.status)
        }
        guard let daemonPk = Data(base64Encoded: blob.pk),
            let secret = Data(base64Encoded: blob.ps)
        else { throw PairingError.notFound }
        let floor =
            (defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String])?["floor"]
            .flatMap { Int($0) } ?? 0
        return Pairing(
            pairingSecret: secret, daemonPublicKey: daemonPk,
            relayURL: blob.relay, daemonId: blob.did, frontendId: frontendId(), version: blob.v,
            pairingId: blob.pairingId, hostname: blob.hostname, minAdvertisedV: floor)
    }

    /// Remove EVERY committed pairing (blobs + legacy secrets + sidecars + pointer
    /// index). **Smoke-harness isolation only** (native-testing.md §ship-gate note):
    /// PR-6 moved the committed index from UserDefaults (which `simctl uninstall`
    /// clears) into the synchronizable Keychain, which survives an uninstall *by
    /// design* — that is the whole point of iCloud sync. But the iOS smoke re-ingests
    /// a *fresh* pairing for the same daemon each run; a surviving committed blob then
    /// boot-reconnects a second `RelayClient` under the same `frontendId`, clobbering
    /// the daemon's per-frontend session keys and failing frame decrypt (`aead
    /// authentication failed`). The macOS harness clears its Keychain from the host
    /// (`security delete-generic-password`), but nothing on the host can reach the
    /// Simulator's Keychain — so the app wipes committed state itself when launched in
    /// smoke mode. **Never called in a normal (non-`--tp-smoke*`) launch.**
    func wipeAllCommittedForSmoke() {
        for did in daemonIds() { remove(daemonId: did) }
        // Belt-and-suspenders: drop any blob whose did the pointer map missed
        // (e.g. a peer-synced arrival not yet reconciled into the map).
        if let blobs = try? records.loadAll() {
            for b in blobs { records.remove(pairingId: b.pairingId) }
        }
        writePointers(Pointers(order: [], map: [:]))
        // PR-7: clear every local-hide tombstone too. The golden smoke link is wire
        // v3, so its committed pairingId is deriveLegacyPairingId(SMOKE_DAEMON_ID) —
        // the SAME id every run. A surviving tombstone would filter the fresh ingest's
        // pairingId out of daemonIds() and suppress TP_PAIR_OK (M1) on the 2nd run.
        clearAllTombstonesForSmoke()
    }

    // MARK: pointer map + Keychain reconciliation (design §3.2)

    /// The device-local daemonId→pairingId pointer index, order-preserving.
    /// `order` is the stable daemonId sequence for `daemonIds()` (SwiftUI rows);
    /// `map` resolves a daemonId to its current committed pairingId. Persisted as
    /// two UserDefaults keys (a dict, whose own key order is unstable, plus an
    /// explicit order array).
    private struct Pointers: Equatable {
        var order: [String]
        var map: [String: String]
        var isEmpty: Bool { order.isEmpty }
        subscript(_ did: String) -> String? { map[did] }
    }

    private func pointers() -> Pointers {
        let map = (defaults.dictionary(forKey: Key.pointerMap) as? [String: String]) ?? [:]
        // Order = persisted order filtered to present keys, then any map keys not
        // yet in the order (defensive — e.g. an older on-disk shape).
        var order = (defaults.stringArray(forKey: Key.pointerOrder) ?? []).filter { map[$0] != nil }
        for did in map.keys where !order.contains(did) { order.append(did) }
        return Pointers(order: order, map: map)
    }

    private func writePointers(_ p: Pointers) {
        defaults.set(p.map, forKey: Key.pointerMap)
        defaults.set(p.order, forKey: Key.pointerOrder)
        pointerLock.lock()
        lastGoodPointers = p
        pointerLock.unlock()
    }

    private func setPointer(daemonId: String, pairingId: String) {
        var p = pointers()
        if p.map[daemonId] == nil { p.order.append(daemonId) }
        p.map[daemonId] = pairingId
        writePointers(p)
    }

    private func dropPointer(daemonId: String) {
        var p = pointers()
        p.map.removeValue(forKey: daemonId)
        p.order.removeAll { $0 == daemonId }
        writePointers(p)
    }

    /// The committed pairingIds currently in the Keychain for a daemon (usually
    /// ≤1 — used to sweep stale re-pair orphans). Best-effort: an enumeration
    /// error yields the pointer-map entry (if any) so `persist` still cleans up.
    private func pairingIds(forDaemon did: String) -> [String] {
        if let blobs = try? records.loadAll() {
            let fromKeychain = blobs.filter { $0.did == did }.map { $0.pairingId }
            if !fromKeychain.isEmpty { return fromKeychain }
        }
        return pointers()[did].map { [$0] } ?? []
    }

    /// Reconcile the pointer index against the committed Keychain blobs and return
    /// it. Design §3.6 cond 2 + the cache-preservation rule generalized per-did:
    /// a Keychain enumeration can be **partial** mid-sync (iCloud propagates a blob's
    /// delete and its replacement add as two unordered writes), so an enumeration
    /// that omits a did we already point at is NOT proof the daemon was unpaired.
    ///
    /// - enumeration throws `.locked` → return the last-good index, don't mutate.
    /// - enumeration empty AND index non-empty → UNCORROBORATED empty: keep it (a
    ///   single cold-launch empty must never nuke a populated index).
    /// - enumeration non-empty → REPOINT each present did to its latest-`ts` blob,
    ///   APPEND peer-synced arrivals, and **PRESERVE (do not prune)** the pointer for
    ///   any did with no blob this pass (transient partial-sync absence — else a
    ///   re-paired peer's daemon vanishes from the UI until its new blob syncs). A
    ///   genuinely-unpaired daemon is dropped only by explicit `remove(daemonId:)`
    ///   (revocation) or the PR-7 local-hide tombstone — never inferred from absence.
    ///   Losing same-did blobs (concurrent re-pair) are swept to hold ≤1-per-did.
    ///
    /// PR-7: a locally-hidden pairingId's blob is dropped from the working set at
    /// the **very top**, before the loser sweep and before building currentByDid.
    /// This is load-bearing: if it were filtered only at the final-pointer level, a
    /// resurrected hidden P1 (a peer still holds the blob after this device re-paired
    /// to P2) could win the per-did latest-`ts` race against the live P2 and push P2
    /// into `losers` → `records.remove(pairingId: P2)` — a synced delete that revokes
    /// a good re-pair mesh-wide. Dropping hidden blobs first means P1 can never enter
    /// currentByDid nor the loser set: the retained-but-hidden blob keeps syncing
    /// (correct device-local hide), and a live re-pair is never destroyed.
    private func reconciledPointers() -> Pointers {
        let allBlobs: [PairingBlob]
        do {
            allBlobs = try records.loadAll()
        } catch {
            pointerLock.lock()
            let lastGood = lastGoodPointers
            pointerLock.unlock()
            return lastGood ?? pointers()
        }
        // PR-7: filter hidden pairingIds up front so they are never repointed,
        // appended as arrivals, NOR swept as ts-losers. A hidden blob is left on
        // disk (still synced) — only its surfacing here is suppressed.
        let hidden = hiddenPairingIds()
        let blobs = hidden.isEmpty ? allBlobs : allBlobs.filter { !hidden.contains($0.pairingId) }
        let current = pointers()
        if blobs.isEmpty {
            if current.isEmpty { return current }
            // Uncorroborated empty — keep the existing index (do not prune to empty).
            pointerLock.lock()
            lastGoodPointers = current
            pointerLock.unlock()
            return current
        }
        // Latest-ts-wins per did, tracking the losers so we can sweep them: two blobs
        // for one did means a concurrent re-pair (each device minted its own
        // pairingId). Keep the newest, delete the rest to restore ≤1-per-did.
        var currentByDid: [String: PairingBlob] = [:]
        var losers: [String] = []
        for b in blobs {
            if let existing = currentByDid[b.did] {
                if existing.ts >= b.ts {
                    losers.append(b.pairingId)  // b is older/tied → orphan
                    continue
                }
                losers.append(existing.pairingId)  // existing is older → orphan
            }
            currentByDid[b.did] = b
        }
        // Sweep losing blobs; clear any tombstone for a swept pairingId (its blob is
        // gone locally, so the tombstone is dead weight — PR-7 index-bounding).
        for pid in losers {
            records.remove(pairingId: pid)
            clearLocalHide(pairingId: pid)
        }

        var order: [String] = []
        var map: [String: String] = [:]
        for did in current.order {  // survivors + transiently-absent both keep order
            // Present this pass → repoint to the latest blob; absent → PRESERVE the
            // existing pointer (partial-sync window, not an unpair).
            let resolved = currentByDid[did]?.pairingId ?? current.map[did]
            // PR-7 defense-in-depth: `hideLocally` drops the pointer, so a hidden did
            // normally isn't in `current.order`. But if a stale pointer still resolves
            // to a hidden pairingId (write-ordering race, or a future path that
            // tombstones without dropping the pointer), do NOT re-emit it — else the
            // preserve-on-absence fallback would resurface a hidden daemon.
            if let resolved, hidden.contains(resolved) { continue }
            order.append(did)
            map[did] = resolved
        }
        for did in currentByDid.keys.sorted() where map[did] == nil {  // arrivals (stable order)
            order.append(did)
            map[did] = currentByDid[did]?.pairingId
        }
        let reconciled = Pointers(order: order, map: map)
        writePointers(reconciled)
        return reconciled
    }

    // MARK: PR-7 local-hide tombstone ("Remove from this device")

    /// The set of pairingIds hidden on THIS device (device-local, never synced).
    /// Read once per `reconciledPointers` pass so filtering is O(1) per blob.
    func hiddenPairingIds() -> Set<String> {
        Set(defaults.stringArray(forKey: Key.hiddenIndex) ?? [])
    }

    /// Whether a specific pairingId is locally hidden.
    func isLocallyHidden(pairingId: String) -> Bool {
        defaults.bool(forKey: Key.localHidden(pairingId))
    }

    /// Mark a pairingId hidden on this device (idempotent): set the per-pairing
    /// flag and append to the index. Does NOT touch the synced blob, the legacy
    /// secret, the sidecar, or the label — those must survive so a re-pair/unhide
    /// reads consistent state (and so `remove`/unpair remains the only revocation).
    private func setLocalHidden(pairingId: String) {
        defaults.set(true, forKey: Key.localHidden(pairingId))
        var index = defaults.stringArray(forKey: Key.hiddenIndex) ?? []
        if !index.contains(pairingId) {
            index.append(pairingId)
            defaults.set(index, forKey: Key.hiddenIndex)
        }
    }

    /// Clear a pairingId's tombstone (flag + index entry). The ONLY legitimate
    /// clear-triggers are (i) a deliberate (re)commit of that pairingId (`persist`
    /// / `ingest`) — a fresh pairing action un-hides the daemon on this device —
    /// and (ii) a hard delete of that pairingId's blob (`remove`/unpair, or a
    /// re-pair/loser sweep that deletes an old blob). **Never** cleared by
    /// enumeration-absence: a hidden blob keeps syncing from a peer, and its
    /// transient absence during partial iCloud sync must not be read as "safe to
    /// GC the tombstone" (that would resurface the daemon).
    private func clearLocalHide(pairingId: String) {
        guard !pairingId.isEmpty else { return }
        defaults.removeObject(forKey: Key.localHidden(pairingId))
        let index = defaults.stringArray(forKey: Key.hiddenIndex) ?? []
        if index.contains(pairingId) {
            defaults.set(index.filter { $0 != pairingId }, forKey: Key.hiddenIndex)
        }
    }

    /// Hide (LOCAL, non-revoking) a committed pairing on THIS device only.
    ///
    /// Unlike `remove(daemonId:)` (Unpair = revocation): does NOT delete the synced
    /// Option A blob, does NOT delete the legacy secret, does NOT send
    /// `control.unpair`, and does NOT touch the device-local sidecar/label. It only
    /// (a) tombstones the daemon's current pairingId so `reconciledPointers` filters
    /// it out of `daemonIds()` on this device, and (b) drops the pointer entry. The
    /// synced blob keeps syncing to (and from) the user's other devices — the
    /// pairing stays valid everywhere; it is merely hidden here (design v2 §E.2).
    ///
    /// The sidecar (`Key.meta`, anti-downgrade floor + PCT) is deliberately kept: the
    /// blob survives, so its device-local floor evidence must stay consistent with it
    /// (a reset-to-0 floor would open a PR-5 §1.3 downgrade window if the daemon is
    /// ever re-paired/unhidden on this device). Non-throwing.
    /// Returns the PENDING pairingIds swept so the caller (`PairingViewModel`) can
    /// dispose their live relay clients — mirrors `gcPending`'s contract.
    @discardableResult
    func hideLocally(daemonId: String) -> [String] {
        // Resolve the daemon's current committed pairingId(s) and tombstone them.
        // Usually one; a partial-sync window could momentarily show two — hide all
        // so none can surface.
        for pid in pairingIds(forDaemon: daemonId) {
            setLocalHidden(pairingId: pid)
        }
        dropPointer(daemonId: daemonId)
        // Sweep any PENDING pairing for this daemon: an in-flight pending kx could
        // otherwise promote() → persist() and resurface the daemon right after we
        // hid it. Dropping the pending record (and returning its id so the VM
        // disposes the client) closes that race. A subsequent deliberate re-scan
        // re-ingests a fresh pending and un-hides via `ingest` (design §E.2).
        var sweptPending: [String] = []
        for pid in pendingIds() {
            let meta = defaults.dictionary(forKey: Key.pendingMeta(pid)) as? [String: String]
            if meta?["did"] == daemonId {
                removePending(pairingId: pid)
                sweptPending.append(pid)
            }
        }
        return sweptPending
    }

    /// Clear tombstones for a daemon that is being deliberately (re)paired or
    /// unpaired, so a hide never outlives the next intentional pairing action.
    /// Clears BOTH the incoming/resolved pairingId AND the legacy-derived id
    /// (`deriveLegacyPairingId(daemonId)`): because that derivation is deterministic
    /// from daemonId, re-pairing a hidden LEGACY (v2/v3) daemon re-mints the SAME
    /// pairingId, which would otherwise stay filtered — design §6's "re-pair mints a
    /// new pairingId" premise holds only for QR v4.
    private func unhideForDaemon(daemonId: String, pairingId: String) {
        clearLocalHide(pairingId: pairingId)
        clearLocalHide(pairingId: deriveLegacyPairingId(daemonId: daemonId))
    }

    /// Clear ALL local-hide tombstone state — smoke-harness isolation only.
    /// The golden smoke deep link is wire v3 (no explicit pairingId), so its
    /// committed pairingId is `deriveLegacyPairingId(SMOKE_DAEMON_ID)` — the SAME
    /// value every run. A tombstone surviving from a prior run (the host cannot
    /// reach the Simulator's UserDefaults on iOS) would filter the fresh ingest's
    /// pairingId and suppress `TP_PAIR_OK` (M1). Called only from
    /// `wipeAllCommittedForSmoke`. **Never in a normal launch.**
    private func clearAllTombstonesForSmoke() {
        for pid in defaults.stringArray(forKey: Key.hiddenIndex) ?? [] {
            defaults.removeObject(forKey: Key.localHidden(pid))
        }
        defaults.removeObject(forKey: Key.hiddenIndex)
    }

    /// Migrate legacy split-storage committed records (Keychain secret keyed by
    /// daemonId + UserDefaults meta) to Option A blobs. Runs once (done-flagged);
    /// post-PR-6 every committed write goes to the `.v2` service, so no legacy
    /// write can occur after this. **Never deletes the legacy secret** — a synced
    /// delete would propagate via iCloud and silently unpair older-app peers still
    /// reading it (design §3.6 cond 3). Idempotent (delete-then-add blob write).
    private func migrateLegacyCommittedRecords() {
        guard !defaults.bool(forKey: Key.migratedV2) else { return }
        defer { defaults.set(true, forKey: Key.migratedV2) }
        let legacyDids = defaults.stringArray(forKey: Key.daemonIndex) ?? []
        for did in legacyDids {
            guard let meta = defaults.dictionary(forKey: Key.meta(did)) as? [String: String],
                let pkB64 = meta["pk"], let relay = meta["relay"],
                let vStr = meta["v"], let v = UInt8(vStr)
            else { continue }
            guard let secret = try? keychainGet(account: did) else { continue }
            let pid =
                meta["pairingId"].flatMap { $0.isEmpty ? nil : $0 }
                ?? deriveLegacyPairingId(daemonId: did)
            let blob = PairingBlob(
                ps: secret.base64EncodedString(), pk: pkB64, relay: relay,
                did: did, v: v, pairingId: pid, hostname: meta["hostname"] ?? "",
                ts: Int(Date().timeIntervalSince1970 * 1000))
            do {
                try records.save(blob)
                setPointer(daemonId: did, pairingId: pid)
            } catch {
                log.error("legacy migration failed for did=\(did, privacy: .public): \(error)")
            }
            // NB: legacy secret + meta are intentionally NOT deleted (peers + sidecar).
        }
    }

    // MARK: PENDING namespace (§1.4 — connect-on-pending lifecycle)

    /// Persist a decoded pairing to the PENDING namespace. Idempotent by
    /// `pairingId`: overwrites the meta/secret and appends to the index only once.
    private func persistPending(_ p: Pairing) throws {
        try keychainSetPending(p.pairingSecret, pairingId: p.pairingId)
        let meta: [String: String] = [
            "pk": p.daemonPublicKey.base64EncodedString(),
            "relay": p.relayURL,
            "did": p.daemonId,
            "v": String(p.version),
            "pairingId": p.pairingId,
            "hostname": p.hostname,
            "floor": String(p.minAdvertisedV),
            // Milliseconds since 1970 as a string — the age cutoff for gcPending.
            "createdAt": String(Int(Date().timeIntervalSince1970 * 1000)),
        ]
        defaults.set(meta, forKey: Key.pendingMeta(p.pairingId))
        var index = pendingIds()
        if !index.contains(p.pairingId) {
            index.append(p.pairingId)
            defaults.set(index, forKey: Key.pendingIndex)
        }
    }

    /// All pending pairingIds, in insertion order.
    func pendingIds() -> [String] {
        defaults.stringArray(forKey: Key.pendingIndex) ?? []
    }

    /// Load a PENDING pairing by pairingId, or throw `.notFound`.
    func loadPending(pairingId: String) throws -> Pairing {
        guard
            let meta = defaults.dictionary(forKey: Key.pendingMeta(pairingId)) as? [String: String],
            let pkB64 = meta["pk"], let daemonPk = Data(base64Encoded: pkB64),
            let relay = meta["relay"], let did = meta["did"],
            let vStr = meta["v"], let v = UInt8(vStr)
        else { throw PairingError.notFound }
        let secret = try keychainGet(account: Self.pendingAccount(pairingId))
        let floor = meta["floor"].flatMap { Int($0) } ?? 0
        return Pairing(
            pairingSecret: secret, daemonPublicKey: daemonPk,
            relayURL: relay, daemonId: did, frontendId: frontendId(), version: v,
            pairingId: meta["pairingId"] ?? pairingId, hostname: meta["hostname"] ?? "",
            minAdvertisedV: floor)
    }

    /// Promote a PENDING pairing to COMMITTED (write the Option A blob + drop the
    /// pending one). `persist` sweeps any prior committed blob for the same daemon
    /// under a stale pairingId, so a re-pair leaves exactly one blob per daemon
    /// (design §3.2 ≤1-per-did invariant). **Idempotent** (§1.4/§1.6 W10): a
    /// re-entrant call after the pending record is already gone is a silent no-op —
    /// it must never throw and never resurrect a committed row it cannot build.
    func promote(pairingId: String) throws {
        let pairing: Pairing
        do {
            pairing = try loadPending(pairingId: pairingId)
        } catch PairingError.notFound {
            return  // already promoted / GC'd — idempotent no-op.
        }
        try persist(pairing)
        removePending(pairingId: pairingId)
    }

    /// Remove a PENDING pairing (secret + meta + index entry). Idempotent.
    func removePending(pairingId: String) {
        keychainDelete(account: Self.pendingAccount(pairingId))
        defaults.removeObject(forKey: Key.pendingMeta(pairingId))
        defaults.set(pendingIds().filter { $0 != pairingId }, forKey: Key.pendingIndex)
    }

    /// Sweep PENDING records older than `maxAge`. Returns the swept pairingIds so
    /// the caller can dispose their live relay clients (§1.6 — no record-less
    /// zombie). Records without a parseable `createdAt` are treated as expired.
    @discardableResult
    func gcPending(olderThan maxAge: TimeInterval) -> [String] {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let cutoffMs = nowMs - maxAge * 1000
        var swept: [String] = []
        for pid in pendingIds() {
            let meta = defaults.dictionary(forKey: Key.pendingMeta(pid)) as? [String: String]
            let createdMs = meta?["createdAt"].flatMap { Double($0) }
            if let createdMs, createdMs >= cutoffMs { continue }
            removePending(pairingId: pid)
            swept.append(pid)
        }
        return swept
    }

    // MARK: PCT verification state (PR-5 — §1.3 floor + §2.5 committed re-verify)

    /// Raise the anti-downgrade floor for a PENDING pairing (§1.3 — monotonic).
    /// A no-op if the observed version is not higher than the persisted floor.
    /// Called from CONFIRMING when a higher `DaemonKxPayload.v` or a PCT-carrying
    /// hello is observed, so a promote carries the raised floor into committed meta.
    func raisePendingFloor(pairingId: String, observedV: Int) {
        guard
            var meta = defaults.dictionary(forKey: Key.pendingMeta(pairingId)) as? [String: String]
        else { return }
        let current = meta["floor"].flatMap { Int($0) } ?? 0
        guard observedV > current else { return }
        meta["floor"] = String(observedV)
        defaults.set(meta, forKey: Key.pendingMeta(pairingId))
    }

    /// Raise the anti-downgrade floor for a COMMITTED pairing (§1.3 — monotonic).
    /// A no-op if the observed version is not higher than the persisted floor.
    /// Called during committed re-verification (§2.5) so a pairing that has ever
    /// seen v≥3 can never be tricked back into the legacy branch by a replayed kx.
    func raiseCommittedFloor(daemonId: String, observedV: Int) {
        guard var meta = defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String]
        else { return }
        let current = meta["floor"].flatMap { Int($0) } ?? 0
        guard observedV > current else { return }
        meta["floor"] = String(observedV)
        defaults.set(meta, forKey: Key.meta(daemonId))
    }

    /// Record the latest confirmed PCT for a COMMITTED pairing (§2.5). Stored in
    /// the **device-local** committed meta (UserDefaults, never synced) — the PCT is
    /// bound to this device's ephemeral kx keypair, so it is meaningless on any
    /// other device and MUST NOT sync (it would create false mismatches, §2.5). Its
    /// role is diagnostic (last mutual-confirmation time) and epoch-to-epoch change
    /// observation; the live check always re-derives PCT_app from the fresh kx epoch
    /// rather than replaying this stored value.
    func recordConfirmedPct(daemonId: String, pctB64: String) {
        guard var meta = defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String]
        else { return }
        meta["lastConfirmedPct"] = pctB64
        meta["confirmedAt"] = String(Int(Date().timeIntervalSince1970 * 1000))
        defaults.set(meta, forKey: Key.meta(daemonId))
    }

    /// The last confirmed PCT (base64) recorded for a COMMITTED pairing, or nil.
    /// Diagnostic only — see `recordConfirmedPct`.
    func lastConfirmedPct(daemonId: String) -> String? {
        (defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String])?["lastConfirmedPct"]
    }

    /// Read the persisted anti-downgrade floor for a pairing (§1.3). Reads the
    /// PENDING meta (by pairingId) or the COMMITTED meta (by daemonId) per `pending`.
    /// Returns 0 (unknown) when the record or `floor` key is absent — so a legacy
    /// row that predates this schema contributes no floor.
    func floor(pairingId: String, daemonId: String, pending: Bool) -> Int {
        let dict =
            pending
            ? defaults.dictionary(forKey: Key.pendingMeta(pairingId)) as? [String: String]
            : defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String]
        return dict?["floor"].flatMap { Int($0) } ?? 0
    }

    /// Remove (UNPAIR) a committed pairing everywhere it lives. Non-throwing.
    ///
    /// Deletes the Option A blob (all blobs for this daemon, sweeping any re-pair
    /// orphan), the device-local sidecar + label + pointer entry, AND — unlike
    /// migration — the **legacy synced secret** (base service, account=daemonId).
    /// Unpair is a *revocation*: it must propagate via iCloud so the pairing
    /// disappears on the user's other devices too (design §3.7 item 4), matching
    /// pre-PR-6 behavior. (Migration keeps the legacy secret; unpair removes it —
    /// two deliberately distinct lifetimes for the same item, design §3.6 cond 3.)
    func remove(daemonId: String) {
        for pid in pairingIds(forDaemon: daemonId) {
            records.remove(pairingId: pid)
            clearLocalHide(pairingId: pid)  // PR-7: blob revoked → tombstone is dead weight
        }
        // PR-7: also clear the legacy-derived id so a hidden-then-unpaired legacy
        // daemon leaves no immortal tombstone (its pairingId is deterministic).
        clearLocalHide(pairingId: deriveLegacyPairingId(daemonId: daemonId))
        keychainDelete(account: daemonId)  // legacy synced secret — revoke everywhere
        defaults.removeObject(forKey: Key.meta(daemonId))
        defaults.removeObject(forKey: "tp.pairing.\(daemonId).label")
        dropPointer(daemonId: daemonId)
    }

    // MARK: Keychain (generic password, keyed by account)
    //
    // COMMITTED pairing secrets now live in Option A blobs (`PairingRecordStore`);
    // these helpers back only the PENDING secret (`keychainSetPending`), the legacy
    // committed secret READ during migration (`keychainGet`), and its deletion on
    // unpair (`keychainDelete`).

    /// Persist a PENDING pairing secret. **Never synced on any platform** (§1.3):
    /// a pending record is a device-local, pre-confirmation credential — syncing it
    /// would let a device that never scanned the QR complete kx and pair.
    private func keychainSetPending(_ data: Data, pairingId: String) throws {
        try keychainWrite(data, account: Self.pendingAccount(pairingId), synchronizable: false)
    }

    private func keychainWrite(_ data: Data, account: String, synchronizable: Bool) throws {
        let syncValue: CFBoolean = synchronizable ? kCFBooleanTrue! : kCFBooleanFalse!
        // Delete any prior item for this account (either sync variant) so the
        // overwrite is idempotent even if a previous write used the other value.
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: keychainService,
                kSecAttrAccount as String: account,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ] as CFDictionary)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: syncValue,
            kSecValueData as String: data,
            // Synchronizable items must use a sync-compatible accessibility class;
            // AfterFirstUnlock is the recommended one for background-reachable secrets.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
    }

    private func keychainGet(account: String) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            // Match both synced and (legacy) local items written before sync.
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
        guard let data = out as? Data else { throw PairingError.notFound }
        return data
    }

    private func keychainDelete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
            // Delete both synced and local variants.
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
