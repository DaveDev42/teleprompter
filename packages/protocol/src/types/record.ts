export type RecordKind = "io" | "event" | "meta";

export type Namespace = "claude" | "tp" | "runner" | "daemon";

export interface Record {
  seq: number;
  kind: RecordKind;
  ts: number;
  ns?: Namespace;
  name?: string;
  payload: Uint8Array;
}
