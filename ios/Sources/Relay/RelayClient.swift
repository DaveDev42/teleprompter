import Foundation
import os

/// Relay WebSocket client — connects, authenticates as `role=frontend`, keeps the
/// socket alive (ADR-0001 Phase 3, M2).
///
/// Wraps `URLSessionWebSocketTask` (no third-party dependency). The state machine
/// is `idle → connecting → authenticating → authenticated` (or `failed`). On a
/// successful auth it emits the `TP_RELAY_AUTH_OK daemon=<id>` marker — the
/// on-device proof that the app reached the relay, the relay accepted the
/// `relay.auth` frame shape + token, and the receive loop decoded the response.
/// A rejection emits `TP_RELAY_AUTH_FAIL detail=<…>` (never the token/secret).
///
/// M2 scope: connect + auth + ping. Resume (`relay.auth.resume`), kx, and data
/// frames are M3+. The auth token is the verbatim FFI `deriveRelayToken` output
/// (lowercase hex of BLAKE2b-256(pairingSecret || "relay-auth")), which the Rust
/// host tests prove byte-equal to the TS golden vector.
final class RelayClient: NSObject {
    /// Connection lifecycle. `authenticated` is the M2 success terminal.
    enum State: Equatable {
        case idle
        case connecting
        case authenticating
        case authenticated(daemonId: String)
        case failed(reason: String)
    }

    /// On-device verification markers (kept in sync with `scripts/ios.sh`).
    static let authOkMarker = "TP_RELAY_AUTH_OK"
    static let authFailMarker = "TP_RELAY_AUTH_FAIL"

    private(set) var state: State = .idle {
        didSet { onStateChange?(state) }
    }

    /// Optional observer (UI). Invoked on the URLSession delegate queue.
    var onStateChange: ((State) -> Void)?

    /// Cached after `relay.auth.ok` for the (deferred) resume fast-path.
    private(set) var resumeToken: String?
    private(set) var resumeExpiresAt: Double?

    private let pairing: Pairing
    private let session: URLSession
    private let log = Logger(subsystem: "dev.tpmt.teleprompter", category: "relay")
    private let pingInterval: TimeInterval

    private var task: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?

    /// - Parameters:
    ///   - pairing: the daemon pairing carrying relay URL, daemonId, secret, frontendId.
    ///   - session: injectable for tests (default ephemeral, no cookies/cache).
    ///   - pingInterval: keep-alive cadence; 30s matches the daemon + relay idle window.
    init(pairing: Pairing,
         session: URLSession = .init(configuration: .ephemeral),
         pingInterval: TimeInterval = 30) {
        self.pairing = pairing
        self.session = session
        self.pingInterval = pingInterval
        super.init()
    }

    deinit { disconnect() }

    /// The relay auth token: verbatim FFI output, used as-is in `relay.auth.token`.
    /// Computed here (not stored) so the secret is never retained beyond the call.
    private func authToken() -> String {
        deriveRelayToken(pairingSecret: pairing.pairingSecret)
    }

    // MARK: connect / auth

    /// Open the WebSocket and send `relay.auth`. Idempotent against re-entry: a
    /// second call while already connecting/authenticated is ignored.
    func connect() {
        switch state {
        case .connecting, .authenticating, .authenticated:
            return
        case .idle, .failed:
            break
        }
        guard let url = URL(string: pairing.relayURL) else {
            fail("invalid relay URL")
            return
        }
        state = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop()
        sendAuth()
    }

    /// Tear down the socket and timers. Safe to call repeatedly.
    func disconnect() {
        pingTimer?.cancel()
        pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func sendAuth() {
        let auth = RelayAuth(
            daemonId: pairing.daemonId,
            token: authToken(),
            frontendId: pairing.frontendId)
        state = .authenticating
        send(auth) { [weak self] error in
            if let error { self?.fail("auth send: \(error)") }
        }
    }

    // MARK: send

    private func send<T: Encodable>(_ message: T, completion: @escaping (Error?) -> Void) {
        guard let task else {
            completion(URLError(.networkConnectionLost))
            return
        }
        do {
            let data = try JSONEncoder().encode(message)
            // Send as text — the relay parses UTF-8 JSON, binary frames are reserved
            // for the framed-codec data path (M3+).
            let json = String(decoding: data, as: UTF8.self)
            task.send(.string(json)) { completion($0) }
        } catch {
            completion(error)
        }
    }

    // MARK: receive loop

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                self.handle(message)
                self.receiveLoop() // continue until the socket closes
            case let .failure(error):
                // A clean close after auth is not a failure; before auth it is.
                if case .authenticated = self.state {
                    self.log.notice("relay closed: \(error.localizedDescription, privacy: .public)")
                } else {
                    self.fail("receive: \(error.localizedDescription)")
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case let .string(s): data = Data(s.utf8)
        case let .data(d): data = d
        @unknown default: return
        }
        guard let envelope = try? JSONDecoder().decode(RelayServerEnvelope.self, from: data) else {
            log.notice("relay: undecodable frame")
            return
        }
        switch envelope.t {
        case "relay.auth.ok":
            if let ok = try? JSONDecoder().decode(RelayAuthOk.self, from: data) {
                onAuthOk(ok)
            }
        case "relay.auth.err":
            let detail = (try? JSONDecoder().decode(RelayAuthErr.self, from: data))?.e ?? "unknown"
            fail("relay.auth.err: \(detail)")
        case "relay.presence":
            if let p = try? JSONDecoder().decode(RelayPresence.self, from: data) {
                log.notice("relay.presence daemon=\(p.daemonId, privacy: .public) online=\(p.online)")
            }
        case "relay.pong":
            break // liveness ack
        default:
            log.notice("relay: ignoring t=\(envelope.t, privacy: .public)")
        }
    }

    private func onAuthOk(_ ok: RelayAuthOk) {
        resumeToken = ok.resumeToken
        resumeExpiresAt = ok.resumeExpiresAt
        state = .authenticated(daemonId: ok.daemonId)
        log.notice("\(Self.authOkMarker) daemon=\(ok.daemonId, privacy: .public)")
        startPing()
    }

    private func fail(_ reason: String) {
        // Never log the token or secret — `reason` is constructed from relay
        // error strings and URLError descriptions only.
        log.error("\(Self.authFailMarker) detail=\(reason, privacy: .public)")
        state = .failed(reason: reason)
        disconnect()
    }

    // MARK: keep-alive

    private func startPing() {
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + pingInterval, repeating: pingInterval)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.send(RelayPing(ts: nil)) { error in
                if let error { self.log.notice("ping: \(error.localizedDescription, privacy: .public)") }
            }
        }
        timer.resume()
        pingTimer = timer
    }
}
