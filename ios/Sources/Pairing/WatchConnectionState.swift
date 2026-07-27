import Foundation

/// What the watch's status row is actually reporting.
///
/// **Why this replaced a `Bool`.** The watch used to render its status from
/// `anyConnected`, a computed property reading `clients[did]?.isReady`. That has
/// no observation dependency on the clients: the dictionary is
/// `@ObservationIgnored` and `RelayClient` is a plain `NSObject`, so the value
/// only ever re-evaluated when the one tracked property (`daemonIds`) changed.
/// It worked by accident because the sole post-launch mutation promoted a pairing
/// *after* kx had already completed. Any path that learns about a pairing before
/// its kx finishes — which is exactly what the WatchConnectivity mirror does —
/// would leave the row reading "Offline" permanently while fully connected.
///
/// A `Bool` also could not say the one thing the user most needs to know on a
/// device with no pairing UI: whether the phone has sent anything yet.
/// `.noPairings` and `.connecting` were indistinguishable.
enum WatchConnectionState: Equatable {
    /// Nothing committed and nothing pending — the watch is waiting on the phone.
    case noPairings
    /// At least one pairing is known, none has completed kx yet.
    case connecting
    /// At least one committed daemon has live E2EE session keys.
    case connected

    /// Derive the state from ground truth.
    ///
    /// Deliberately a pure free function over injected inputs rather than a method
    /// reading view-model state: it is the only piece of the watch's state machine
    /// that any automated test can reach. No test target compiles the watch app
    /// (`TeleprompterTests` is `[iOS, macOS]`) and watchOS has no `XCUIApplication`,
    /// so keeping the logic here — in a file the phone target also compiles — is
    /// what makes it testable at all.
    ///
    /// Recomputed wholesale on every signal, so correctness never depends on
    /// callback ordering or on a callback firing exactly once.
    static func derive(
        daemonIds: [String], pendingCount: Int, isReady: (String) -> Bool
    ) -> WatchConnectionState {
        if daemonIds.contains(where: isReady) { return .connected }
        if !daemonIds.isEmpty || pendingCount > 0 { return .connecting }
        return .noPairings
    }
}
