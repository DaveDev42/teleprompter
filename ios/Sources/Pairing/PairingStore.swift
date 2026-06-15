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
    /// Pairing wire version (2 or 3).
    let version: UInt8
}

/// Errors surfaced while ingesting or persisting a pairing.
enum PairingError: Error, CustomStringConvertible {
    case decode(String)
    case malformedSecret(field: String, bytes: Int)
    case keychain(OSStatus)
    case notFound

    var description: String {
        switch self {
        case let .decode(d): return "decode: \(d)"
        case let .malformedSecret(field, bytes): return "malformed \(field): \(bytes)B (want 32)"
        case let .keychain(status): return "keychain: OSStatus \(status)"
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
final class PairingStore {
    static let shared = PairingStore()

    private let defaults: UserDefaults
    private let keychainService: String
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "pairing")

    private enum Key {
        static let frontendId = "tp.frontendId"
        static let daemonIndex = "tp.pairings.index" // [String] of daemon ids
        static func meta(_ did: String) -> String { "tp.pairing.\(did).meta" } // [String:String]
    }

    init(defaults: UserDefaults = .standard,
         keychainService: String = "dev.tpmt.teleprompter.pairing") {
        self.defaults = defaults
        self.keychainService = keychainService
    }

    // MARK: frontendId

    /// The stable per-install identity, generated once and persisted.
    func frontendId() -> String {
        if let existing = defaults.string(forKey: Key.frontendId), !existing.isEmpty {
            return existing
        }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: Key.frontendId)
        return id
    }

    // MARK: ingestion

    /// Decode a `tp://p?d=…` deep link into a `Pairing` and persist it.
    /// Returns the persisted pairing. Throws `PairingError` on any failure.
    @discardableResult
    func ingest(deepLink: String) throws -> Pairing {
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

        let pairing = Pairing(
            pairingSecret: secret,
            daemonPublicKey: daemonPk,
            relayURL: ffi.relay,
            daemonId: ffi.did,
            frontendId: frontendId(),
            version: ffi.v)
        try persist(pairing)
        return pairing
    }

    // MARK: persistence

    private func persist(_ p: Pairing) throws {
        try keychainSet(p.pairingSecret, account: p.daemonId)
        let meta: [String: String] = [
            "pk": p.daemonPublicKey.base64EncodedString(),
            "relay": p.relayURL,
            "did": p.daemonId,
            "v": String(p.version),
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

    /// Load a persisted pairing by daemon id, or throw `.notFound`.
    func load(daemonId: String) throws -> Pairing {
        guard let meta = defaults.dictionary(forKey: Key.meta(daemonId)) as? [String: String],
              let pkB64 = meta["pk"], let daemonPk = Data(base64Encoded: pkB64),
              let relay = meta["relay"], let did = meta["did"],
              let vStr = meta["v"], let v = UInt8(vStr)
        else { throw PairingError.notFound }
        let secret = try keychainGet(account: daemonId)
        return Pairing(
            pairingSecret: secret, daemonPublicKey: daemonPk,
            relayURL: relay, daemonId: did, frontendId: frontendId(), version: v)
    }

    /// Remove a pairing (Keychain secret + metadata + index entry).
    func remove(daemonId: String) {
        keychainDelete(account: daemonId)
        defaults.removeObject(forKey: Key.meta(daemonId))
        defaults.set(daemonIds().filter { $0 != daemonId }, forKey: Key.daemonIndex)
    }

    // MARK: Keychain (generic password, keyed by daemon id)

    private func keychainSet(_ data: Data, account: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary) // idempotent overwrite
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
    }

    private func keychainGet(account: String) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: account,
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
        ]
        SecItemDelete(query as CFDictionary)
    }
}
