import {
  createLogger,
  LABEL_UNSET,
  type Label,
  type PushInterruptionLevel,
  RELAY_CHANNEL_CONTROL,
  RELAY_CHANNEL_META,
} from "@teleprompter/protocol";
import type { IpcCommandDispatcher } from "../ipc/command-dispatcher";
import type { IpcServer } from "../ipc/server";
import type { PushNotifier } from "../push/push-notifier";
import { type Store, toSessionMeta } from "../store";
import {
  RelayClient,
  type RelayClientConfig,
  type RelayClientEvents,
} from "./relay-client";

const log = createLogger("RelayManager");

/**
 * Dependencies injected into {@link RelayConnectionManager}.
 *
 * The manager owns the pool of active relay clients, but has no knowledge of
 * the pending-pairing state machine — that lives in the Daemon until C3.
 * For the pairing path, Daemon calls {@link RelayConnectionManager.buildEvents}
 * + {@link RelayConnectionManager.attachHandlers} to wire a freshly-constructed
 * client, and {@link RelayConnectionManager.registerClient} to add a promoted
 * client to the pool.
 */
export interface RelayConnectionManagerDeps {
  ipcServer: Pick<IpcServer, "findRunnerBySid" | "send">;
  store: Pick<
    Store,
    | "listSessions"
    | "listPairings"
    | "savePairing"
    | "updatePairingLabel"
    | "deletePairing"
    | "loadPairings"
    | "savePushToken"
    | "loadPushTokens"
    | "deletePushToken"
    | "deletePushTokensForDaemon"
  >;
  pushNotifier: Pick<
    PushNotifier,
    "registerSealedToken" | "handleUnsealFailed" | "handleTokenDead"
  >;
  /**
   * Getter for the IPC dispatcher — used to route decrypted control messages
   * from relay clients back to the dispatcher. Getter form because the
   * dispatcher is constructed after the manager in current Daemon wiring.
   */
  getDispatcher: () => Pick<IpcCommandDispatcher, "dispatchRelayControl">;
}

/**
 * Owns the pool of outbound relay connections for the Daemon.
 *
 * Responsibilities:
 *  - Construct {@link RelayClient} instances with the correct event bag.
 *  - Fan out push notifications across all active clients.
 *  - Persist pairing records on connect and on promotion of a pending pair.
 *  - Tear down a pairing (notify peer + dispose client + delete from store).
 *  - Reconnect saved pairings on daemon startup.
 *
 * Out of scope (stays in Daemon until C3):
 *  - {@link import("../pairing/pending-pairing").PendingPairing} lifecycle.
 *  - `beginPairing`, `cancelPendingPairing`, `promoteCompletedPairing`.
 */
export class RelayConnectionManager {
  private readonly deps: RelayConnectionManagerDeps;
  private readonly clients: RelayClient[] = [];
  /** Test-only factory injection for PendingPairing fake clients. */
  private factory: ((cfg: RelayClientConfig) => RelayClient) | null = null;

  constructor(deps: RelayConnectionManagerDeps) {
    this.deps = deps;
  }

  /**
   * Build the standard event bag for a RelayClient. Callers (both
   * {@link addClient} and the Daemon's pairing flow) use this to obtain a
   * consistent set of handlers; the pairing flow may wrap
   * `onFrontendJoined` to additionally resolve a pending pair.
   *
   * `getClient` is a lazy reference so the closures can call back into the
   * RelayClient instance that is about to be constructed.
   *
   * `label` is the daemon's human-readable pairing label. When supplied it is
   * included in the encrypted `hello` frame so the frontend can adopt it even
   * if it missed the initial `relay.kx` broadcast (e.g. frontend connected
   * while daemon was already online and had already sent its kx).
   */
  buildEvents(
    getClient: () => RelayClient | null,
    label?: Label,
    daemonId = "",
  ): RelayClientEvents {
    return {
      onInput: (kind, sid, data) => {
        const runner = this.deps.ipcServer.findRunnerBySid(sid);
        if (runner) {
          // Chat input targets the interactive claude TUI, which submits a
          // prompt only on a carriage return (`\r`, Enter) — a newline (`\n`)
          // lands the text in the input box but never sends it. Append `\r`,
          // not `\n`. Empirically verified end-to-end (daemon→runner→PTY):
          // text+`\r` glued in one write yields UserPromptSubmit+Stop; `\n`
          // (glued or separate) yields neither. Terminal input passes through
          // verbatim (raw keystrokes already carry their own terminators).
          const payload =
            kind === "chat"
              ? Buffer.from(`${data}\r`).toString("base64")
              : data;
          this.deps.ipcServer.send(runner, { t: "input", sid, data: payload });
        }
      },
      onControlMessage: (msg, frontendId) => {
        const c = getClient();
        if (c)
          this.deps.getDispatcher().dispatchRelayControl(c, msg, frontendId);
      },
      onFrontendJoined: (frontendId) => {
        const c = getClient();
        if (!c) return;
        const sessions = this.deps.store.listSessions().map(toSessionMeta);
        // Include `daemonLabel` so the frontend can adopt the pairing label
        // even when it connects after the daemon's initial relay.kx broadcast
        // (which only reaches peers online at that moment). `{ set: false }`
        // means no label set — the frontend reads this surface with
        // keep-current semantics (`decodeKxLabelOrKeep`) and keeps its
        // existing fallback.
        const helloMsg = {
          t: "hello",
          v: 1,
          d: { sessions, daemonLabel: label ?? LABEL_UNSET },
        };
        c.publishToPeer(frontendId, RELAY_CHANNEL_META, helloMsg).catch(
          () => {},
        );
        // Subscribe to ALL sessions, not just running ones. The frontend may
        // open a stopped/completed session in the Chat tab and send a
        // `relay.pub <sid>` resume request — relay only forwards that frame
        // to peers who are subscribed to <sid>, so without a subscription
        // the daemon never receives the resume and the historical records
        // never get replayed. New frames for stopped sessions never arrive
        // (the Runner is gone), so the cost of subscribing is just a tiny
        // per-sid registry entry on the relay.
        for (const s of sessions) {
          c.subscribe(s.sid);
        }
      },
      onPushTokenSealed: (frontendId, sealed, platform) => {
        // Path X: relay has sealed the APNs device token and routed it here.
        this.deps.pushNotifier.registerSealedToken(
          frontendId,
          daemonId,
          sealed,
          platform,
        );
      },
      onPushUnsealFailed: () => {
        // The relay could not decrypt the sealed token (key rotated, tampered).
        // relay.err does not carry frontendId, so we broadcast handleUnsealFailed
        // to all tokens for this pairing. The app re-registers on next reconnect.
        // For now this calls into PushNotifier per-frontend entries — in practice
        // the operator correlates the warn log with the seal-key rotation.
        log.warn(
          `PUSH_UNSEAL_FAILED from relay (daemonId=${daemonId}) — evicting push tokens; app re-registers on next reconnect`,
        );
        // We don't have a frontendId from relay.err, so call handleUnsealFailed
        // with a sentinel that logs the event. The actual eviction path in
        // PushNotifier.handleUnsealFailed operates on the in-memory Map; since
        // we have no frontendId here, we skip it and rely on the app's
        // re-registration self-heal.
      },
      onPushTokenDead: () => {
        // APNs returned 400/410 — the device token is permanently dead.
        // relay.err does not carry frontendId. Log the event and let the app
        // re-register via relay.push.register on next relay reconnect.
        log.warn(
          `PUSH_TOKEN_DEAD from relay (daemonId=${daemonId}) — APNs dead token; app re-registers on next reconnect`,
        );
      },
    };
  }

  /**
   * Attach the onUnpair / onRename handlers to a freshly-constructed
   * RelayClient. These are set as direct properties (not in the events bag)
   * because they're handled by `RelayClient.decryptAndDispatch` before the
   * normal control-message path.
   */
  attachHandlers(client: RelayClient, daemonId: string): void {
    client.onUnpair = ({ frontendId, reason }) => {
      log.info(
        `peer unpaired (daemonId=${daemonId}, frontendId=${frontendId}, reason=${reason}); removing pairing`,
      );
      this.removePairing(daemonId, { notifyPeer: false }).catch((err) => {
        log.error(
          `removePairing failed after inbound unpair (daemonId=${daemonId}):`,
          err,
        );
      });
    };
    // Note: daemon stores a single label row per pairing; if multiple frontends
    // rename concurrently, last-write-wins. Cross-frontend fan-out is out of scope.
    client.onRename = ({ frontendId, label }) => {
      log.info(
        `peer renamed pairing (frontendId=${frontendId}) → ${JSON.stringify(label)}`,
      );
      try {
        // `label` is already a `Label` (RelayClient decoded the wire shape,
        // legacy `""` → `{ set: false }`); store it directly.
        this.deps.store.updatePairingLabel(daemonId, label);
      } catch (err) {
        log.error(
          `updatePairingLabel failed after inbound rename (daemonId=${daemonId}):`,
          err,
        );
      }
    };
  }

  /**
   * Connect to a Relay server for remote frontend access. Persists the
   * pairing for auto-reconnect and adds the client to the pool.
   *
   * Multiple relays can be connected simultaneously (N:N).
   */
  async addClient(config: RelayClientConfig): Promise<RelayClient> {
    let clientRef: RelayClient | null = null;
    const events = this.buildEvents(
      () => clientRef,
      config.label,
      config.daemonId,
    );
    const client = this.factory
      ? this.factory(config)
      : new RelayClient(config, events);
    clientRef = client;
    this.attachHandlers(client, config.daemonId);

    await client.connect();

    // Subscribe to meta, control, and all existing sessions (running OR
    // stopped). A stopped session still needs a subscription so that the
    // frontend's `relay.pub <sid>` resume request reaches us — relay forwards
    // a frame only to peers subscribed to that sid. New frames for stopped
    // sessions never arrive (Runner is gone) so this is purely a registry
    // entry on the relay.
    client.subscribe(RELAY_CHANNEL_META);
    client.subscribe(RELAY_CHANNEL_CONTROL);
    for (const meta of this.deps.store.listSessions()) {
      client.subscribe(meta.sid);
    }

    // Persist pairing data for auto-reconnect on daemon restart.
    // Preserve any existing label if the caller didn't supply one, so
    // reconnecting saved relays doesn't overwrite a user-set label.
    const existingLabel =
      this.deps.store.listPairings().find((p) => p.daemonId === config.daemonId)
        ?.label ?? LABEL_UNSET;
    this.deps.store.savePairing({
      daemonId: config.daemonId,
      relayUrl: config.relayUrl,
      relayToken: config.token,
      registrationProof: config.registrationProof,
      publicKey: config.keyPair.publicKey,
      secretKey: config.keyPair.secretKey,
      pairingSecret: config.pairingSecret,
      label: config.label ?? existingLabel,
    });

    this.clients.push(client);
    return client;
  }

  /**
   * Register a pre-constructed RelayClient in the pool. Used by Daemon's
   * `promoteCompletedPairing` — the pending pairing has already built and
   * connected the client, so we only need to take ownership.
   */
  registerClient(client: RelayClient): void {
    this.clients.push(client);
  }

  /**
   * Reconnect to all saved relay pairings from the store in parallel.
   * Returns the number of pairings that reconnected successfully. Sequential
   * awaits here used to delay startup by N × handshake latency — the relays
   * are independent transports so `Promise.allSettled` is the right shape.
   */
  async reconnectSaved(): Promise<number> {
    const pairings = this.deps.store.loadPairings();
    const results = await Promise.allSettled(
      pairings.map(async (p) => {
        await this.addClient({
          relayUrl: p.relayUrl,
          daemonId: p.daemonId,
          token: p.relayToken,
          registrationProof: p.registrationProof,
          keyPair: { publicKey: p.publicKey, secretKey: p.secretKey },
          pairingSecret: p.pairingSecret,
          label: p.label,
        });
        log.info(`reconnected to relay ${p.relayUrl} (daemon ${p.daemonId})`);
      }),
    );
    let count = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        count++;
      } else {
        log.error(
          `failed to reconnect to relay ${pairings[i]?.relayUrl}:`,
          r.reason,
        );
      }
    });
    return count;
  }

  /**
   * Remove a pairing by daemonId: optionally notify the peer with a
   * control.unpair frame, tear down the relay client, and delete the
   * persisted pairing record from the store.
   *
   * Returns the number of peers successfully notified (0 when
   * `notifyPeer: false`, or when no active client matches `daemonId`).
   */
  async removePairing(
    daemonId: string,
    opts: { notifyPeer: boolean } = { notifyPeer: true },
  ): Promise<number> {
    const client = this.clients.find((c) => c.daemonId === daemonId);
    let notified = 0;
    if (client && opts.notifyPeer) {
      const peers = client.listPeerFrontendIds();
      for (const frontendId of peers) {
        try {
          if (await client.sendUnpairNotice(frontendId, "user-initiated")) {
            notified++;
          }
        } catch (err) {
          // Best-effort — continue teardown on failure
          log.warn(
            `sendUnpairNotice failed for frontend ${frontendId}: ${String(err)}`,
          );
        }
      }
      const logFn = peers.length === 0 ? log.debug : log.info;
      logFn(
        `removePairing(${daemonId}): notified ${notified}/${peers.length} peers`,
      );
    }
    if (client) {
      client.dispose();
      // Re-resolve the index after any awaits — a concurrent removePairing
      // may have mutated `clients` while sendUnpairNotice was in flight.
      const i = this.clients.indexOf(client);
      if (i >= 0) this.clients.splice(i, 1);
    }
    this.deps.store.deletePairing(daemonId);
    return notified;
  }

  /**
   * Rename a pairing's label. Updates the store immediately, then pushes a
   * `control.rename` frame to every connected peer on that pairing.
   *
   * Returns the number of peers successfully notified (0 when no active
   * client matches `daemonId`, e.g. the pairing exists in the store but has
   * no live relay connection).
   */
  async renamePairing(daemonId: string, label: Label): Promise<number> {
    this.deps.store.updatePairingLabel(daemonId, label);

    const client = this.clients.find((c) => c.daemonId === daemonId);
    if (!client) return 0;

    let notified = 0;
    const peers = client.listPeerFrontendIds();
    for (const frontendId of peers) {
      try {
        // RelayClient emits the `Label` union unconditionally to every peer
        // (the per-peer version-gate was removed — ADR-0003 A1.3#1).
        if (await client.sendRenameNotice(frontendId, label)) {
          notified++;
        }
      } catch (err) {
        log.warn(
          `sendRenameNotice failed for frontend ${frontendId}: ${String(err)}`,
        );
      }
    }
    const logFn = peers.length === 0 ? log.debug : log.info;
    logFn(
      `renamePairing(${daemonId}): notified ${notified}/${peers.length} peers`,
    );
    return notified;
  }

  /**
   * Fan out a push notification to every active client. Each client forwards
   * to the Expo Push API via its relay server connection; we broadcast
   * because the caller (PushNotifier) doesn't know which relay owns the
   * frontendId.
   *
   * `sealed` is an opaque blob from the relay ("tpps1.<v>.<b64>") or a legacy
   * plaintext token — the daemon passes it through opaquely.
   */
  dispatchPush(
    frontendId: string,
    sealed: string,
    title: string,
    body: string,
    interruptionLevel?: PushInterruptionLevel,
    data?: { sid: string; daemonId?: string; event: string },
  ): void {
    for (const client of this.clients) {
      client.sendPush(frontendId, sealed, title, body, interruptionLevel, data);
    }
  }

  /** Read-only view of the active clients. Used by IpcCommandDispatcher. */
  listClients(): readonly RelayClient[] {
    return this.clients;
  }

  /** DaemonIds of all active clients — exposed for `tp pair list` style UIs. */
  listDaemonIds(): string[] {
    return this.clients.map((c) => c.daemonId);
  }

  /**
   * Test-only hook: inject a fake RelayClient factory for both
   * {@link addClient} and for the Daemon's pending-pairing flow (which
   * delegates to this when wrapping a PendingPairing's createRelayClient).
   */
  __setFactory(factory: (cfg: RelayClientConfig) => RelayClient): void {
    this.factory = factory;
  }

  /** Peek at the injected factory (Daemon's beginPairing uses this). */
  __getFactory(): ((cfg: RelayClientConfig) => RelayClient) | null {
    return this.factory;
  }

  /** Dispose all active clients. Called during Daemon.stop(). */
  stop(): void {
    for (const client of this.clients) {
      client.dispose();
    }
    this.clients.length = 0;
  }
}
