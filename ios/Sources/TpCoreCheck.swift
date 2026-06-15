import Foundation

/// FFI self-check for the Rust core (`tp-core`).
///
/// ADR-0001 Phase 2 verification: exercise the full
/// encode → encrypt → decrypt → decode round-trip across the UniFFI boundary so
/// the Simulator harness can prove the static library is linked AND functional,
/// not merely present. `ContentView` runs `summary()` on appear and emits the
/// result to the unified log (`TP_CORE_OK` / `TP_CORE_FAIL`), which
/// `scripts/ios.sh smoke` greps for alongside the app boot marker.
///
/// The generated bindings (`Generated/tp_core.swift`) expose the top-level
/// functions used here — `tpCoreVersion`, `kxSeedKeypair`, `seal`/`open`,
/// `encodeFrame`/`decodeFrames`, `encodePairingData`/`decodePairingData`.
enum TpCoreCheck {
    struct Failure: Error { let step: String; let detail: String }

    /// Run the round-trip. Returns the linked tp-core version string on success;
    /// throws `Failure` describing the first step that diverged.
    static func roundTrip() throws -> String {
        let version = tpCoreVersion()
        guard !version.isEmpty else {
            throw Failure(step: "version", detail: "empty version string")
        }

        // 1) Codec round-trip: encode a JSON frame + binary sidecar, decode it.
        let json = Data(#"{"t":"frame","sid":"s","k":"io"}"#.utf8)
        let sidecar = Data([1, 2, 3, 4, 5])
        let frame = encodeFrame(json: json, binary: sidecar)
        let decoded = try decodeFrames(chunk: frame)
        guard decoded.count == 1,
              decoded[0].json == json,
              decoded[0].binary == sidecar
        else {
            throw Failure(step: "codec", detail: "frame round-trip mismatch")
        }

        // 2) Key exchange: deterministic daemon/frontend keypairs, derive
        //    session keys, confirm the rx/tx crossover that E2EE relies on.
        let daemon = try kxSeedKeypair(seed: Data(repeating: 0x11, count: 32))
        let frontend = try kxSeedKeypair(seed: Data(repeating: 0x22, count: 32))
        let dKeys = try kxServerSessionKeys(
            pk: daemon.publicKey, sk: daemon.secretKey, peerPk: frontend.publicKey)
        let fKeys = try kxClientSessionKeys(
            pk: frontend.publicKey, sk: frontend.secretKey, peerPk: daemon.publicKey)
        guard dKeys.rx == fKeys.tx, dKeys.tx == fKeys.rx else {
            throw Failure(step: "kx", detail: "session-key crossover failed")
        }

        // 3) AEAD round-trip across the pair: daemon encrypts with tx,
        //    frontend decrypts with its rx (== daemon tx). Random nonce.
        let plaintext = Data("hello from swift".utf8)
        var nonce = Data(count: 24)
        let rc = nonce.withUnsafeMutableBytes { ptr in
            SecRandomCopyBytes(kSecRandomDefault, 24, ptr.baseAddress!)
        }
        guard rc == errSecSuccess else {
            throw Failure(step: "nonce", detail: "SecRandomCopyBytes failed")
        }
        let sealed = try seal(plaintext: plaintext, key: dKeys.tx, nonce: nonce)
        let opened = try open(encoded: sealed, key: fKeys.rx)
        guard opened == plaintext else {
            throw Failure(step: "aead", detail: "decrypt did not recover plaintext")
        }

        // 4) Pairing: encode → decode a deep link, confirm fields survive.
        let pairing = FfiPairingData(
            ps: dataToB64(Data(repeating: 0x01, count: 32)),
            pk: dataToB64(Data(repeating: 0x02, count: 32)),
            relay: "wss://relay.tpmt.dev",
            did: "daemon-roundtrip",
            v: 3)
        let url = try encodePairingData(data: pairing)
        let back = try decodePairingData(raw: url)
        guard back.did == "daemon-roundtrip", back.ps == pairing.ps else {
            throw Failure(step: "pairing", detail: "pairing round-trip mismatch")
        }

        return version
    }

    /// Human-readable single-line result for logging.
    static func summary() -> String {
        do {
            let v = try roundTrip()
            return "TP_CORE_OK v\(v)"
        } catch let f as Failure {
            return "TP_CORE_FAIL step=\(f.step) detail=\(f.detail)"
        } catch {
            return "TP_CORE_FAIL step=unknown detail=\(error)"
        }
    }

    private static func dataToB64(_ d: Data) -> String { d.base64EncodedString() }
}
