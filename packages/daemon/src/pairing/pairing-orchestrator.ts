import { createLogger } from "@teleprompter/protocol";
import type { Store } from "../store";
import { RelayClient, type RelayClientConfig } from "../transport/relay-client";
import type { RelayConnectionManager } from "../transport/relay-manager";
import { BeginPairingError } from "./begin-pairing-error";
import { PendingPairing, type PendingPairingResult } from "./pending-pairing";

const log = createLogger("PairingOrchestrator");

/**
 * Dependencies injected into {@link PairingOrchestrator}.
 *
 * The orchestrator owns the pending-pairing state machine (single-slot), but
 * delegates RelayClient construction and promotion to the
 * {@link RelayConnectionManager}. It persists completed pairings via the
 * {@link Store}. It has no knowledge of IPC transport or CLI ownership — the
 * Daemon layer wires `pendingPairingOwner` and IPC message plumbing around
 * this orchestrator.
 */
export interface PairingOrchestratorDeps {
  relayManager: Pick<
    RelayConnectionManager,
    "buildEvents" | "attachHandlers" | "__getFactory" | "registerClient"
  >;
  store: Pick<Store, "listPairings" | "savePairing">;
}

/**
 * Orchestrates the pending→completed pairing lifecycle.
 *
 * Lifecycle:
 *   begin() → (frontend joins via relay) → awaitPending() resolves
 *     → promote(result) persists + hands RelayClient to the pool
 *   begin() → cancel() → awaitPending() resolves with `cancelled`
 *
 * Single-slot invariant: only one pending pairing per orchestrator at a time.
 * Calling `begin()` while another is pending throws `BeginPairingError(
 * "already-pending")`.
 */
export class PairingOrchestrator {
  private readonly deps: PairingOrchestratorDeps;
  private pending: PendingPairing | null = null;

  constructor(deps: PairingOrchestratorDeps) {
    this.deps = deps;
  }

  /** True if there is a pending pairing. Used by the Daemon layer to guard
   * ownership bookkeeping. */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * The current pending pairing (or `null`). Exposed so the Daemon can
   * surface it via its own `pendingPairing` getter for back-compat with
   * tests that introspect daemon state directly.
   */
  get current(): PendingPairing | null {
    return this.pending;
  }

  /**
   * Start a new pending pairing. Exactly one pending pairing at a time.
   * Throws `BeginPairingError` on error — the IPC layer converts this into
   * an `IpcPairBeginErr`.
   */
  async begin(args: {
    relayUrl: string;
    daemonId?: string;
    label?: string | null;
  }): Promise<{ pairingId: string; qrString: string; daemonId: string }> {
    if (this.pending) {
      throw new BeginPairingError("already-pending");
    }

    const daemonId = args.daemonId ?? `daemon-${Date.now().toString(36)}`;

    if (this.deps.store.listPairings().some((p) => p.daemonId === daemonId)) {
      throw new BeginPairingError("daemon-id-taken");
    }

    let relayRef: RelayClient | null = null;
    const events = this.deps.relayManager.buildEvents(() => relayRef);
    const pp = new PendingPairing({
      relayUrl: args.relayUrl,
      daemonId,
      label: args.label ?? null,
      createRelayClient: (cfg) => {
        const factory = this.deps.relayManager.__getFactory();
        if (factory) {
          // Test path — factory provides a fake; ignore wrapped events.
          const client = factory(cfg as RelayClientConfig);
          relayRef = client;
          this.deps.relayManager.attachHandlers(client, daemonId);
          return client;
        }
        const wrappedEvents = {
          ...events,
          onFrontendJoined: (frontendId: string) => {
            events.onFrontendJoined?.(frontendId);
            pp.__markCompleted(frontendId);
          },
        };
        const client = new RelayClient(cfg as RelayClientConfig, wrappedEvents);
        relayRef = client;
        this.deps.relayManager.attachHandlers(client, daemonId);
        return client;
      },
    });

    // Reserve the slot synchronously before any async work so no concurrent
    // `begin` can slip in while relay.connect() is in-flight.
    this.pending = pp;

    try {
      const info = await pp.begin();
      return info;
    } catch (err) {
      pp.cancel();
      if (this.pending === pp) this.pending = null;
      throw new BeginPairingError(
        "relay-unreachable",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Returns the awaitCompletion promise, or `null` if no pending pairing. */
  awaitPending(): Promise<PendingPairingResult> | null {
    return this.pending?.awaitCompletion() ?? null;
  }

  /**
   * Cancel the current pending pairing (no-op if none or if `pairingId`
   * mismatches). Also a no-op if the pairing has already completed — the
   * promote path is about to run and must not be disrupted.
   */
  cancel(pairingId?: string): void {
    if (!this.pending) return;
    if (pairingId && this.pending.pairingId !== pairingId) return;
    if (this.pending.completed) return; // race: promote is about to run
    this.pending.cancel();
    this.pending = null;
  }

  /**
   * Persist a completed pending pairing and hand off its RelayClient to the
   * relay manager's pool. Call this after `awaitPending()` resolves with
   * `{ kind: "completed" }`.
   */
  promote(result: PendingPairingResult & { kind: "completed" }): void {
    this.deps.store.savePairing({
      daemonId: result.daemonId,
      relayUrl: result.relayUrl,
      relayToken: result.relayToken,
      registrationProof: result.registrationProof,
      publicKey: result.keyPair.publicKey,
      secretKey: result.keyPair.secretKey,
      pairingSecret: result.pairingSecret,
      label: result.label,
    });
    const pp = this.pending;
    if (pp) {
      const relay = pp.releaseRelay();
      if (relay) this.deps.relayManager.registerClient(relay);
    }
    this.pending = null;
  }

  /**
   * Defensive: clear the pending slot without running cancel/promote.
   * Used when `promote()` fails partway — the caller has already logged /
   * reported the failure and needs the slot freed so subsequent `begin()`
   * can proceed. If the pending still owns a RelayClient (e.g. `promote()`
   * threw before `releaseRelay()`), dispose it explicitly so it does not
   * leak outside the manager's pool.
   */
  clearPending(): void {
    const pp = this.pending;
    this.pending = null;
    if (!pp) return;
    const relay = pp.releaseRelay();
    if (relay) {
      try {
        relay.dispose();
      } catch (err) {
        log.warn(`orphan relay dispose during clearPending failed: ${err}`);
      }
    }
  }

  /**
   * Dispose of any in-flight pending pairing. Called during daemon shutdown.
   * A pending pairing would otherwise leave its RelayClient dangling.
   */
  stop(): void {
    if (!this.pending) return;
    try {
      this.pending.cancel();
    } catch (err) {
      log.warn(`pending-pairing cancel during stop() failed: ${String(err)}`);
    }
    this.pending = null;
  }
}
