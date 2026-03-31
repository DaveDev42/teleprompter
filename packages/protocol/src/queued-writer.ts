interface Writable {
  write(data: Uint8Array): number;
}

export class QueuedWriter {
  private queue: Uint8Array[] = [];

  write(socket: Writable, data: Uint8Array): boolean {
    if (this.queue.length > 0) {
      this.queue.push(data);
      return false;
    }

    const written = socket.write(data);
    if (written === 0) {
      this.queue.push(data);
      return false;
    }
    if (written < data.byteLength) {
      this.queue.push(data.subarray(written));
      return false;
    }
    return true;
  }

  drain(socket: Writable): boolean {
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      if (!chunk) break;
      const written = socket.write(chunk);
      if (written === 0) return false;
      if (written < chunk.byteLength) {
        this.queue[0] = chunk.subarray(written);
        return false;
      }
      this.queue.shift();
    }
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }
}
