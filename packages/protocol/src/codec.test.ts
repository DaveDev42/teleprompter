import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "./codec";
import type { IpcMessage } from "./types/ipc";

describe("codec", () => {
  test("round-trip single frame", () => {
    const data = { t: "hello", sid: "test-1" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([{ data, binary: null }]);
  });

  test("round-trip multiple frames at once", () => {
    const msg1 = { t: "rec", sid: "s1", seq: 1 };
    const msg2 = { t: "rec", sid: "s1", seq: 2 };
    const msg3 = { t: "bye", sid: "s1" };

    const f1 = encodeFrame(msg1);
    const f2 = encodeFrame(msg2);
    const f3 = encodeFrame(msg3);

    const combined = new Uint8Array(
      f1.byteLength + f2.byteLength + f3.byteLength,
    );
    combined.set(f1);
    combined.set(f2, f1.byteLength);
    combined.set(f3, f1.byteLength + f2.byteLength);

    const decoder = new FrameDecoder();
    const results = decoder.decode(combined);
    expect(results.map((r) => r.data)).toEqual([msg1, msg2, msg3]);
    expect(results.every((r) => r.binary === null)).toBe(true);
  });

  test("partial frame across multiple chunks", () => {
    const data = { t: "rec", sid: "s1", payload: "a".repeat(100) };
    const frame = encodeFrame(data);

    const decoder = new FrameDecoder();

    // Feed header only
    const r1 = decoder.decode(frame.subarray(0, 2));
    expect(r1).toEqual([]);

    // Feed rest of header + partial payload
    const r2 = decoder.decode(frame.subarray(2, 10));
    expect(r2).toEqual([]);

    // Feed remaining
    const r3 = decoder.decode(frame.subarray(10));
    expect(r3).toEqual([{ data, binary: null }]);
  });

  test("frame with unicode content", () => {
    const data = { message: "Hello 세계! 🌍" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([{ data, binary: null }]);
  });

  test("empty object frame", () => {
    const frame = encodeFrame({});
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([{ data: {}, binary: null }]);
  });

  test("reset clears buffer", () => {
    const frame = encodeFrame({ t: "test" });
    const decoder = new FrameDecoder();

    // Feed partial frame
    decoder.decode(frame.subarray(0, 3));
    decoder.reset();

    // Should not produce the old partial frame
    const results = decoder.decode(encodeFrame({ t: "fresh" }));
    expect(results).toEqual([{ data: { t: "fresh" }, binary: null }]);
  });

  test("binary sidecar round-trips as Uint8Array without base64", () => {
    const meta = { t: "rec", sid: "s", seq: 1 };
    const payload = new Uint8Array([0, 1, 2, 0xff, 0x00, 0x7f]);
    const frame = encodeFrame(meta, payload);

    const decoder = new FrameDecoder();
    const [frameOut] = decoder.decode(frame);
    if (!frameOut) throw new Error("expected one decoded frame");
    expect(frameOut.data).toEqual(meta);
    expect(frameOut.binary).toBeInstanceOf(Uint8Array);
    if (!frameOut.binary) throw new Error("expected binary payload");
    expect(Array.from(frameOut.binary)).toEqual(Array.from(payload));
  });

  test("mixed JSON-only and binary frames in one stream", () => {
    const a = encodeFrame({ t: "hello" });
    const b = encodeFrame(
      { t: "rec", sid: "s", seq: 2 },
      new Uint8Array([1, 2, 3, 4]),
    );
    const c = encodeFrame({ t: "bye" });

    const combined = new Uint8Array(a.byteLength + b.byteLength + c.byteLength);
    combined.set(a);
    combined.set(b, a.byteLength);
    combined.set(c, a.byteLength + b.byteLength);

    const [r0, r1, r2] = new FrameDecoder().decode(combined);
    if (!r0 || !r1 || !r2) throw new Error("expected three decoded frames");
    expect(r0.binary).toBeNull();
    expect(r1.binary).not.toBeNull();
    if (!r1.binary) throw new Error("unreachable");
    expect(Array.from(r1.binary)).toEqual([1, 2, 3, 4]);
    expect(r2.binary).toBeNull();
  });

  test("partial binary tail across chunks", () => {
    const payload = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
    const frame = encodeFrame({ t: "rec", sid: "s", seq: 1 }, payload);

    const decoder = new FrameDecoder();
    // Feed header + JSON only — binary tail missing.
    const partLen = frame.byteLength - 16;
    expect(decoder.decode(frame.subarray(0, partLen))).toEqual([]);
    // Feed rest.
    const [out] = decoder.decode(frame.subarray(partLen));
    if (!out?.binary)
      throw new Error("expected decoded frame with binary payload");
    expect(Array.from(out.binary)).toEqual(Array.from(payload));
  });
});

test("IpcMessage union accepts pair.* messages", () => {
  const msgs: IpcMessage[] = [
    { t: "pair.begin", relayUrl: "wss://r", label: "x" },
    { t: "pair.begin.ok", pairingId: "p1", qrString: "q", daemonId: "d1" },
    { t: "pair.begin.err", reason: "already-pending" },
    { t: "pair.cancel", pairingId: "p1" },
    { t: "pair.completed", pairingId: "p1", daemonId: "d1", label: "x" },
    { t: "pair.cancelled", pairingId: "p1" },
    { t: "pair.error", pairingId: "p1", reason: "relay-unreachable" },
  ];
  expect(msgs.length).toBe(7);
});
