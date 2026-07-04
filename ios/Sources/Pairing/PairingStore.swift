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
/// Secret material (the 32-byte pairing secret) lives in the Keychain, keyed by
/// daemon id. Non-secret fields and the install's `frontendId` live in
/// `UserDefaults`. The index of known daemon ids is kept in `UserDefaults` so we
/// can enumerate pairings without scanning the Keychain.
///
/// `@unchecked Sendable`: every stored property is a `let` (no mutable in-memory
/// state), and the two non-`Sendable`-typed ones — `defaults: UserDefaults` and
/// the Keychain accessed via `keychainService: String` — wrap system APIs that
/// Apple documents as thread-safe. `UserDefaults` is not annotated `Sendable` by
/// the stdlib, so the compiler can't prove this; `@unchecked` records the
/// author-verified guarantee. Instances are therefore shared safely across
/// isolation domains — the main actor (SwiftUI views) AND `RelayClient`'s
/// off-main URLSession receive loop (`RelayClient.swift` `onKeyExchangeFrame`).
final class PairingStore: @unchecked Sendable {
    static let shared = PairingStore()

    /// Backing `UserDefaults` (injectable for tests). `internal` rather than
    /// `private` so the label accessors in `PairingRelayOps.swift` (a cross-file
    /// extension) read/write the SAME store as every other method — otherwise an
    /// injected test suite is silently bypassed and the label path leaks into
    /// `.standard` (the machine-global defaults), which both breaks test
    /// isolation and is inconsistent with how meta/index/frontendId persist.
    let defaults: UserDefaults
    private let keychainService: String
    private let log = Logger(subsystem: "dev.tpmt.app", category: "pairing")

    private enum Key {
        static let frontendId = "tp.frontendId"
        static let daemonIndex = "tp.pairings.index"  // [String] of daemon ids (COMMITTED)
        static func meta(_ did: String) -> String { "tp.pairing.\(did).meta" }  // [String:String]

        // PENDING namespace (device-local — never synced; a synced pending record
        // would let an un-scanned device complete kx and pair, §1.3).
        static let pendingIndex = "tp.pairings.pending.index"  // [String] of pairingIds
        static func pendingMeta(_ pid: String) -> String { "tp.pairing.\(pid).pending" }
    }

    /// Keychain account prefix for a PENDING pairing's secret. Namespaced so a
    /// pending secret can never collide with the committed item (`account: daemonId`)
    /// and so pending secrets are stored non-synchronizably (see `keychainSet`).
    private static func pendingAccount(_ pairingId: String) -> String { "pending.\(pairingId)" }

    init(
        defaults: UserDefaults = .standard,
        keychainService: String = "dev.tpmt.app.pairing"
    ) {
        self.defaults = defaults
        self.keychainService = keychainService
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

    private func persist(_ p: Pairing) throws {
        try keychainSet(p.pairingSecret, account: p.daemonId)
        // `pairingId`/`hostname` (from QR v4) are persisted so W7 boot
        // reconciliation and §2.5 PCT re-verification have a stable comparison key
        // (round-3 condition 5). Legacy records written before this schema lack the
        // keys; `load` derives them on read (see below). `minAdvertisedV` (PR-5) is
        // the anti-downgrade floor — persisted so a promoted pairing keeps its
        // "seen v≥3" evidence across relaunches. A promote from PENDING carries the
        // pending floor forward via the loaded `Pairing`; `raiseFloor` bumps it
        // afterwards on any higher signal. Preserve any already-persisted floor that
        // is higher (a re-persist from a stale in-memory Pairing must never lower it).
        let existingFloor =
            (defaults.dictionary(forKey: Key.meta(p.daemonId)) as? [String: String])?["floor"]
            .flatMap { Int($0) } ?? 0
        let meta: [String: String] = [
            "pk": p.daemonPublicKey.base64EncodedString(),
            "relay": p.relayURL,
            "did": p.daemonId,
            "v": String(p.version),
            "pairingId": p.pairingId,
            "hostname": p.hostname,
            "floor": String(max(p.minAdvertisedV, existingFloor)),
        ]
        defaults.set(meta, forKey: Key.meta(p.daemonId))
        var index = daemonIds()
        if !index.contains(p.daemonId) {
            index.append(p.daemonId)
            defaults.set(index, forKey: Key.daemonIndex)
        }
    }

    /// All known daemon ids, in insertion order.
    func daemonIds() -> [String] {
        defaults.stringArray(forKey: Key.daemonIndex) ?? []
    }

    /// Load a persisted (COMMITTED) pairing by daemon id, or throw `.notFound`.
    ///
    /// Tolerates legacy records: `pairingId`/`hostname` were added after the first
    /// paired users existed, so a missing `pairingId` is backfilled by deriving it
    /// from `daemonId` (`deriveLegacyPairingId`) and `hostname` defaults to "". This
    /// must NOT hard-fail on the new keys — every already-paired daemon would
    /// silently vanish (the guard feeds `connect`'s silent `else { return }`).
    func load(daemonId: String) throws -> Pairing {
        guard let meta = defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String],
            let pkB64 = meta["pk"], let daemonPk = Data(base64Encoded: pkB64),
            let relay = meta["relay"], let did = meta["did"],
            let vStr = meta["v"], let v = UInt8(vStr)
        else { throw PairingError.notFound }
        let secret = try keychainGet(account: daemonId)
        let pairingId =
            meta["pairingId"].flatMap { $0.isEmpty ? nil : $0 }
            ?? deriveLegacyPairingId(daemonId: did)
        // Legacy committed rows lack `floor`; default to 0 (unknown). A v4-derived
        // record persisted its floor=3 at promote time.
        let floor = meta["floor"].flatMap { Int($0) } ?? 0
        return Pairing(
            pairingSecret: secret, daemonPublicKey: daemonPk,
            relayURL: relay, daemonId: did, frontendId: frontendId(), version: v,
            pairingId: pairingId, hostname: meta["hostname"] ?? "", minAdvertisedV: floor)
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

    /// Promote a PENDING pairing to COMMITTED (write committed record + drop the
    /// pending one). **Idempotent** (§1.4/§1.6 W10): a re-entrant call after the
    /// pending record is already gone is a silent no-op — it must never throw and
    /// never resurrect a committed row it cannot build.
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

    /// Remove a pairing (Keychain secret + metadata + label + index entry).
    func remove(daemonId: String) {
        keychainDelete(account: daemonId)
        defaults.removeObject(forKey: Key.meta(daemonId))
        defaults.removeObject(forKey: "tp.pairing.\(daemonId).label")
        defaults.set(daemonIds().filter { $0 != daemonId }, forKey: Key.daemonIndex)
    }

    // MARK: Keychain (generic password, keyed by account)

    /// Persist a COMMITTED pairing secret. Synced via iCloud Keychain on iOS/iPadOS
    /// so a user who pairs once on iPhone gets it on other devices without
    /// re-pairing; never synced on macOS local/ad-hoc builds (no entitlement).
    private func keychainSet(_ data: Data, account: String) throws {
        // On macOS local/ad-hoc builds (no keychain-access-groups entitlement),
        // kSecAttrSynchronizable = true fails with errSecMissingEntitlement (-34018)
        // because iCloud Keychain sync requires the entitlement even for generic
        // passwords. Use non-synchronized storage on macOS for local dev builds.
        #if os(macOS)
        try keychainWrite(data, account: account, synchronizable: false)
        #else
        // The committed pairing secret is a shared *group* credential (the
        // kx-envelope key). Syncing it is orthogonal to the daemon↔frontend E2EE:
        // each device still does its own kx with its own device-local `frontendId`,
        // so synced secret + per-device frontendId is the correct multi-device combo.
        try keychainWrite(data, account: account, synchronizable: true)
        #endif
    }

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
