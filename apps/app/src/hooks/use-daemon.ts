import { useEffect, useRef } from "react";
import { useSessionStore } from "../stores/session-store";
import { useOfflineStore } from "../stores/offline-store";
import { DaemonWsClient } from "../lib/ws-client";
import type { WsRec, WsSessionMeta } from "@teleprompter/protocol/client";

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
    const {
      setConnected,
      setSid,
      setLastSeq,
      setSessions,
      updateSession,
      dispatchRec,
    } = useSessionStore.getState();
    const { cacheFrame, updateState } = useOfflineStore.getState();

    const client = new DaemonWsClient(url, {
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onSessionList: (sessions: WsSessionMeta[]) => {
        setSessions(sessions);
        const running = sessions.filter((s) => s.state === "running");
        // Auto-attach to the first active session if none selected
        const currentSid = useSessionStore.getState().sid;
        if (!currentSid && running.length > 0) {
          const active = running[0];
          client.attach(active.sid);
          setSid(active.sid);
          setLastSeq(active.lastSeq);
        } else if (!currentSid && running.length === 0 && sessions.length > 0) {
          // No running sessions yet — daemon may still be spawning.
          // Re-send hello after a delay to get updated session list.
          setTimeout(() => {
            if (!useSessionStore.getState().sid) {
              client.send({ t: "hello" });
            }
          }, 3000);
        }
      },
      onRec: (rec: WsRec) => {
        const seq = rec.seq;
        if (seq > useSessionStore.getState().lastSeq) {
          setLastSeq(seq);
        }
        cacheFrame(rec);
        dispatchRec(rec);
      },
      onState: (sid: string, meta: WsSessionMeta) => {
        updateSession(sid, meta);
        updateState(sid, meta.state);
        // Auto-attach to new running session if none selected
        const currentSid = useSessionStore.getState().sid;
        if (!currentSid && meta.state === "running") {
          client.attach(sid);
          setSid(sid);
          setLastSeq(meta.lastSeq);
        }
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
