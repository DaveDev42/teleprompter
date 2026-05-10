import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";
import { useEffect } from "react";
import { Platform } from "react-native";
import { create } from "zustand";
import { FrontendRelayClient } from "../lib/relay-client";
import { useNotificationStore } from "../stores/notification-store";
import { useOfflineStore } from "../stores/offline-store";
import {
  registerRenameSender,
  registerUnpairSender,
  usePairingStore,
} from "../stores/pairing-store";
import { useSessionStore } from "../stores/session-store";

/** Relay connection state (per daemon) */
interface RelayConnectionState {
  /** daemonId → connected */
  connections: Map<string, boolean>;
  setConnected: (daemonId: string, connected: boolean) => void;
  remove: (daemonId: string) => void;
  clear: () => void;
}

export const useRelayConnectionStore = create<RelayConnectionState>((set) => ({
  connections: new Map(),
  setConnected: (daemonId, connected) =>
    set((s) => {
      const next = new Map(s.connections);
      next.set(daemonId, connected);
      return { connections: next };
    }),
  remove: (daemonId) =>
    set((s) => {
      const next = new Map(s.connections);
      next.delete(daemonId);
      return { connections: next };
    }),
  clear: () => set({ connections: new Map() }),
}));

/**
 * Derived hook: true when at least one paired daemon has an active relay
 * connection. Previous implementations tracked a global `connected` bool
 * on `useSessionStore`, but that was a last-write-wins summary across N
 * daemons — a single daemon's disconnect would blank the badge even if
 * other daemons remained online. Deriving from the per-daemon map makes
 * the UI accurately reflect "any connection" semantics.
 */
export function useAnyRelayConnected(): boolean {
  return useRelayConnectionStore((s) => {
    for (const v of s.connections.values()) if (v) return true;
    return false;
  });
}

/** Per-daemon relay clients */
const relayClients = new Map<string, FrontendRelayClient>();

/** Module-level list for push token broadcasting */
let activeRelayClients: FrontendRelayClient[] = [];

export function getRelayClients(): readonly FrontendRelayClient[] {
  return activeRelayClients;
}

/**
 * Hook that manages E2EE relay connections for all paired daemons.
 * Should be called once at the app layout level.
 */
export function useRelay() {
  const pairings = usePairingStore((s) => s.pairings);
  const pairingState = usePairingStore((s) => s.state);

  // Register the unpair sender — invoked by `usePairingStore.removePairing`
  // to notify the daemon over relay before the local pairing record is dropped.
  // Registered in an effect (not module scope) to handle Fast Refresh correctly.
  useEffect(() => {
    registerUnpairSender(async (daemonId) => {
      const client = relayClients.get(daemonId);
      if (!client) return;
      await client.sendUnpairNotice("user-initiated");
    });
    registerRenameSender(async (daemonId, label) => {
      const client = relayClients.get(daemonId);
      if (!client) return;
      await client.sendRenameNotice(label);
    });
    return () => {
      registerUnpairSender(null);
      registerRenameSender(null);
    };
  }, []);

  useEffect(() => {
    if (pairingState !== "paired" || pairings.size === 0) {
      // No pairings — dispose all
      for (const [id, client] of relayClients) {
        client.dispose();
        relayClients.delete(id);
      }
      return;
    }

    const {
      setSid,
      setLastSeq,
      setSessions,
      updateSession,
      dispatchRec,
      setError,
      incrementReconnect,
    } = useSessionStore.getState();
    const { cacheFrame, updateState } = useOfflineStore.getState();
    const relayConn = useRelayConnectionStore.getState();

    // Connect new pairings
    for (const [daemonId, info] of pairings) {
      if (relayClients.has(daemonId)) continue;

      const client = new FrontendRelayClient(
        {
          relayUrl: info.relayUrl,
          daemonId: info.daemonId,
          token: info.relayToken,
          keyPair: info.frontendKeyPair,
          daemonPublicKey: info.daemonPublicKey,
          pairingSecret: info.pairingSecret,
          frontendId: info.frontendId,
        },
        {
          onConnected: () => {
            setError(null);
            relayConn.setConnected(daemonId, true);
            // Re-send push token on reconnect so daemon always has a fresh token
            if (Platform.OS !== "web") {
              const { getCurrentPushToken } =
                require("./use-push-notifications") as typeof import("./use-push-notifications");
              const token = getCurrentPushToken();
              if (token) {
                const platform = Platform.OS as "ios" | "android";
                client.sendPushToken(token, platform);
              }
            }
          },
          onDisconnected: () => {
            incrementReconnect();
            relayConn.setConnected(daemonId, false);
          },
          onRec: (rec: WsRec) => {
            const seq = rec.seq;
            if (seq > useSessionStore.getState().lastSeq) {
              setLastSeq(seq);
            }
            cacheFrame(rec);
            dispatchRec(rec);
          },
          onSessionList: (sessions: WsSessionMeta[]) => {
            setSessions(daemonId, sessions);
          },
          onState: (sid: string, meta: WsSessionMeta) => {
            updateSession(sid, meta);
            updateState(sid, meta.state);
            const currentSid = useSessionStore.getState().sid;
            if (!currentSid && meta.state === "running") {
              client.subscribe(sid);
              setSid(sid);
              setLastSeq(meta.lastSeq);
            }
          },
          onPresence: (online: boolean, sessions: string[]) => {
            if (online && sessions.length > 0) {
              for (const sid of sessions) {
                client.subscribe(sid);
              }
              const currentSid = useSessionStore.getState().sid;
              if (!currentSid) {
                setSid(sessions[0]);
                setLastSeq(0);
              }
            }
          },
          onNotification: (title, body, data) => {
            const currentSid = useSessionStore.getState().sid;
            if (data?.sid && data.sid === currentSid) return;
            useNotificationStore.getState().showToast({ title, body, data });
          },
        },
      );

      client.onUnpair = ({ daemonId: did, reason }) => {
        void usePairingStore.getState().handlePeerUnpair(did, reason);
      };
      client.onRename = ({ daemonId: did, label }) => {
        void usePairingStore.getState().handlePeerRename(did, label);
      };
      client.onDaemonHello = ({ daemonId: did, label }) => {
        void usePairingStore.getState().handleDaemonHello(did, label);
      };
      relayClients.set(daemonId, client);
      if (!activeRelayClients.includes(client)) {
        activeRelayClients.push(client);
      }
      client.connect();
    }

    // Disconnect removed pairings
    for (const [daemonId, client] of relayClients) {
      if (!pairings.has(daemonId)) {
        client.dispose();
        relayClients.delete(daemonId);
        activeRelayClients = activeRelayClients.filter((c) => c !== client);
        relayConn.remove(daemonId);
      }
    }
  }, [pairingState, pairings]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      for (const client of relayClients.values()) client.dispose();
      relayClients.clear();
      activeRelayClients = [];
    };
  }, []);
}

/** Get a relay client for a specific daemon */
export function getRelayClient(daemonId?: string): FrontendRelayClient | null {
  if (daemonId) return relayClients.get(daemonId) ?? null;
  // Return first connected client
  for (const client of relayClients.values()) {
    if (client.isConnected()) return client;
  }
  return relayClients.values().next().value ?? null;
}
