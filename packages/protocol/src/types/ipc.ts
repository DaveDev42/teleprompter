import type { RecordKind, Namespace } from "./record";

export interface IpcHello {
  t: "hello";
  sid: string;
  cwd: string;
  worktreePath?: string;
  claudeVersion?: string;
  pid: number;
}

export interface IpcRec {
  t: "rec";
  sid: string;
  kind: RecordKind;
  ts: number;
  ns?: Namespace;
  name?: string;
  payload: string; // base64
}

export interface IpcBye {
  t: "bye";
  sid: string;
  exitCode: number;
}

export interface IpcAck {
  t: "ack";
  sid: string;
  seq: number;
}

export interface IpcInput {
  t: "input";
  sid: string;
  data: string; // base64
}

export interface IpcResize {
  t: "resize";
  sid: string;
  cols: number;
  rows: number;
}

export type IpcMessage = IpcHello | IpcRec | IpcBye | IpcAck | IpcInput | IpcResize;
