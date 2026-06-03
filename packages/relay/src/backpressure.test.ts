import { describe, expect, test } from "bun:test";
import { type BackpressureSocket, isBackpressured } from "./relay-server";

/**
 * Regression guard for the dead-code backpressure bug: the slow-consumer
 * disconnect used to read `(ws as { bufferedAmount?: number }).bufferedAmount`,
 * but Bun's ServerWebSocket has no `bufferedAmount` property — only a
 * `getBufferedAmount()` method. The cast therefore always yielded `undefined`,
 * `?? 0` made `buffered` always 0, and the guard never tripped. These tests
 * pin the fix: the guard must consult getBufferedAmount() and fire when the
 * buffer exceeds the threshold.
 */
describe("isBackpressured", () => {
  const THRESHOLD = 4 * 1024 * 1024; // 4 MB, the relay default

  function fakeSocket(buffered: number): BackpressureSocket {
    return { getBufferedAmount: () => buffered };
  }

  test("fires when the send buffer exceeds the threshold", () => {
    expect(isBackpressured(fakeSocket(THRESHOLD + 1), THRESHOLD)).toBe(true);
    expect(isBackpressured(fakeSocket(THRESHOLD * 2), THRESHOLD)).toBe(true);
  });

  test("does not fire at or below the threshold", () => {
    expect(isBackpressured(fakeSocket(0), THRESHOLD)).toBe(false);
    expect(isBackpressured(fakeSocket(THRESHOLD - 1), THRESHOLD)).toBe(false);
    // Exactly at the threshold is NOT backpressured (strict `>`), matching the
    // original guard's `buffered > this.backpressureBytes`.
    expect(isBackpressured(fakeSocket(THRESHOLD), THRESHOLD)).toBe(false);
  });

  test("reads the live buffered amount via getBufferedAmount(), not a property", () => {
    // This is the heart of the regression. A socket whose buffered bytes live
    // ONLY behind the method (no `bufferedAmount` property) must still trip the
    // guard. The old property-cast read undefined here and returned false.
    let calls = 0;
    const methodOnly: BackpressureSocket = {
      getBufferedAmount: () => {
        calls++;
        return THRESHOLD + 100;
      },
    };
    expect(isBackpressured(methodOnly, THRESHOLD)).toBe(true);
    expect(calls).toBe(1); // the method was actually consulted
  });

  test("honors a custom (small) threshold", () => {
    expect(isBackpressured(fakeSocket(2), 1)).toBe(true);
    expect(isBackpressured(fakeSocket(1), 1)).toBe(false);
  });
});
