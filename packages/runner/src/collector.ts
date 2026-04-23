import type { HookEventBase, IpcRec, Namespace } from "@teleprompter/protocol";

export interface IoFrame {
  msg: IpcRec;
  binary: Uint8Array<ArrayBufferLike>;
}

/**
 * Converts PTY data and hook events into IpcRec messages.
 */
export class Collector {
  private sid: string;

  constructor(sid: string) {
    this.sid = sid;
  }

  /**
   * Convert raw PTY output to an IPC record. The bytes ride as a binary
   * sidecar in the frame — `msg.payload` stays empty — so we skip the
   * ~33% base64 overhead on the hot path. The receiver recognises the
   * sidecar via the FrameDecoder's `binary` field.
   */
  ioRecord(data: Uint8Array<ArrayBufferLike>): IoFrame {
    return {
      msg: {
        t: "rec",
        sid: this.sid,
        kind: "io",
        ts: Date.now(),
        payload: "",
      },
      binary: data,
    };
  }

  /** Convert a hook event to an IPC record */
  eventRecord(event: HookEventBase): IpcRec {
    const payload = Buffer.from(JSON.stringify(event)).toString("base64");
    return {
      t: "rec",
      sid: this.sid,
      kind: "event",
      ts: Date.now(),
      ns: "claude" as Namespace,
      name: event.hook_event_name,
      payload,
    };
  }

  /** Create a teleprompter-internal event (tp namespace, dot notation) */
  tpEvent(name: string, data: unknown): IpcRec {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64");
    return {
      t: "rec",
      sid: this.sid,
      kind: "event",
      ts: Date.now(),
      ns: "tp" as Namespace,
      name,
      payload,
    };
  }

  /** Create a meta record */
  metaRecord(name: string, data: unknown): IpcRec {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64");
    return {
      t: "rec",
      sid: this.sid,
      kind: "meta",
      ts: Date.now(),
      ns: "runner" as Namespace,
      name,
      payload,
    };
  }
}
