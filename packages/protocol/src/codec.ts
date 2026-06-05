const HEADER_SIZE = 8;

/**
 * Maximum allowed frame payload (jsonLen + binLen) in bytes.
 *
 * Rationale: the largest legitimate frames we send today are 1 MiB binary
 * PTY sidecars (codec-edge.test.ts) plus their JSON metadata (a few hundred
 * bytes). The QueuedWriter caps its in-memory queue at 8 MiB. A 64 MiB ceiling
 * is therefore 64× the real-world peak — generous enough to absorb any future
 * growth, but tight enough to reject a poison header declaring 4 GiB
 * (0xFFFFFFFF binLen) before we attempt to buffer anything. Frames exceeding
 * this limit indicate a protocol violation (corrupt peer, adversarial input,
 * or a stream sync loss) and require connection teardown.
 */
const MAX_FRAME_SIZE = 64 * 1024 * 1024; // 64 MiB

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A decoded frame. `binary` is the raw payload that accompanies the JSON when
 * the sender used the binary-sidecar path (e.g. Runner → Daemon PTY io); it
 * is `null` for plain JSON frames.
 */
export interface DecodedFrame {
  data: unknown;
  binary: Uint8Array<ArrayBufferLike> | null;
}

/**
 * Wire format v2:
 *   u32_be jsonLen
 *   u32_be binLen  (0 for plain JSON frames)
 *   utf-8 JSON
 *   binLen bytes of raw binary payload (only when binLen > 0)
 *
 * The binary-sidecar path lets high-throughput streams (PTY io records) avoid
 * base64-encoding the payload into the JSON body — a ~33% size saving plus
 * one fewer copy on each side. Receivers read the JSON first (for routing
 * metadata) and then treat `binary` as the actual payload.
 */
export function encodeFrame(
  data: unknown,
  binary?: Uint8Array<ArrayBufferLike> | null,
): Uint8Array {
  const json = encoder.encode(JSON.stringify(data));
  const binLen = binary?.byteLength ?? 0;
  const frame = new Uint8Array(HEADER_SIZE + json.byteLength + binLen);
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.byteLength);
  view.setUint32(4, binLen);
  frame.set(json, HEADER_SIZE);
  if (binary && binLen > 0) {
    frame.set(binary, HEADER_SIZE + json.byteLength);
  }
  return frame;
}

export class FrameDecoder {
  // ArrayBufferLike (vs the stricter default ArrayBuffer) so that incoming
  // chunks backed by SharedArrayBuffer or Buffer are assignable without a
  // copy — the decode path only reads, it never resizes or transfers.
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  /**
   * Consume a chunk of bytes. Returns every complete frame the chunk (plus
   * any carried-over tail) contains. Each frame is `{ data, binary }` where
   * `binary` is `null` unless the sender attached a binary sidecar.
   */
  decode(chunk: Uint8Array<ArrayBufferLike>): DecodedFrame[] {
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

    const results: DecodedFrame[] = [];

    while (this.buf.byteLength >= HEADER_SIZE) {
      const view = new DataView(
        this.buf.buffer,
        this.buf.byteOffset,
        this.buf.byteLength,
      );
      const jsonLen = view.getUint32(0);
      const binLen = view.getUint32(4);
      const totalLen = HEADER_SIZE + jsonLen + binLen;

      // H1: Reject oversized frames immediately so a poison header (e.g.
      // binLen=0xFFFFFFFF) cannot cause unbounded buffer growth / OOM.
      // This is an unrecoverable protocol violation — throw so the caller
      // tears down the connection rather than leaving the decoder wedged.
      if (jsonLen + binLen > MAX_FRAME_SIZE) {
        throw new Error(
          `Frame too large: ${jsonLen + binLen} bytes exceeds max ${MAX_FRAME_SIZE}`,
        );
      }

      if (this.buf.byteLength < totalLen) break;

      const json = decoder.decode(
        this.buf.subarray(HEADER_SIZE, HEADER_SIZE + jsonLen),
      );
      let binary: Uint8Array<ArrayBufferLike> | null = null;
      if (binLen > 0) {
        // Detach the binary slice so the caller can safely hold onto it past
        // the next decode() — otherwise a later `new Uint8Array(this.buf)`
        // would only copy the tail, leaving this view aliased to a chunk
        // buffer the caller owns.
        const start = HEADER_SIZE + jsonLen;
        binary = new Uint8Array(
          this.buf.subarray(start, start + binLen).slice().buffer,
        );
      }

      // M1: JSON.parse throws on malformed/empty JSON — advance buf past the
      // frame first so the decoder is not permanently wedged on re-entry, then
      // re-throw so the caller tears down the connection (consistent with H1).
      this.buf = this.buf.subarray(totalLen);
      results.push({ data: JSON.parse(json), binary });
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
