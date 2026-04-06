/**
 * Unified transport hook.
 *
 * getTransport() returns the active TransportClient:
 * - When a relay is connected (paired), prefers relay (E2EE)
 * - Otherwise falls back to direct WS (DaemonWsClient)
 *
 * Components should use getTransport() instead of getDaemonClient() or getRelayClient().
 */

import type { TransportClient } from "../lib/transport";
import { getDaemonClient } from "./use-daemon";
import { getRelayClient } from "./use-relay";

/**
 * Get the currently active transport client.
 *
 * Prefers the relay connection when available (E2EE, production).
 * Falls back to direct WS (local dev, E2E tests, no pairing).
 *
 * Note: a non-null return does not guarantee isConnected() — callers
 * should handle the case where the transport is not yet ready.
 */
export function getTransport(): TransportClient | null {
  // Prefer relay when connected (E2EE production path)
  const relay = getRelayClient();
  if (relay?.isConnected()) return relay;

  // Fall back to direct WS (local dev, E2E tests, no pairing)
  const daemon = getDaemonClient();
  if (daemon?.isConnected()) return daemon;

  // Return whichever exists (even if not yet connected)
  return daemon ?? relay;
}
