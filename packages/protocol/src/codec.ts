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
  // ArrayBufferLike (vs the stricter default ArrayBuffer) so that incoming
  // chunks backed by SharedArrayBuffer or Buffer are assignable without a
  // copy — the decode path only reads, it never resizes or transfers.
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  decode(chunk: Uint8Array<ArrayBufferLike>): unknown[] {
    // Common case: the previous chunk left nothing pending. Skip the concat
    // entirely — `chunk` is sufficient as-is. For a 1 MiB burst split into N
    // chunks this avoids O(N²) bytes of buffer growth.
    if (this.buf.byteLength === 0) {
      this.buf = chunk;
    } else {
      const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      next.set(this.buf);
      next.set(chunk, this.buf.byteLength);
      this.buf = next;
    }

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

    // Detach the tail from `chunk` when it's only a partial frame, so the
    // caller's chunk buffer can be GC'd and so the next `decode` doesn't
    // alias into caller-owned memory.
    if (this.buf.byteLength > 0 && this.buf.buffer === chunk.buffer) {
      this.buf = new Uint8Array(this.buf);
    }

    return results;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }
}
