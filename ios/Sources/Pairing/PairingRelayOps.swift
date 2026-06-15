import Foundation
import os

// MARK: - Control message wire types

/// `control.rename` — E2EE control message published on the `__control__` sid
/// to notify the daemon of a label change on this frontend.
/// Wire: `{ t, daemonId, frontendId, label: { set, value? }, ts }`.
/// See `packages/protocol/src/types/control.ts`.
struct ControlRenameMsg: Encodable {
    let t = "control.rename"
    let daemonId: String
    let frontendId: String
    let label: LabelWire
    let ts: Double

    /// Minimal tagged-union form of the `Label` type.
    /// `{ set: true, value: String }` sets the name; `{ set: false }` clears it.
    struct LabelWire: Encodable {
        let set: Bool
        let value: String?
    }

    init(daemonId: String, frontendId: String, label: String?, ts: Double) {
        self.daemonId = daemonId
        self.frontendId = frontendId
        self.label = label.map { .init(set: true, value: $0) } ?? .init(set: false, value: nil)
        self.ts = ts
    }
}

/// `control.unpair` — E2EE control message published on `__control__` to
/// notify the daemon that this frontend removed the pairing.
/// Wire: `{ t, daemonId, frontendId, reason, ts }`.
struct ControlUnpairMsg: Encodable {
    let t = "control.unpair"
    let daemonId: String
    let frontendId: String
    let reason = "user-initiated"
    let ts: Double
}

// MARK: - PairingStore label helpers

extension PairingStore {
    private enum LabelKey {
        static func label(_ did: String) -> String { "tp.pairing.\(did).label" }
    }

    /// Retrieve the stored local label for a daemon (nil = not set / use short id).
    func label(for daemonId: String) -> String? {
        let v = UserDefaults.standard.string(forKey: LabelKey.label(daemonId))
        return (v?.isEmpty == false) ? v : nil
    }

    /// Persist a local label for a daemon. Pass `nil` or empty string to clear.
    func setLabel(_ label: String?, for daemonId: String) {
        if let label, !label.isEmpty {
            UserDefaults.standard.set(label, forKey: LabelKey.label(daemonId))
        } else {
            UserDefaults.standard.removeObject(forKey: LabelKey.label(daemonId))
        }
    }

    /// Remove the local label when a pairing is removed (called from `remove`).
    func removeLabel(for daemonId: String) {
        UserDefaults.standard.removeObject(forKey: LabelKey.label(daemonId))
    }
}
