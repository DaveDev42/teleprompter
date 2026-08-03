import XCTest

@testable import Teleprompter

/// Regression guard for the 2026-08-03 real-device crash (build 2501, iPhone
/// 15 Pro): EXC_BAD_ACCESS in `_swift_release_dealloc` on a utility-QoS
/// dispatch-source thread. Root cause: RelayClient's reconnect machinery had
/// three concurrent entry points (receive-failure, auth-err, ping missed-pong
/// timer) whose DispatchSource timers ran on the CONCURRENT
/// `.global(qos: .utility)` root queue, so a daemon restart raced them through
/// `scheduleReconnect`'s non-atomic idempotency guard and double-released the
/// swapped-out strong references (`pingTimer`, `task`, `sessionKeys`, …).
///
/// The fix confines all connection-lifecycle state to one private serial
/// `stateQueue`. This test hammers the public lifecycle entry points from many
/// concurrent threads while real socket failures drive the internal
/// receive-failure → `scheduleReconnect` path (127.0.0.1:1 refuses instantly,
/// so every `connect()` produces a genuine receive-loop failure). Under the
/// old concurrent-queue code this crashes the test process (over-release);
/// with the serial confinement it must survive the storm.
final class RelayReconnectRaceTests: XCTestCase {
    private let goldenSecret = Data((0..<32).map { UInt8($0) })

    private func makeClient() -> RelayClient {
        RelayClient(
            pairing: Pairing(
                pairingSecret: goldenSecret,
                daemonPublicKey: Data(repeating: 0x02, count: 32),
                // Connection refused instantly — every connect() yields a real
                // receive failure, exercising the reconnect teardown path.
                relayURL: "ws://127.0.0.1:1",
                daemonId: "daemon-race-test",
                frontendId: "frontend-race",
                version: 3,
                pairingId: UUID().uuidString,
                hostname: "",
                minAdvertisedV: 0))
    }

    func testConcurrentLifecycleHammeringDoesNotCrash() {
        let client = makeClient()
        let iterations = 200
        let group = DispatchGroup()
        let hammer = DispatchQueue(label: "race-hammer", attributes: .concurrent)

        for i in 0..<iterations {
            group.enter()
            hammer.async {
                switch i % 7 {
                case 0: client.connect()
                case 1: client.disconnect()
                case 2: client.sendHello()
                case 3: client.sendInput(sid: "s-race", kind: .chat, text: "x")
                case 4: client.setPairingPhase(pending: i % 2 == 0)
                // Observer rewires on a live client — `rewirePromotedClient`
                // does exactly this from the MainActor at pairing promotion
                // while stateQueue may be invoking the very same closures
                // (the second hazard the 2026-08-03 crash review surfaced).
                case 5: client.onPresence = { _, _ in }
                default: client.onStateChange = { _ in }
                }
                group.leave()
            }
        }
        XCTAssertEqual(
            group.wait(timeout: .now() + 30), .success,
            "lifecycle hammer did not finish — likely a deadlock in the serialized path")
        // Let any pending reconnect timers fire into the serialized path while
        // the client is still alive (exercises timer-handler vs teardown), then
        // tear down. The assertion is the absence of an over-release crash.
        Thread.sleep(forTimeInterval: 1.5)
        client.disconnect()
    }
}
