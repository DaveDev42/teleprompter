import { describe, expect, test } from "bun:test";
import { QueuedWriter } from "./queued-writer";

class MockSocket {
  written: Uint8Array[] = [];
  capacity: number;

  constructor(capacity = Infinity) {
    this.capacity = capacity;
  }

  write(data: Uint8Array): number {
    if (this.capacity === 0) return 0;
    const toWrite = Math.min(data.byteLength, this.capacity);
    this.written.push(data.subarray(0, toWrite));
    return toWrite;
  }
}

describe("QueuedWriter", () => {
  test("writes directly when socket has capacity", () => {
    const socket = new MockSocket();
    const writer = new QueuedWriter();

    const data = new TextEncoder().encode("hello");
    const ok = writer.write(socket, data);

    expect(ok).toBe(true);
    expect(writer.pending).toBe(0);
    expect(socket.written.length).toBe(1);
  });

  test("queues when socket returns 0", () => {
    const socket = new MockSocket(0);
    const writer = new QueuedWriter();

    const data = new TextEncoder().encode("hello");
    const ok = writer.write(socket, data);

    expect(ok).toBe(false);
    expect(writer.pending).toBe(1);
  });

  test("drains queued data", () => {
    const socket = new MockSocket(0);
    const writer = new QueuedWriter();

    writer.write(socket, new TextEncoder().encode("one"));
    writer.write(socket, new TextEncoder().encode("two"));
    expect(writer.pending).toBe(2);

    // Restore capacity and drain
    socket.capacity = Infinity;
    const drained = writer.drain(socket);
    expect(drained).toBe(true);
    expect(writer.pending).toBe(0);
  });

  test("partial drain leaves remaining in queue", () => {
    const socket = new MockSocket(0);
    const writer = new QueuedWriter();

    writer.write(socket, new TextEncoder().encode("hello"));
    expect(writer.pending).toBe(1);

    // Only allow partial write
    socket.capacity = 3;
    const drained = writer.drain(socket);
    expect(drained).toBe(false);
    expect(writer.pending).toBe(1); // remainder still queued
  });

  test("burst write scenario", () => {
    const socket = new MockSocket();
    const writer = new QueuedWriter();

    for (let i = 0; i < 1000; i++) {
      writer.write(socket, new TextEncoder().encode(`msg-${i}`));
    }

    expect(writer.pending).toBe(0);
    expect(socket.written.length).toBe(1000);
  });

  test("overflows when queued bytes exceed cap and rejects further writes", () => {
    const socket = new MockSocket(0);
    const writer = new QueuedWriter({ maxQueuedBytes: 8 });

    // 4 bytes — fits.
    const first = writer.write(socket, new TextEncoder().encode("aaaa"));
    expect(first).toBe(false);
    expect(writer.pending).toBe(1);
    expect(writer.isOverflowed).toBe(false);

    // Another 4 bytes — still within cap (4+4 = 8, boundary).
    writer.write(socket, new TextEncoder().encode("bbbb"));
    expect(writer.isOverflowed).toBe(false);

    // One more byte pushes past cap → overflows.
    const third = writer.write(socket, new TextEncoder().encode("c"));
    expect(third).toBe(false);
    expect(writer.isOverflowed).toBe(true);

    // Subsequent writes short-circuit and stay dropped.
    const fourth = writer.write(socket, new TextEncoder().encode("d"));
    expect(fourth).toBe(false);
  });
});
