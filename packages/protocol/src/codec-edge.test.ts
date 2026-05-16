import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "./codec";

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
    expect((results[0]?.data as { payload: string } | undefined)?.payload.length).toBe(
      100_000,
    );
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
