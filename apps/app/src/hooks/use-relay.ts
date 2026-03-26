import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store";
import { useOfflineStore } from "../stores/offline-store";
import { usePairingStore } from "../stores/pairing-store";
import { FrontendRelayClient } from "../lib/relay-client";
import type { WsRec } from "@teleprompter/protocol/client";

/** Singleton relay client ref shared across the app */
let globalRelayClient: FrontendRelayClient | null = null;

/**
 * Hook that manages the E2EE relay connection when paired.
 * Should be called once at the app layout level alongside useDaemon.
 */
export function useRelay() {
  const clientRef = useRef<FrontendRelayClient | null>(null);
  const pairingState = usePairingStore((s) => s.state);
  const pairingInfo = usePairingStore((s) => s.info);

  useEffect(() => {
    if (pairingState !== "paired" || !pairingInfo) {
      // Not paired — clean up any existing relay client
      if (clientRef.current) {
        clientRef.current.dispose();
        clientRef.current = null;
        globalRelayClient = null;
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

    const client = new FrontendRelayClient(
      {
        relayUrl: pairingInfo.relayUrl,
        daemonId: pairingInfo.daemonId,
        token: pairingInfo.relayToken,
        keyPair: pairingInfo.frontendKeyPair,
        daemonPublicKey: pairingInfo.daemonPublicKey,
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
        onState: (msg: any) => {
          if (msg.sid && msg.meta) {
            updateSession(msg.sid, msg.meta);
            updateState(msg.sid, msg.meta.state);
            const currentSid = useSessionStore.getState().sid;
            if (!currentSid && msg.meta.state === "running") {
              client.subscribe(msg.sid);
              setSid(msg.sid);
              setLastSeq(msg.meta.lastSeq);
            }
          }
          if (msg.sessions) {
            setSessions(msg.sessions);
          }
        },
        onPresence: (online: boolean, sessions: string[]) => {
          if (online && sessions.length > 0) {
            // Auto-subscribe to all daemon sessions
            for (const sid of sessions) {
              client.subscribe(sid);
            }
            // Auto-attach to first session if none selected
            const currentSid = useSessionStore.getState().sid;
            if (!currentSid) {
              setSid(sessions[0]);
            }
          }
        },
      },
    );

    clientRef.current = client;
    globalRelayClient = client;
    client.connect();

    return () => {
      client.dispose();
      clientRef.current = null;
      globalRelayClient = null;
    };
  }, [pairingState, pairingInfo]);

  return clientRef;
}

/** Get the shared relay client instance (for use outside the layout) */
export function getRelayClient(): FrontendRelayClient | null {
  return globalRelayClient;
}
