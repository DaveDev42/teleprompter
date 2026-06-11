/**
 * Unit tests for pcm.ts — pure PCM16 / base64 / resample helpers shared by
 * the web and native voice audio implementations.
 *
 * Run with:
 *   bun test apps/app/src/voice/pcm.test.ts
 */

import { describe, expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear,
} from "./pcm";

describe("float32ToPcm16", () => {
  test("maps full-scale values to int16 extremes", () => {
    const out = float32ToPcm16(new Float32Array([-1, 0, 1]));
    expect(out[0]).toBe(-0x8000);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0x7fff);
  });

  test("clamps out-of-range samples", () => {
    const out = float32ToPcm16(new Float32Array([-2.5, 2.5]));
    expect(out[0]).toBe(-0x8000);
    expect(out[1]).toBe(0x7fff);
  });

  test("round-trips through pcm16ToFloat32 within quantization error", () => {
    const input = new Float32Array([-0.75, -0.25, 0, 0.25, 0.75]);
    const back = pcm16ToFloat32(float32ToPcm16(input));
    for (let i = 0; i < input.length; i++) {
      expect(Math.abs(back[i]! - input[i]!)).toBeLessThan(1 / 0x7fff + 1e-6);
    }
  });
});

describe("base64", () => {
  test("matches Buffer encoding for all padding lengths", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 255, 256, 257]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
      const expected = Buffer.from(bytes).toString("base64");
      expect(bytesToBase64(bytes)).toBe(expected);
    }
  });

  test("decodes what it encodes", () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) % 256;
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect(decoded).toEqual(bytes);
  });

  test("decodes Buffer-produced base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = Buffer.from(bytes).toString("base64");
    expect(base64ToBytes(encoded)).toEqual(bytes);
  });
});

describe("resampleLinear", () => {
  test("returns input unchanged when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, 24000, 24000)).toBe(input);
  });

  test("halves the sample count for 48k → 24k", () => {
    const input = new Float32Array(4800); // 100ms at 48kHz
    const out = resampleLinear(input, 48000, 24000);
    expect(out.length).toBe(2400);
  });

  test("preserves endpoints and stays within range on a ramp", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i++) input[i] = i / (input.length - 1);
    const out = resampleLinear(input, 48000, 24000);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[out.length - 1]!).toBeCloseTo(1, 5);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("interpolates a constant signal without distortion", () => {
    const input = new Float32Array(441).fill(0.5); // 10ms at 44.1kHz
    const out = resampleLinear(input, 44100, 24000);
    expect(out.length).toBe(240);
    for (const v of out) expect(v).toBeCloseTo(0.5, 5);
  });

  test("handles empty input", () => {
    const input = new Float32Array(0);
    expect(resampleLinear(input, 48000, 24000).length).toBe(0);
  });
});
