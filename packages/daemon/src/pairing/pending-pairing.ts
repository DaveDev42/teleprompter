import {
  createLogger,
  createPairingBundle,
  deriveRegistrationProof,
  encodePairingData,
  type KeyPair,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
} from "@teleprompter/protocol";
import type { RelayClient } from "../transport/relay-client";

const log = createLogger("PendingPairing");

/**
 * Arguments to construct a PendingPairing.
 *
 * `createRelayClient` is a factory so the daemon (and tests) can inject
 * a real RelayClient or a fake. Real factory returns `new RelayClient(cfg, events)`
 * where events wire `onFrontendJoined` → `pendingPairing.__markCompleted(frontendId)`.
 */
export interface PendingPairingOptions {
  relayUrl: string;
  daemonId: string;
  /** Optional label; `null` means "no label". */
  label: string | null;
  createRelayClient: (args: {
    relayUrl: string;
    daemonId: string;
    token: string;
    registrationProof: string;
    keyPair: KeyPair;
    pairingSecret: Uint8Array;
    label: string | null;
  }) => RelayClient;
}

/**
 * Outcome of a pending pairing, delivered via `awaitCompletion`.
 * - `completed` carries the material the daemon needs to persist the pairing
 *   (savePairing) and keep the RelayClient alive.
 * - `cancelled` is emitted after `cancel()` (user Ctrl+C, CLI disconnect, etc.).
 */
export type PendingPairingResult =
  | {
      kind: "completed";
      frontendId: string;
      daemonId: string;
      relayUrl: string;
      relayToken: string;
      registrationProof: string;
      keyPair: KeyPair;
      pairingSecret: Uint8Array;
      label: string | null;
    }
  | { kind: "cancelled" };

/**
 * Lifecycle:
 *   new → begin() → awaitCompletion() → { completed | cancelled }
 * After `completed`, the caller (daemon) calls `releaseRelay()` to take
 * ownership of the RelayClient — the PendingPairing will not dispose it.
 * After `cancelled`, the RelayClient is disposed here.
 */
export class PendingPairing {
  readonly pairingId: string;
  private readonly opts: PendingPairingOptions;
  private relay: RelayClient | null = null;
  private keyPair: KeyPair | null = null;
  private pairingSecret: Uint8Array | null = null;
  private relayToken = "";
  private registrationProof = "";
  private qrString = "";
  private settle: ((r: PendingPairingResult) => void) | null = null;
  private settled = false;
  private resolved: PendingPairingResult | null = null;

  constructor(opts: PendingPairingOptions) {
    this.opts = opts;
    this.pairingId = `pp-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  async begin(): Promise<{
    pairingId: string;
    qrString: string;
    daemonId: string;
  }> {
    const bundle = await createPairingBundle(
      this.opts.relayUrl,
      this.opts.daemonId,
      { label: this.opts.label ?? undefined },
    );
    this.keyPair = bundle.keyPair;
    this.pairingSecret = bundle.pairingSecret;
    this.relayToken = bundle.relayToken;
    this.registrationProof = await deriveRegistrationProof(
      bundle.pairingSecret,
    );
    this.qrString = encodePairingData(bundle.qrData);

    this.relay = this.opts.createRelayClient({
      relayUrl: this.opts.relayUrl,
      daemonId: this.opts.daemonId,
      token: this.relayToken,
      registrationProof: this.registrationProof,
      keyPair: this.keyPair,
      pairingSecret: this.pairingSecret,
      label: this.opts.label,
    });

    await this.relay.connect();
    this.relay.subscribe(RELAY_CHANNEL_META);
    this.relay.subscribe(RELAY_CHANNEL_CONTROL);

    return {
      pairingId: this.pairingId,
      qrString: this.qrString,
      daemonId: this.opts.daemonId,
    };
  }

  awaitCompletion(): Promise<PendingPairingResult> {
    if (this.resolved !== null) {
      return Promise.resolve(this.resolved);
    }
    if (this.settle !== null) {
      throw new Error("awaitCompletion() called twice");
    }
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /**
   * Called by the daemon's RelayClient `onFrontendJoined` hook once the frontend
   * has completed ECDH key exchange. Idempotent — later frontends joining the
   * same pending pairing are ignored (the pairing is already resolved).
   */
  __markCompleted(frontendId: string): void {
    if (this.settled) return;
    if (!this.keyPair || !this.pairingSecret) return;
    this.settled = true;
    log.info(`pairing ${this.pairingId} completed with frontend ${frontendId}`);
    this.resolved = {
      kind: "completed",
      frontendId,
      daemonId: this.opts.daemonId,
      relayUrl: this.opts.relayUrl,
      relayToken: this.relayToken,
      registrationProof: this.registrationProof,
      keyPair: this.keyPair,
      pairingSecret: this.pairingSecret,
      label: this.opts.label,
    };
    this.settle?.(this.resolved);
  }

  /** Returns true if the pairing has already resolved with `completed`. */
  get completed(): boolean {
    return this.resolved?.kind === "completed";
  }

  /** User Ctrl+C or CLI disconnect: dispose the relay and resolve with `cancelled`. */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.relay?.dispose();
    this.relay = null;
    log.info(`pairing ${this.pairingId} cancelled`);
    this.resolved = { kind: "cancelled" };
    this.settle?.(this.resolved);
  }

  /**
   * Hand off the RelayClient to the daemon on successful completion. Returns
   * `null` if already released or never started, so callers that run after
   * `cancel()` / a previous `releaseRelay()` can idempotently handle both
   * cases.
   */
  releaseRelay(): RelayClient | null {
    const c = this.relay;
    this.relay = null;
    return c;
  }
}
