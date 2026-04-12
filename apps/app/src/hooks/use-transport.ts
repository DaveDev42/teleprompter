import type { TransportClient } from "../lib/transport";
import { getRelayClient } from "./use-relay";

/**
 * Returns the active transport client for frontend↔daemon communication.
 * Always relay — direct WS connections violate Architecture Invariants.
 */
export function getTransport(): TransportClient | null {
  return getRelayClient() ?? null;
}
