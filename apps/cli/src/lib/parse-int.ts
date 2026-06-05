/**
 * Parse a strictly-positive integer from a raw CLI string.
 *
 * Rejects:
 *  - trailing garbage ("0abc") — parseInt is too lenient; we require the whole
 *    string to be a base-10 integer so a bad flag like `--cache-size 0abc` is
 *    rejected instead of silently accepted as 0.
 *  - zero and negative values — port 0, cache-size 0, and max-frame-size 0 are
 *    all nonsensical for relay flags; a negative port / zero cache are invalid
 *    and passing them through would produce silent misconfigurations.
 *
 * Kept in its own file (no RelayServer import) so unit tests can import it
 * without pulling in the relay package.
 */
export function parseFiniteInt(raw: string): number {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new Error(`Invalid integer value: '${raw}'`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer value: '${raw}'`);
  if (n <= 0) throw new Error(`Value must be a positive integer: '${raw}'`);
  return n;
}
