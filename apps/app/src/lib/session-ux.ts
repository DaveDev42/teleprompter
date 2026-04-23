import type {
  SessionState,
  WsSessionMeta,
} from "@teleprompter/protocol/client";

/** Canonical "live" session state. Any other value is treated as read-only. */
const RUNNING = "running" satisfies SessionState;

/**
 * A session is considered stopped when its state is anything other than
 * "running". An undefined session (metadata hasn't arrived yet) is NOT
 * treated as stopped — callers should default to the optimistic path so the
 * UI doesn't flicker into read-only mode on initial load.
 */
export function isSessionStopped(session: WsSessionMeta | undefined): boolean {
  return !!session && session.state !== RUNNING;
}

/** Inverse of {@link isSessionStopped}, preserving the undefined-is-not-stopped convention. */
export function isSessionRunning(session: WsSessionMeta | undefined): boolean {
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
  session: WsSessionMeta | undefined,
  connected: boolean,
  sid: string | null | undefined,
): { isEditable: boolean; canSend: boolean } {
  const stopped = isSessionStopped(session);
  return {
    isEditable: !stopped,
    canSend: connected && !!sid && !stopped,
  };
}
