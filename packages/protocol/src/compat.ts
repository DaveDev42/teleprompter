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
 * IPC protocol version (Runner ↔ Daemon).
 * Runner and Daemon are always deployed together (same tp binary),
 * so this is for documentation, not runtime checking.
 */
export const IPC_PROTOCOL_VERSION = 1;

/**
 * WS protocol version (Daemon ↔ App).
 * App may be an older version (App Store update delay).
 * New optional fields are always safe. New message types are ignored by old apps.
 */
export const WS_PROTOCOL_VERSION = 1;

/**
 * Parse a semver-like version string into components.
 */
export function parseVersion(v: string): { major: number; minor: number; patch: number } | null {
  const match = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Check if a Claude CLI version is compatible.
 * Returns a warning message if potentially incompatible, null if OK.
 */
export function checkClaudeVersion(version: string): string | null {
  const parsed = parseVersion(version);
  if (!parsed) return `Unknown Claude version format: ${version}`;

  const min = parseVersion(MIN_CLAUDE_VERSION)!;
  if (parsed.major < min.major || (parsed.major === min.major && parsed.minor < min.minor)) {
    return `Claude ${version} may be too old. Minimum recommended: ${MIN_CLAUDE_VERSION}`;
  }

  return null;
}
