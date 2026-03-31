import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "./codec";

describe("codec edge cases", () => {
  test("encode/decode empty object", () => {
    const frame = encodeFrame({});
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({});
  });

  test("encode/decode object with unicode", () => {
    const data = { text: "한글 테스트 🚀 émojis" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect(results[0]).toEqual(data);
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
    expect(results2[0]).toEqual({ msg: "hello world" });
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
    expect(results[0]).toEqual({ a: 1 });
    expect(results[1]).toEqual({ b: 2 });
    expect(results[2]).toEqual({ c: 3 });
  });

  test("decode handles byte-at-a-time delivery", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ slow: true });

    let results: unknown[] = [];
    for (let i = 0; i < frame.length; i++) {
      results = decoder.decode(frame.subarray(i, i + 1));
    }
    // Only the last byte completes the frame
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({ slow: true });
  });

  test("encode large payload (100KB JSON)", () => {
    const data = { payload: "x".repeat(100_000) };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results.length).toBe(1);
    expect((results[0] as { payload: string }).payload.length).toBe(100_000);
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
    expect(results[0]).toEqual({ after: "reset" });
  });
});
