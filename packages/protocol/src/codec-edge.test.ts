import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "./codec";

// 64 MiB cap — must stay in sync with MAX_FRAME_SIZE in codec.ts
const MAX_FRAME_SIZE = 64 * 1024 * 1024;

describe("codec edge cases", () => {
  test("encode/decode empty object", () => {
    const frame = encodeFrame({});
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect(results[0]?.data).toEqual({});
    expect(results[0]?.binary).toBeNull();
  });

  test("encode/decode object with unicode", () => {
    const data = { text: "한글 테스트 🚀 émojis" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect(results[0]?.data).toEqual(data);
  });

  test("decode handles partial frames across multiple chunks", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ msg: "hello world" });

    // Split frame into two chunks
    const mid = Math.floor(frame.length / 2);
    const chunk1 = frame.subarray(0, mid);
    const chunk2 = frame.subarray(mid);

    const results1 = decoder.decode(chunk1);
    expect(results1.length).toBe(0); // not enough data yet

    const results2 = decoder.decode(chunk2);
    expect(results2.length).toBe(1);
    expect(results2[0]?.data).toEqual({ msg: "hello world" });
  });

  test("decode handles multiple frames in single chunk", () => {
    const decoder = new FrameDecoder();
    const frame1 = encodeFrame({ a: 1 });
    const frame2 = encodeFrame({ b: 2 });
    const frame3 = encodeFrame({ c: 3 });

    const combined = new Uint8Array(
      frame1.length + frame2.length + frame3.length,
    );
    combined.set(frame1, 0);
    combined.set(frame2, frame1.length);
    combined.set(frame3, frame1.length + frame2.length);

    const results = decoder.decode(combined);
    expect(results.length).toBe(3);
    expect(results[0]?.data).toEqual({ a: 1 });
    expect(results[1]?.data).toEqual({ b: 2 });
    expect(results[2]?.data).toEqual({ c: 3 });
  });

  test("decode handles byte-at-a-time delivery", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ slow: true });

    let lastResults: ReturnType<FrameDecoder["decode"]> = [];
    for (let i = 0; i < frame.length; i++) {
      const r = decoder.decode(frame.subarray(i, i + 1));
      if (r.length > 0) lastResults = r;
    }
    // Only the last byte completes the frame
    expect(lastResults.length).toBe(1);
    expect(lastResults[0]?.data).toEqual({ slow: true });
  });

  test("encode large payload (100KB JSON)", () => {
    const data = { payload: "x".repeat(100_000) };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect(
      (results[0]?.data as { payload: string } | undefined)?.payload.length,
    ).toBe(100_000);
  });

  test("reset clears decoder state", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ msg: "test" });

    // Feed partial data
    decoder.decode(frame.subarray(0, 3));

    // Reset
    decoder.reset();

    // Feed a complete frame — should decode normally
    const results = decoder.decode(encodeFrame({ after: "reset" }));
    expect(results.length).toBe(1);
    expect(results[0]?.data).toEqual({ after: "reset" });
  });

  // ── H1: poison header with huge binLen must throw, not wedge ────────────
  // A hostile 8-byte header declaring binLen=0xFFFFFFFF (≈4 GiB) must be
  // rejected immediately with a clear error. Before the fix the decoder would
  // silently `break` out of the while loop, leaving the oversized header in
  // this.buf, and every subsequent chunk would be concat-copied (O(N²)) until
  // the process ran out of memory.
  test("H1: poison header (binLen=0xFFFFFFFF) throws Frame too large", () => {
    const decoder = new FrameDecoder();
    const poison = new Uint8Array(8);
    const view = new DataView(poison.buffer);
    view.setUint32(0, 2); // jsonLen = 2 (tiny — passes individual field check)
    view.setUint32(4, 0xffffffff); // binLen = 4 GiB → sum far exceeds cap
    expect(() => decoder.decode(poison)).toThrow(/Frame too large/);
  });

  test("H1: header where jsonLen alone exceeds cap throws", () => {
    const decoder = new FrameDecoder();
    const poison = new Uint8Array(8);
    const view = new DataView(poison.buffer);
    view.setUint32(0, MAX_FRAME_SIZE + 1); // jsonLen > 64 MiB
    view.setUint32(4, 0);
    expect(() => decoder.decode(poison)).toThrow(/Frame too large/);
  });

  test("H1: frame at exactly the limit is accepted", () => {
    // Only test the header-check path — we don't allocate 64 MiB of actual
    // payload; the decoder breaks at the "buf < totalLen" check before OOM.
    const decoder = new FrameDecoder();
    const header = new Uint8Array(8);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, MAX_FRAME_SIZE); // exactly at limit
    hv.setUint32(4, 0);
    // No throw — decoder just waits for more data (buf < totalLen → break).
    expect(() => decoder.decode(header)).not.toThrow();
  });

  // ── M1: malformed JSON frame must throw, not wedge ───────────────────────
  // Before the fix: JSON.parse threw, buf was NOT advanced, so re-calling
  // decode with the next real frame would immediately attempt to parse the
  // same bad bytes again — the decoder was permanently wedged.
  test("M1: malformed JSON frame throws and does not wedge the decoder", () => {
    const decoder = new FrameDecoder();

    // Build a frame with syntactically invalid JSON payload.
    const badJson = new TextEncoder().encode("{ not valid json !!!");
    const frame = new Uint8Array(8 + badJson.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, badJson.length);
    view.setUint32(4, 0);
    frame.set(badJson, 8);

    expect(() => decoder.decode(frame)).toThrow();
  });

  test("M1: empty JSON payload throws, not wedge", () => {
    const decoder = new FrameDecoder();

    // jsonLen=0 → JSON.parse("") throws SyntaxError
    const frame = new Uint8Array(8);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 0); // empty JSON
    view.setUint32(4, 0);

    expect(() => decoder.decode(frame)).toThrow();
  });

  // M1 WEDGE DETECTOR: after a bad frame throws, a subsequent call with a
  // GOOD frame (on the same decoder instance) must NOT also throw / re-parse
  // the old bad bytes. Without the fix (buf not advanced before JSON.parse),
  // the second decode would immediately hit the same bad-frame header again
  // and throw instead of returning the valid frame.
  test("M1: decoder is not wedged after a malformed JSON throw", () => {
    const decoder = new FrameDecoder();

    // Concatenate a bad frame followed immediately by a valid frame.
    const badJson = new TextEncoder().encode("NOTJSON");
    const badFrame = new Uint8Array(8 + badJson.length);
    const bv = new DataView(badFrame.buffer);
    bv.setUint32(0, badJson.length);
    bv.setUint32(4, 0);
    badFrame.set(badJson, 8);

    const goodFrame = encodeFrame({ ok: true });

    // Feed bad frame — must throw.
    expect(() => decoder.decode(badFrame)).toThrow();

    // The bad frame's bytes must have been consumed so a fresh decode of the
    // good frame returns the valid data rather than throwing again.
    const results = decoder.decode(goodFrame);
    expect(results.length).toBe(1);
    expect(results[0]?.data).toEqual({ ok: true });
  });

  test("large binary sidecar (1 MiB) round-trips", () => {
    const payload = new Uint8Array(1 << 20);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const frame = encodeFrame({ t: "rec", sid: "s", seq: 1 }, payload);

    const decoder = new FrameDecoder();
    const [out] = decoder.decode(frame);
    if (!out?.binary) throw new Error("expected one frame with binary payload");
    const lastIdx = payload.length - 1;
    const expectedLast = payload[lastIdx];
    expect(out.binary.byteLength).toBe(payload.byteLength);
    // Sample a few positions — comparing all 1M bytes is expensive.
    expect(out.binary[0]).toBe(0);
    expect(out.binary[0xff]).toBe(0xff);
    expect(out.binary[lastIdx]).toBe(expectedLast);
  });
});
