import type {
  IpcRec,
  HookEventBase,
  Namespace,
} from "@teleprompter/protocol";

/**
 * Converts PTY data and hook events into IpcRec messages.
 */
export class Collector {
  private sid: string;

  constructor(sid: string) {
    this.sid = sid;
  }

  /** Convert raw PTY output to an IPC record */
  ioRecord(data: Uint8Array): IpcRec {
    return {
      t: "rec",
      sid: this.sid,
      kind: "io",
      ts: Date.now(),
      payload: Buffer.from(data).toString("base64"),
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
