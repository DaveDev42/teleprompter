import XCTest

@testable import Teleprompter

// MARK: - PCM codec golden tests (ported from pcm.test.ts)
//
// These tests verify byte-exact parity with the TypeScript pcm.ts functions.
// All expectations are derived from the same algorithm as the original — they
// are cross-checked against the TypeScript test suite to ensure identity.

final class PcmCodecTests: XCTestCase {

    // MARK: - float32ToPcm16

    func testFloat32ToPcm16_fullScaleExtremes() {
        let out = float32ToPcm16([-1.0, 0.0, 1.0])
        out.withUnsafeBytes { ptr in
            let buf = ptr.bindMemory(to: Int16.self)
            XCTAssertEqual(buf[0], Int16(bitPattern: 0x8000))  // -32768
            XCTAssertEqual(buf[1], 0)
            XCTAssertEqual(buf[2], 0x7fff)  // 32767
        }
    }

    func testFloat32ToPcm16_clampsOutOfRange() {
        let out = float32ToPcm16([-2.5, 2.5])
        out.withUnsafeBytes { ptr in
            let buf = ptr.bindMemory(to: Int16.self)
            XCTAssertEqual(buf[0], Int16(bitPattern: 0x8000))  // -32768
            XCTAssertEqual(buf[1], 0x7fff)  // 32767
        }
    }

    func testFloat32ToPcm16_roundTrip() {
        let input: [Float] = [-0.75, -0.25, 0.0, 0.25, 0.75]
        let pcmData = float32ToPcm16(input)
        let back = pcm16ToFloat32(pcmData)
        // Maximum quantization error is 1/0x7fff for non-negative values.
        let epsilon: Float = 1.0 / 32767.0 + 1e-6
        for i in 0..<input.count {
            XCTAssertLessThan(
                abs(back[i] - input[i]), epsilon,
                "Sample \(i): expected \(input[i]), got \(back[i])")
        }
    }

    // MARK: - base64 (via Data.base64EncodedString — stdlib, not custom impl)
    // The TypeScript tests verify the hand-rolled base64 matches Buffer encoding.
    // In Swift we use Foundation's Data.base64EncodedString which is correct by
    // construction — we verify round-trip behaviour only.

    func testBase64RoundTrip_variousLengths() {
        for len in [0, 1, 2, 3, 4, 5, 6, 255, 256, 257] {
            var bytes = Data(count: len)
            for i in 0..<len {
                bytes[i] = UInt8((i * 37 + 11) % 256)
            }
            let encoded = bytes.base64EncodedString()
            let decoded = Data(base64Encoded: encoded)
            XCTAssertEqual(decoded, bytes, "Round-trip failed for length \(len)")
        }
    }

    func testBase64RoundTrip_largeBuf() {
        var bytes = Data(count: 1024)
        for i in 0..<1024 {
            bytes[i] = UInt8((i * 131 + 7) % 256)
        }
        let encoded = bytes.base64EncodedString()
        let decoded = Data(base64Encoded: encoded)
        XCTAssertEqual(decoded, bytes)
    }

    func testBase64_highByteValues() {
        let bytes = Data([0, 1, 2, 250, 251, 252, 253, 254, 255])
        let encoded = bytes.base64EncodedString()
        let decoded = Data(base64Encoded: encoded)
        XCTAssertEqual(decoded, bytes)
    }

    // MARK: - resampleLinear

    func testResampleLinear_identityWhenRateMatches() {
        let input: [Float] = [0.1, 0.2, 0.3]
        // When rates match, resampleLinear returns the same array object.
        let out = resampleLinear(input, fromRate: 24000, toRate: 24000)
        // Swift returns same array value (not necessarily same reference for
        // value types) — verify content equality.
        XCTAssertEqual(out, input)
    }

    func testResampleLinear_halvesCount_48kTo24k() {
        let input = [Float](repeating: 0, count: 4800)  // 100ms at 48kHz
        let out = resampleLinear(input, fromRate: 48000, toRate: 24000)
        XCTAssertEqual(out.count, 2400)
    }

    func testResampleLinear_endpointsAndRangeOnRamp() {
        var input = [Float](repeating: 0, count: 480)
        for i in 0..<480 { input[i] = Float(i) / Float(479) }
        let out = resampleLinear(input, fromRate: 48000, toRate: 24000)
        XCTAssertEqual(out.first!, 0.0, accuracy: 1e-5)
        XCTAssertEqual(out.last!, 1.0, accuracy: 1e-5)
        for v in out {
            XCTAssertGreaterThanOrEqual(v, 0.0)
            XCTAssertLessThanOrEqual(v, 1.0)
        }
    }

    func testResampleLinear_constantSignal() {
        let input = [Float](repeating: 0.5, count: 441)  // 10ms at 44.1kHz
        let out = resampleLinear(input, fromRate: 44100, toRate: 24000)
        XCTAssertEqual(out.count, 240)
        for v in out {
            XCTAssertEqual(v, 0.5, accuracy: 1e-5)
        }
    }

    func testResampleLinear_emptyInput() {
        let input = [Float]()
        let out = resampleLinear(input, fromRate: 48000, toRate: 24000)
        XCTAssertEqual(out.count, 0)
    }
}
