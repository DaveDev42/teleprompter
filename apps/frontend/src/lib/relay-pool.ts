/**
 * Relay connection pool with failover.
 *
 * Manages multiple relay endpoints. Connects to the primary relay,
 * and automatically fails over to the next active relay on disconnect.
 * Also supports round-robin session routing (future).
 */

import {
  FrontendRelayClient,
  type FrontendRelayConfig,
  type FrontendRelayEvents,
} from "./relay-client";
import type { RelayEndpoint } from "../stores/relay-settings-store";
import type { KeyPair } from "@teleprompter/protocol/client";

const FAILOVER_DELAY_MS = 2000;

export interface RelayPoolConfig {
  daemonId: string;
  token: string;
  keyPair: KeyPair;
  daemonPublicKey: Uint8Array;
}

export interface RelayPoolEvents extends FrontendRelayEvents {
  /** Called when failover occurs */
  onFailover?: (fromUrl: string, toUrl: string) => void;
  /** Called when all relays are exhausted */
  onAllFailed?: () => void;
}

export class RelayPool {
  private endpoints: RelayEndpoint[] = [];
  private config: RelayPoolConfig;
  private events: RelayPoolEvents;
  private currentClient: FrontendRelayClient | null = null;
  private currentIndex = 0;
  private disposed = false;
  private failoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RelayPoolConfig, events: RelayPoolEvents = {}) {
    this.config = config;
    this.events = events;
  }

  /**
   * Set the list of relay endpoints.
   * Only active endpoints are used for connection.
   */
  setEndpoints(endpoints: RelayEndpoint[]): void {
    this.endpoints = endpoints.filter((e) => e.active);
  }

  /**
   * Connect to the first available relay.
   */
  async connect(): Promise<void> {
    if (this.disposed || this.endpoints.length === 0) return;
    this.currentIndex = 0;
    await this.connectToIndex(0);
  }

  private async connectToIndex(index: number): Promise<void> {
    if (this.disposed || index >= this.endpoints.length) {
      this.events.onAllFailed?.();
      return;
    }

    this.currentIndex = index;
    const endpoint = this.endpoints[index];

    // Dispose previous client
    this.currentClient?.dispose();

    const client = new FrontendRelayClient(
      {
        relayUrl: endpoint.url,
        daemonId: this.config.daemonId,
        token: this.config.token,
        keyPair: this.config.keyPair,
        daemonPublicKey: this.config.daemonPublicKey,
      },
      {
        onRecord: this.events.onRecord,
        onState: this.events.onState,
        onPresence: this.events.onPresence,
        onConnected: () => {
          this.events.onConnected?.();
        },
        onDisconnected: () => {
          this.events.onDisconnected?.();
          // Attempt failover to next relay
          if (!this.disposed) {
            this.scheduleFailover(endpoint.url);
          }
        },
      },
    );

    this.currentClient = client;
    await client.connect();
  }

  private scheduleFailover(failedUrl: string): void {
    if (this.failoverTimer) clearTimeout(this.failoverTimer);

    this.failoverTimer = setTimeout(async () => {
      const nextIndex = (this.currentIndex + 1) % this.endpoints.length;

      // If we've tried all endpoints, signal failure
      if (nextIndex === 0 && this.endpoints.length > 1) {
        // Full rotation — try from the beginning again
        // The individual relay client's reconnect logic handles retries
        // to the same endpoint. We only failover when a connection
        // completely fails after all reconnect attempts.
      }

      if (nextIndex < this.endpoints.length) {
        const nextUrl = this.endpoints[nextIndex].url;
        this.events.onFailover?.(failedUrl, nextUrl);
        await this.connectToIndex(nextIndex);
      }
    }, FAILOVER_DELAY_MS);
  }

  /**
   * Send chat input via the currently connected relay.
   */
  async sendChat(sid: string, text: string): Promise<void> {
    await this.currentClient?.sendChat(sid, text);
  }

  /**
   * Send terminal input via the currently connected relay.
   */
  async sendTermInput(sid: string, data: string): Promise<void> {
    await this.currentClient?.sendTermInput(sid, data);
  }

  /**
   * Subscribe to a session on the current relay.
   */
  subscribe(sid: string): void {
    this.currentClient?.subscribe(sid);
  }

  /**
   * Unsubscribe from a session.
   */
  unsubscribe(sid: string): void {
    this.currentClient?.unsubscribe(sid);
  }

  /**
   * Get the currently connected relay URL.
   */
  getCurrentUrl(): string | null {
    if (this.currentIndex < this.endpoints.length) {
      return this.endpoints[this.currentIndex].url;
    }
    return null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.failoverTimer) {
      clearTimeout(this.failoverTimer);
      this.failoverTimer = null;
    }
    this.currentClient?.dispose();
    this.currentClient = null;
  }
}
