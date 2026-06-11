import type { SessionMeta, SessionState } from "@teleprompter/protocol/client";

/** Canonical "live" session state. Any other value is treated as read-only. */
const RUNNING = "running" satisfies SessionState;

/**
 * Format a millisecond timestamp as a human-readable relative time string.
 * Resolution: "just now" → Xm ago → Xh ago → Xd ago.
 *
 * Pure function — no side effects, no React dependency. Centralised here so
 * the session list and daemon list screens don't duplicate the logic.
 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * A session is considered stopped when its state is anything other than
 * "running". An undefined session (metadata hasn't arrived yet) is NOT
 * treated as stopped — callers should default to the optimistic path so the
 * UI doesn't flicker into read-only mode on initial load.
 */
export function isSessionStopped(session: SessionMeta | undefined): boolean {
  return !!session && session.state !== RUNNING;
}

/** Inverse of {@link isSessionStopped}, preserving the undefined-is-not-stopped convention. */
export function isSessionRunning(session: SessionMeta | undefined): boolean {
  return !!session && session.state === RUNNING;
}

/**
 * Derive the two input gates used across Chat and Terminal views:
 * - `isEditable`: whether typing / composing is permitted. Only blocks on
 *   stopped so users can pre-compose while reconnecting.
 * - `canSend`: whether any outbound send (chat, voice prompt, terminal
 *   keystroke, terminal resize) is permitted. Requires relay connection,
 *   a known sid, and a non-stopped session.
 */
export function deriveInputGates(
  session: SessionMeta | undefined,
  connected: boolean,
  sid: string | null | undefined,
): { isEditable: boolean; canSend: boolean } {
  const stopped = isSessionStopped(session);
  return {
    isEditable: !stopped,
    canSend: connected && !!sid && !stopped,
  };
}

/**
 * Matches a POSIX home-directory prefix at the start of a path:
 *   - macOS:           /Users/<name>
 *   - Linux:           /home/<name>
 *   - Linux root user: /root
 *
 * The daemon sends `cwd` as an absolute string and does NOT transmit its own
 * home path, so we infer the home prefix from this well-known convention —
 * the same heuristic shells use to render `~` for paths. The capture is the
 * full home prefix (no trailing slash) so the path that follows starts at the
 * separator (or is empty when cwd IS the home directory).
 */
const HOME_PREFIX = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/;

/**
 * Format a session's working directory for display, per the agreed rule:
 *   - A path under the user's home directory is abbreviated with `~`
 *     (`/Users/dave/Projects/x` → `~/Projects/x`, `/Users/dave` → `~`).
 *   - Any other absolute path is shown verbatim (`/tmp/x` → `/tmp/x`).
 *
 * Falls back through cwd → sid → "Session" so a row is never blank. A trailing
 * slash is stripped first so `/Users/dave/proj/` and `/Users/dave/proj` render
 * identically, but a lone `/` is preserved as the filesystem root.
 */
export function formatCwd(cwd: string | undefined, sid?: string): string {
  const raw = (cwd ?? "").trim();
  if (!raw) return sid || "Session";

  // Collapse a trailing slash ("/Users/dave/proj/" → "/Users/dave/proj") but
  // keep a bare root "/" intact.
  const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;

  const m = path.match(HOME_PREFIX);
  if (m) {
    const rest = path.slice(m[0].length); // "" when cwd IS the home dir, else "/sub/dir"
    return rest ? `~${rest}` : "~";
  }

  return path;
}
