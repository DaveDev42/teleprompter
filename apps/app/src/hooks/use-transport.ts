/**
 * Unified transport hook.
 *
 * getTransport() returns the active TransportClient:
 * - In __DEV__: prefers direct WS (DaemonWsClient), falls back to relay
 * - In production: uses relay (FrontendRelayClient) only
 *
 * Components should use getTransport() instead of getDaemonClient() or getRelayClient().
 */

import type { TransportClient } from "../lib/transport";
import { getDaemonClient } from "./use-daemon";
import { getRelayClient } from "./use-relay";

/**
 * Get the currently active transport client.
 *
 * In __DEV__ mode, prefers the direct WS connection (lower latency, no encryption overhead).
 * In production, uses the relay connection exclusively (E2EE).
 */
export function getTransport(): TransportClient | null {
  if (__DEV__) {
    // In dev, prefer direct WS if connected; fall back to relay
    const daemon = getDaemonClient();
    if (daemon?.isConnected()) return daemon;
    const relay = getRelayClient();
    if (relay?.isConnected()) return relay;
    // Return whichever exists (even if not yet connected)
    return daemon ?? relay;
  }

  // Production: relay only (useDaemon is disabled, getDaemonClient returns null)
  return getRelayClient();
}
