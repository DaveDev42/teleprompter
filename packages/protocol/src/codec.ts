const HEADER_SIZE = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(data: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(data));
  const frame = new Uint8Array(HEADER_SIZE + json.byteLength);
  new DataView(frame.buffer).setUint32(0, json.byteLength);
  frame.set(json, HEADER_SIZE);
  return frame;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  decode(chunk: Uint8Array): unknown[] {
    // Append chunk to buffer
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;

    const results: unknown[] = [];

    while (this.buf.byteLength >= HEADER_SIZE) {
      const len = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      ).getUint32(0);

      if (this.buf.byteLength < HEADER_SIZE + len) break;

      const json = decoder.decode(
        this.buf.subarray(HEADER_SIZE, HEADER_SIZE + len),
      );
      results.push(JSON.parse(json));
      this.buf = this.buf.subarray(HEADER_SIZE + len);
    }

    return results;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}
