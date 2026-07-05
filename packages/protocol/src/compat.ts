/**
 * Version compatibility checking.
 *
 * Tracks which Claude Code versions are known to work with
 * the current teleprompter version. Warns on unknown versions.
 */

/** Minimum Claude CLI version known to work */
export const MIN_CLAUDE_VERSION = "1.0.0";

/** Protocol version for cross-component compatibility */
export const PROTOCOL_VERSION = 1;

/**
 * Relay protocol version.
 * Sent in relay.auth as optional `v` field.
 * Old clients (v < 1) omit this field — relay must handle gracefully.
 */
export const RELAY_PROTOCOL_VERSION = 1;

/**
 * IPC protocol version (Runner ↔ Daemon, and CLI ↔ Daemon).
 * Runner and Daemon are always deployed together (same tp binary),
 * so this is for documentation, not runtime checking.
 *
 * v2: pairing `label` on the IPC pair.* messages migrated from
 * `string | null` (with `""` clear sentinel) to the `Label` tagged union.
 */
export const IPC_PROTOCOL_VERSION = 2;

/**
 * WS protocol version (Daemon ↔ App).
 * App may be an older version (App Store update delay).
 * New optional fields are always safe. New message types are ignored by old apps.
 *
 * v2: pairing `label` on the ControlRename / kx-hello / meta-hello wire
 * surfaces migrated from `string | null` (with `""` clear sentinel) to the
 * `Label` tagged union. Daemons and apps advertise this version in the
 * relay.kx payload (`v`). As of ADR-0003 Amendment 1 (A1.3#1) the per-peer
 * label version-gate has been removed: ControlRename always emits the union
 * object.
 *
 * v3: pairing confirmation (PCT) + QR v4 (pairing redesign #49). A v3 daemon
 * carries a per-frontend `pct` on the `hello` frame and QR bundles gain a
 * random-UUID `pairingId` + `hostname` (wire v4). The app reads the advertised
 * `v` into `effectiveV = max(this epoch's v, persisted minAdvertisedV floor)`
 * and drives the §1.3 promotion table: v≥3 + matching `pct` → confirmed commit;
 * v≥3 + absent/mismatched `pct` → FAILED; effectiveV<3 → legacy commit. No hard
 * handshake gate is needed — `pct` is additive-optional (old apps ignore it, old
 * daemons omit it) and the promotion table (effectiveV + floor) is the sole
 * discriminator (design v3 §5 / §G). Both the daemon (`relay-client.ts`
 * `broadcastDaemonPublicKey`) and the app (`RelayProtocol.version`) advertise
 * this value; bumping it here is what flips the advertised `v` to 3 and, on a
 * new-daemon+new-app pair, turns on the confirm path.
 */
export const WS_PROTOCOL_VERSION = 3;

/**
 * Parse a semver-like version string into components.
 */
export function parseVersion(
  v: string,
): { major: number; minor: number; patch: number } | null {
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [, maj, min, pat] = match;
  if (maj === undefined || min === undefined || pat === undefined) return null;
  return {
    major: parseInt(maj, 10),
    minor: parseInt(min, 10),
    patch: parseInt(pat, 10),
  };
}

/**
 * Check if a Claude CLI version is compatible.
 * Returns a warning message if potentially incompatible, null if OK.
 */
export function checkClaudeVersion(version: string): string | null {
  const parsed = parseVersion(version);
  if (!parsed) return `Unknown Claude version format: ${version}`;

  const min = parseVersion(MIN_CLAUDE_VERSION);
  if (!min) return `Invalid MIN_CLAUDE_VERSION: ${MIN_CLAUDE_VERSION}`;
  if (
    parsed.major < min.major ||
    (parsed.major === min.major && parsed.minor < min.minor) ||
    (parsed.major === min.major &&
      parsed.minor === min.minor &&
      parsed.patch < min.patch)
  ) {
    return `Claude ${version} may be too old. Minimum recommended: ${MIN_CLAUDE_VERSION}`;
  }

  return null;
}
