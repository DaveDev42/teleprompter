import { describe, expect, test } from "bun:test";
import { encodeFrame, FrameDecoder } from "./codec";
import type {
  IpcMessage,
  IpcPairBegin,
  IpcPairBeginErr,
  IpcPairBeginOk,
  IpcPairCancel,
  IpcPairCancelled,
  IpcPairCompleted,
  IpcPairError,
} from "./types/ipc";

describe("codec", () => {
  test("round-trip single frame", () => {
    const data = { t: "hello", sid: "test-1" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([data]);
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
    expect(results).toEqual([msg1, msg2, msg3]);
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
    expect(r3).toEqual([data]);
  });

  test("frame with unicode content", () => {
    const data = { message: "Hello 세계! 🌍" };
    const frame = encodeFrame(data);
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([data]);
  });

  test("empty object frame", () => {
    const frame = encodeFrame({});
    const decoder = new FrameDecoder();
    const results = decoder.decode(frame);
    expect(results).toEqual([{}]);
  });

  test("reset clears buffer", () => {
    const frame = encodeFrame({ t: "test" });
    const decoder = new FrameDecoder();

    // Feed partial frame
    decoder.decode(frame.subarray(0, 3));
    decoder.reset();

    // Should not produce the old partial frame
    const results = decoder.decode(encodeFrame({ t: "fresh" }));
    expect(results).toEqual([{ t: "fresh" }]);
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
