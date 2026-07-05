import Foundation
import Security
import os

/// One COMMITTED pairing, stored as a single per-pairing **synchronizable Keychain
/// blob** (PR-6 / design §3.2 "Option A"). Keying each pairing on its own
/// `pairingId` account means iCloud Keychain's item-granular last-writer-wins merge
/// converges losslessly when two devices add different pairings in the same sync
/// window — there is no shared conflict unit (design §3.7 item 3).
///
/// The blob carries only fields that are safe to sync (the pairing is a shared
/// *group* credential — each device still runs its own kx with its own device-local
/// `frontendId`). Explicitly EXCLUDED and kept device-local (design §3.6 cond 4):
/// `frontendId` (syncing it would clobber the daemon's per-frontend session keys),
/// `lastConfirmedPct`/`confirmedAt` (§2.5 — bound to this device's ephemeral kx
/// keypair, would cause false mismatches), `label` (device-local to drop the LWW
/// surface), and the anti-downgrade `floor` (§1.3, device-local).
struct PairingBlob: Codable, Equatable {
    let ps: String  // base64 32-byte pairing secret
    let pk: String  // base64 32-byte daemon pubkey
    let relay: String
    let did: String  // daemonId (without the "daemon-" wire prefix stripping — as stored)
    let v: UInt8  // pairing wire version
    let pairingId: String
    let hostname: String
    /// Milliseconds since 1970, set once at save/promote time. An **in-blob**
    /// recency signal used only as a defensive tiebreaker when (transiently) more
    /// than one blob shares a `did`. Not `kSecAttrModificationDate` — that is a
    /// per-replica local timestamp, not comparable across synced devices.
    let ts: Int
}

/// Errors from the committed-record persistence layer.
enum RecordStoreError: Error, CustomStringConvertible {
    /// The Keychain could not be enumerated for a *transient* reason (not-found is
    /// NOT this — see `KeychainRecordStore.loadAll`): before first unlock, missing
    /// entitlement, auth failure, etc. Callers MUST keep their last-good cache and
    /// retry — treating this as "0 pairings" would wipe every pairing from the UI.
    case locked(OSStatus)
    case keychain(OSStatus)

    var status: OSStatus {
        switch self {
        case .locked(let s), .keychain(let s): return s
        }
    }

    var description: String {
        switch self {
        case .locked(let s): return "keychain locked/unavailable: OSStatus \(s)"
        case .keychain(let s): return "keychain: OSStatus \(s)"
        }
    }
}

/// The COMMITTED persistence seam (design §3.5 "격리 seam"). Isolating the store
/// behind this protocol keeps the req-3 storage decision (Option A) from leaking
/// into the pairing lifecycle, and lets `PairingStoreTests` inject an in-memory
/// double without touching the real Keychain.
protocol PairingRecordStore: Sendable {
    /// Enumerate every committed blob. Throws `.locked` on a transient failure;
    /// returns `[]` ONLY on a genuine `errSecItemNotFound`. Undecodable items
    /// (e.g. a probe leftover, a future schema) are skipped, not fatal.
    func loadAll() throws -> [PairingBlob]
    /// Idempotent upsert (delete-then-add) of one blob, keyed by `pairingId`.
    func save(_ blob: PairingBlob) throws
    /// Best-effort delete of the blob for `pairingId`. Non-throwing.
    func remove(pairingId: String)
}

/// Real `PairingRecordStore` over the iCloud-synchronizable Keychain.
///
/// Uses a dedicated fixed service (`<base>.v2`) distinct from the legacy secret
/// service so migration writes never collide with legacy items. Enumeration over
/// that service IS the index — the set of accounts is the set of pairingIds
/// (design §3.2 "열거 = Keychain 자체가 index").
final class KeychainRecordStore: PairingRecordStore, @unchecked Sendable {
    private let service: String
    private let synchronizable: Bool
    private let log = Logger(subsystem: "dev.tpmt.app", category: "pairing-store")

    init(service: String, synchronizable: Bool) {
        self.service = service
        self.synchronizable = synchronizable
    }

    func loadAll() throws -> [PairingBlob] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            // Match both synced and local variants (a macOS ad-hoc build stores local).
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else {
            // Everything that is NOT success-or-not-found is a transient/locked
            // condition (interactionNotAllowed before first unlock, missingEntitlement,
            // authFailed, …). Surface it so the caller preserves its cache.
            throw RecordStoreError.locked(status)
        }
        // With kSecMatchLimitAll + kSecReturnAttributes + kSecReturnData, the result
        // is an array of merged dicts — each holds BOTH the attributes and the data.
        guard let items = out as? [[String: Any]] else { return [] }
        var blobs: [PairingBlob] = []
        for item in items {
            guard let data = item[kSecValueData as String] as? Data else { continue }
            do {
                blobs.append(try JSONDecoder().decode(PairingBlob.self, from: data))
            } catch {
                // A probe leftover or a future/foreign schema — skip, never fail the
                // whole enumeration (would take down every real pairing with it).
                let account = item[kSecAttrAccount as String] as? String ?? "?"
                log.error(
                    "skipping undecodable committed item account=\(account, privacy: .public)")
            }
        }
        return blobs
    }

    func save(_ blob: PairingBlob) throws {
        let data = try JSONEncoder().encode(blob)
        // Idempotent overwrite: delete any prior item for this pairingId (either sync
        // variant) then add — same guarantee as the legacy secret writer.
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: blob.pairingId,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ] as CFDictionary)
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: blob.pairingId,
            kSecAttrSynchronizable as String: (synchronizable ? kCFBooleanTrue : kCFBooleanFalse)!,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw RecordStoreError.keychain(status) }
    }

    func remove(pairingId: String) {
        SecItemDelete(
            [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: pairingId,
                kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            ] as CFDictionary)
    }
}

// MARK: - macOS iCloud-Keychain sync probe

/// Whether committed blobs can be written `synchronizable` on this build.
///
/// iOS/iPadOS always can. On macOS, iCloud Keychain sync of a generic password
/// requires the **iCloud Keychain sync entitlement** — present in a signed
/// Release/TestFlight build, but stripped from the local ad-hoc smoke build
/// (`CODE_SIGN_ENTITLEMENTS=""`), where a `synchronizable:true` write fails with
/// `errSecMissingEntitlement` (-34018). (Note: this is a DIFFERENT entitlement from
/// `keychain-access-groups`, which the macOS entitlements file already declares.)
/// So macOS decides at runtime: try one throwaway synchronizable write and only
/// trust `errSecSuccess` — every other status degrades to local-only storage,
/// which still works, just without cross-device sync.
enum PairingSyncProbe {
    #if os(macOS)
    /// Fixed, deliberately non-UUID account so a probe leftover can never collide
    /// with a real (UUID) pairingId account nor be mistaken for a blob.
    private static let probeAccount = "__tp_sync_probe__"
    private static let lock = NSLock()
    // Guarded by `lock` (author-verified); `nonisolated(unsafe)` records that
    // the Swift 6 compiler can't prove the manual synchronization.
    nonisolated(unsafe) private static var cached: Bool?

    static func syncAvailable(service: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let result = probe(service: service)
        cached = result
        return result
    }

    private static func probe(service: String) -> Bool {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: probeAccount,
            kSecAttrSynchronizable as String: kCFBooleanTrue!,
        ]
        SecItemDelete(base as CFDictionary)  // clear any prior leftover
        var add = base
        add[kSecValueData as String] = Data([0x01])
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        SecItemDelete(base as CFDictionary)  // clean up regardless
        // ONLY success means sync works; treat every other status (missing
        // entitlement, transient auth/interaction failures on headless runs) as
        // local-only rather than misreading a transient failure as "sync ok".
        return status == errSecSuccess
    }
    #else
    static func syncAvailable(service: String) -> Bool { true }
    #endif
}
