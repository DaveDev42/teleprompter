import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store";
import { useOfflineStore } from "../stores/offline-store";
import { usePairingStore } from "../stores/pairing-store";
import { FrontendRelayClient } from "../lib/relay-client";
import type { WsRec, WsState, WsHelloReply } from "@teleprompter/protocol/client";

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
        onState: (msg: unknown) => {
          // State update: { t: "state", sid, d: WsSessionMeta }
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
            // Hello reply with session list: { t: "hello", d: { sessions } }
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
