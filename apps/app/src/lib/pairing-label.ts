import type { PairingInfo } from "../stores/pairing-store";

/**
 * The label string to show for a pairing, or `undefined` when it has none.
 * `info.label.value` is already trimmed by `makeLabel`, so callers fall back
 * to the daemon-id prefix on `undefined`.
 */
export function labelValueOf(info: PairingInfo): string | undefined {
  return info.label.set ? info.label.value : undefined;
}
