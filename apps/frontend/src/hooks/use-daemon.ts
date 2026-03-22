import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store";
import { DaemonWsClient } from "../lib/ws-client";
import type { WsRec, WsSessionMeta } from "@teleprompter/protocol";

/** Singleton client ref shared across the app */
let globalClient: DaemonWsClient | null = null;

/**
 * Hook that manages the WebSocket connection to the Daemon.
 * Should be called once at the app layout level.
 * Returns the client instance for sending messages.
 */
export function useDaemon(url?: string) {
  const clientRef = useRef<DaemonWsClient | null>(null);

  useEffect(() => {
    const { setConnected, setSid, setLastSeq, dispatchRec } =
      useSessionStore.getState();

    const client = new DaemonWsClient(url, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onSessionList: (sessions: WsSessionMeta[]) => {
        const active = sessions.find((s) => s.state === "running");
        if (active) {
          client.attach(active.sid);
          setSid(active.sid);
          setLastSeq(active.lastSeq);
        }
      },
      onRec: (rec: WsRec) => {
        const seq = rec.seq;
        if (seq > useSessionStore.getState().lastSeq) {
          setLastSeq(seq);
        }
        dispatchRec(rec);
      },
      onState: (_sid: string, meta: WsSessionMeta) => {
        setSid(meta.sid);
        setLastSeq(meta.lastSeq);
      },
    });

    clientRef.current = client;
    globalClient = client;
    client.connect();

    return () => {
      client.dispose();
      clientRef.current = null;
      globalClient = null;
    };
  }, [url]);

  return clientRef;
}

/** Get the shared client instance (for use outside the layout) */
export function getDaemonClient(): DaemonWsClient | null {
  return globalClient;
}
