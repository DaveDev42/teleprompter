import type { ToastData } from "../stores/notification-store";

/** Minimal shape of an expo-notifications notification content we read. */
export interface PushContent {
  title?: string | null;
  body?: string | null;
  data?: unknown;
}

/**
 * Decide whether a foreground push should surface as an in-app toast, and
 * build the toast payload if so. Pure (no react-native / expo / router /
 * store imports) so it can be unit-tested under bun:test without dragging in
 * the native module graph.
 *
 * Returns null when the toast should be suppressed — currently only when the
 * user is already viewing the target session (`currentSid`), mirroring the
 * relay.notification in-band path in use-relay.ts so both delivery routes
 * behave identically. Title/body fall back to generic copy so a malformed
 * push never produces a blank toast. The navigation `data` is included only
 * when all three fields are present (the daemon always fills daemonId in
 * sendPush, so a partial payload means it didn't originate from our push
 * path and isn't safely routable).
 */
export function resolveForegroundToast(
  content: PushContent,
  currentSid: string | null,
): ToastData | null {
  const data = content.data as
    | { sid?: string; daemonId?: string; event?: string }
    | undefined;
  if (data?.sid && data.sid === currentSid) return null;
  return {
    title: content.title ?? "Claude needs attention",
    body: content.body ?? "Tap to open the session",
    data:
      data?.sid && data.daemonId && data.event
        ? { sid: data.sid, daemonId: data.daemonId, event: data.event }
        : undefined,
  };
}
