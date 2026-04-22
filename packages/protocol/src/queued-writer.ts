import { createLogger } from "./logger";

interface Writable {
  write(data: Uint8Array): number;
}

/** 8 MiB. Long-running daemons holding unbounded queues are the OOM path. */
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;

const log = createLogger("QueuedWriter");

export interface QueuedWriterOptions {
  /**
   * Soft cap on bytes held in the deferred-write queue. Once exceeded,
   * further `write()` calls drop their payload and return `false` — the
   * caller must treat this as a hard error (close the socket, etc.) rather
   * than silent backpressure. Defaults to 8 MiB.
   */
  maxQueuedBytes?: number;
}

export class QueuedWriter {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private readonly maxQueuedBytes: number;
  private overflowed = false;

  constructor(opts: QueuedWriterOptions = {}) {
    this.maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  }

  /**
   * True once the queue has exceeded `maxQueuedBytes`. Callers should close
   * the underlying transport when this flips — continuing to queue would
   * consume memory without progress.
   */
  get isOverflowed(): boolean {
    return this.overflowed;
  }

  write(socket: Writable, data: Uint8Array): boolean {
    if (this.overflowed) return false;

    if (this.queue.length > 0) {
      return this.enqueue(data);
    }

    const written = socket.write(data);
    if (written === 0) {
      return this.enqueue(data);
    }
    if (written < data.byteLength) {
      return this.enqueue(data.subarray(written));
    }
    return true;
  }

  private enqueue(chunk: Uint8Array): boolean {
    if (this.queuedBytes + chunk.byteLength > this.maxQueuedBytes) {
      this.overflowed = true;
      log.warn(
        `queue overflow: ${this.queuedBytes + chunk.byteLength} bytes exceeds cap ${this.maxQueuedBytes}; dropping`,
      );
      return false;
    }
    this.queue.push(chunk);
    this.queuedBytes += chunk.byteLength;
    return false;
  }

  drain(socket: Writable): boolean {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      if (!chunk) break;
      const written = socket.write(chunk);
      if (written === 0) return false;
      if (written < chunk.byteLength) {
        this.queue[0] = chunk.subarray(written);
        this.queuedBytes -= written;
        return false;
      }
      this.queue.shift();
      this.queuedBytes -= chunk.byteLength;
    }
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }
}
