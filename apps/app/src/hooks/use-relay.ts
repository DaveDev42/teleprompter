import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import { useOfflineStore } from "../stores/offline-store";
import { usePairingStore } from "../stores/pairing-store";
import { FrontendRelayClient } from "../lib/relay-client";
import type { WsRec, WsState, WsHelloReply } from "@teleprompter/protocol/client";

/** Per-daemon relay clients */
const relayClients = new Map<string, FrontendRelayClient>();

/**
 * Hook that manages E2EE relay connections for all paired daemons.
 * Should be called once at the app layout level.
 */
export function useRelay() {
  const pairings = usePairingStore((s) => s.pairings);
  const pairingState = usePairingStore((s) => s.state);

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
      setConnected,
      setSid,
      setLastSeq,
      setSessions,
      updateSession,
      dispatchRec,
      setError,
      incrementReconnect,
    } = useSessionStore.getState();
    const { cacheFrame, updateState } = useOfflineStore.getState();

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
            setConnected(true);
            setError(null);
          },
          onDisconnected: () => {
            setConnected(false);
            incrementReconnect();
          },
          onRecord: (rec: WsRec) => {
            const seq = rec.seq;
            if (seq > useSessionStore.getState().lastSeq) {
              setLastSeq(seq);
            }
            cacheFrame(rec);
            dispatchRec(rec);
          },
          onState: (msg: unknown) => {
            if (msg && typeof msg === "object" && "t" in msg) {
              const m = msg as Record<string, unknown>;
              if (m.t === "state" && typeof m.sid === "string" && m.d) {
                const state = m as unknown as WsState;
                updateSession(state.sid, state.d);
                updateState(state.sid, state.d.state);
                const currentSid = useSessionStore.getState().sid;
                if (!currentSid && state.d.state === "running") {
                  client.subscribe(state.sid);
                  setSid(state.sid);
                  setLastSeq(state.d.lastSeq);
                }
              }
              if (m.t === "hello" && m.d && typeof m.d === "object") {
                const hello = m as unknown as WsHelloReply;
                setSessions(hello.d.sessions);
              }
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
        },
      );

      relayClients.set(daemonId, client);
      client.connect();
    }

    // Disconnect removed pairings
    for (const [daemonId, client] of relayClients) {
      if (!pairings.has(daemonId)) {
        client.dispose();
        relayClients.delete(daemonId);
      }
    }
  }, [pairingState, pairings]);

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      for (const client of relayClients.values()) client.dispose();
      relayClients.clear();
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
