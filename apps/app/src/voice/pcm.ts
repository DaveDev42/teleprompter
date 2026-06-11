/**
 * Pure PCM16 / base64 helpers shared by the web (Web Audio API) and native
 * (react-native-audio-api) voice audio implementations.
 *
 * base64 is hand-rolled instead of btoa/atob because the native path runs on
 * Hermes where btoa availability depends on the engine build, and instead of
 * the protocol package's toBase64/fromBase64 because those are async (they
 * round-trip through the CryptoProvider seam) — too heavy for an audio chunk
 * callback firing many times per second.
 */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_LOOKUP = (() => {
  const lookup = new Uint8Array(128);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    lookup[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return lookup;
})();

export function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

export function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i]! / (pcm16[i]! < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}==`;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}${B64_ALPHABET[(n >> 6) & 63]!}=`;
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  let len = base64.length;
  while (len > 0 && base64[len - 1] === "=") len--;
  const byteLen = Math.floor((len * 3) / 4);
  const bytes = new Uint8Array(byteLen);
  let bi = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    buffer = (buffer << 6) | B64_LOOKUP[base64.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[bi++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

/**
 * Naive linear-interpolation resampler (mono). The native recorder delivers
 * buffers at whatever rate the hardware prefers (commonly 44.1/48 kHz even
 * when 24 kHz is requested); the OpenAI Realtime API requires PCM16 24 kHz,
 * so off-rate capture buffers are resampled before encoding. Linear
 * interpolation is adequate for speech into a server-side VAD/STT pipeline.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(outLength);
  const step = (input.length - 1) / Math.max(1, outLength - 1);
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    output[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return output;
}
