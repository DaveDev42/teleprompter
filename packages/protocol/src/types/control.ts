/**
 * Control-plane messages exchanged over the E2EE relay data channel
 * on the RELAY_CHANNEL_CONTROL virtual session. These are ciphertext
 * payloads inside `relay.pub` frames — the relay never sees them
 * in plaintext.
 */

import type { Label } from "./label";

export const CONTROL_UNPAIR = "control.unpair" as const;

export interface ControlUnpair {
  t: typeof CONTROL_UNPAIR;
  /**
   * Daemon ID that this pairing belongs to.
   *
   * Informational only — receivers should trust the transport identity
   * (their own daemon/frontend context), not this field.
   */
  daemonId: string;
  /** Frontend ID of the peer relationship being unpaired */
  frontendId: string;
  /** Why the pairing was removed */
  reason: "user-initiated" | "device-removed" | "rotated";
  /** Sender timestamp (ms) */
  ts: number;
}

export const CONTROL_RENAME = "control.rename" as const;

export interface ControlRename {
  t: typeof CONTROL_RENAME;
  /** Daemon ID of the pairing being renamed */
  daemonId: string;
  /** Frontend ID on the other end of the pairing */
  frontendId: string;
  /**
   * New label as a tagged union: `{ set: true, value }` sets a name,
   * `{ set: false }` is an authoritative clear. On the wire this is the new
   * shape after the protocol bump; a peer that has not advertised protocol
   * v2 still receives the legacy `string` form (`""` = clear), and a reader
   * decodes either shape via `decodeWireLabel`. The field is typed `Label`
   * for new producers/consumers; legacy `string` wire bytes are accepted on
   * read but never asserted at this type.
   */
  label: Label;
  /** Sender timestamp (ms) */
  ts: number;
}

export type ControlMessage = ControlUnpair | ControlRename;
