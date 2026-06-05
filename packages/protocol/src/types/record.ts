export type RecordKind = "io" | "event" | "meta";

/** Canonical set of all valid RecordKind values. Import from here to avoid per-file divergence. */
export const RECORD_KIND_SET: ReadonlySet<RecordKind> = new Set([
  "io",
  "event",
  "meta",
]);

export type Namespace = "claude" | "tp" | "runner" | "daemon";

/** Canonical set of all valid Namespace values. Import from here to avoid per-file divergence. */
export const NAMESPACE_SET: ReadonlySet<Namespace> = new Set([
  "claude",
  "tp",
  "runner",
  "daemon",
]);

export interface Record {
  seq: number;
  kind: RecordKind;
  ts: number;
  ns?: Namespace;
  name?: string;
  payload: Uint8Array;
}
