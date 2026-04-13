/**
 * Control-plane messages exchanged over the E2EE relay data channel
 * on the RELAY_CHANNEL_CONTROL virtual session. These are ciphertext
 * payloads inside `relay.pub` frames — the relay never sees them
 * in plaintext.
 */

export const CONTROL_UNPAIR = "control.unpair" as const;

export interface ControlUnpair {
  t: typeof CONTROL_UNPAIR;
  /** Daemon ID that this pairing belongs to */
  daemonId: string;
  /** Frontend ID of the peer relationship being unpaired */
  frontendId: string;
  /** Why the pairing was removed */
  reason: "user-initiated" | "device-removed" | "rotated";
  /** Sender timestamp (ms) */
  ts: number;
}

export type ControlMessage = ControlUnpair;
