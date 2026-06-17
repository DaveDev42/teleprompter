import Foundation

// MARK: - PCM16 ↔ Float32 conversion + linear resampler
//
// Ported from the Expo app's pcm.ts. All arithmetic is byte-exact with the
// TypeScript original (verified by PcmCodecTests.swift).
//
// Note: Swift Foundation Data already has base64 encode/decode via
// Data.base64EncodedString() / Data(base64Encoded:), so the hand-rolled
// base64 from pcm.ts is not ported here — Data's implementation is correct
// and available on all Apple platforms.

/// Convert Float32 samples (range -1…1, clamped) to signed Int16 PCM.
///
/// Matches TypeScript `float32ToPcm16`:
///   s < 0 → s * 0x8000 (−32768)
///   s ≥ 0 → s * 0x7fff (32767)
func float32ToPcm16(_ samples: [Float]) -> Data {
    var out = Data(count: samples.count * 2)
    out.withUnsafeMutableBytes { ptr in
        let buf = ptr.bindMemory(to: Int16.self)
        for (i, f) in samples.enumerated() {
            let s = max(-1.0, min(1.0, f))
            let v: Int16 =
                s < 0
                ? Int16(clamping: Int32(s * 32768.0))
                : Int16(clamping: Int32(s * 32767.0))
            buf[i] = v
        }
    }
    return out
}

/// Convert signed Int16 PCM data (little-endian) to Float32 samples.
///
/// Matches TypeScript `pcm16ToFloat32`:
///   v < 0 → v / 0x8000
///   v ≥ 0 → v / 0x7fff
func pcm16ToFloat32(_ data: Data) -> [Float] {
    let count = data.count / 2
    var out = [Float](repeating: 0, count: count)
    data.withUnsafeBytes { ptr in
        let buf = ptr.bindMemory(to: Int16.self)
        for i in 0..<count {
            let v = buf[i]
            out[i] =
                v < 0
                ? Float(v) / 32768.0
                : Float(v) / 32767.0
        }
    }
    return out
}

/// Naive linear-interpolation resampler (mono Float32).
///
/// Matches TypeScript `resampleLinear`. Returns `input` unchanged (same
/// array) when `fromRate == toRate` or input is empty.
func resampleLinear(_ input: [Float], fromRate: Double, toRate: Double) -> [Float] {
    if fromRate == toRate || input.isEmpty { return input }
    let outLength = max(1, Int((Double(input.count) * toRate / fromRate).rounded()))
    var output = [Float](repeating: 0, count: outLength)
    let step = Double(input.count - 1) / Double(max(1, outLength - 1))
    for i in 0..<outLength {
        let pos = Double(i) * step
        let i0 = Int(pos)
        let i1 = min(i0 + 1, input.count - 1)
        let frac = Float(pos - Double(i0))
        output[i] = input[i0] * (1.0 - frac) + input[i1] * frac
    }
    return output
}

/// Encode Float32 samples to base64-encoded PCM16 at 24 kHz.
/// Accepts hardware-rate samples (e.g. 44.1/48 kHz) and resamples first.
func encodePcm16Base64(samples: [Float], fromRate: Double, toRate: Double = 24000) -> String {
    let resampled = resampleLinear(samples, fromRate: fromRate, toRate: toRate)
    let pcmData = float32ToPcm16(resampled)
    return pcmData.base64EncodedString()
}

/// Decode base64-encoded PCM16 data to Float32 samples.
func decodePcm16Base64(_ base64: String) -> [Float] {
    guard let data = Data(base64Encoded: base64) else { return [] }
    return pcm16ToFloat32(data)
}
