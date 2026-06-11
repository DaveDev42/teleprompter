import type { SessionRec } from "@teleprompter/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { getTransport } from "../hooks/use-transport";
import type { TerminalSearch } from "../lib/terminal-search";
import { TERMINAL_COLORS } from "../lib/tokens";
import { encodeUtf8Base64 } from "../lib/utf8-base64";
import { useSessionStore } from "../stores/session-store";
import { setGlobalTermRef } from "../stores/voice-store";

// Platform-specific terminal component
// biome-ignore lint/suspicious/noExplicitAny: dynamic require of platform-specific component; no shared interface to reference
let TerminalComponent: any = null;
if (Platform.OS === "web") {
  TerminalComponent = require("./GhosttyTerminal").GhosttyTerminal;
} else {
  TerminalComponent = require("./GhosttyNative").GhosttyNative;
}

export function SessionTerminalView({
  sid,
  stopped,
}: {
  sid: string;
  stopped: boolean;
}) {
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  // biome-ignore lint/suspicious/noExplicitAny: termRef is a cross-platform handle; GhosttyTerminal and GhosttyNative both type their own ref as MutableRefObject<any>
  const termRef = useRef<any>(null);
  const searchRef = useRef<TerminalSearch | null>(null);
  // `hasIo` flips true once any io record arrives (live or replayed).
  // `replaySettled` flips true only after 500ms of silence from the
  // daemon — every record of any kind (io, event, meta) rearms the
  // window by resetting replaySettled to false and restarting the timer.
  // The overlay only renders when all three align: stopped, no io seen,
  // and the daemon has been quiet long enough that more records are
  // unlikely to arrive.
  const [hasIo, setHasIo] = useState(false);
  const [replaySettled, setReplaySettled] = useState(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
    // Flip replaySettled back to false — a late record arriving after the
    // window elapsed should reopen it, not leave a stale "settled" latch.
    setReplaySettled(false);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setReplaySettled(true);
    }, 500);
  }, []);

  useEffect(() => {
    setGlobalTermRef(termRef.current);
    return () => setGlobalTermRef(null);
  });

  const handleTermReady = useCallback(() => {
    if (!sid) return;
    const client = getTransport();
    if (client) {
      client.resume(sid, 0);
    }
  }, [sid]);

  // Reset per-session overlay state when switching sessions and start the
  // initial silence window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sid drives the per-session reset
  useEffect(() => {
    setHasIo(false);
    setReplaySettled(false);
    armSettleTimer();
    return () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
  }, [sid, armSettleTimer]);

  useEffect(() => {
    const handler = (rec: SessionRec) => {
      // Any record arriving means replay/stream is still flowing — push
      // the empty-state overlay back by restarting the silence window.
      armSettleTimer();
      if (rec.k !== "io") return;
      setHasIo(true);
      const term = termRef.current;
      if (!term) return;
      try {
        const binary = atob(rec.d);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);
      } catch {
        term.write(rec.d);
      }
    };
    addRecHandler(handler);
    return () => removeRecHandler(handler);
  }, [addRecHandler, removeRecHandler, armSettleTimer]);

  const handleData = useCallback(
    (data: string) => {
      if (stopped) return;
      const client = getTransport();
      if (!sid || !client) return;
      // btoa() throws on multi-byte UTF-8 (Korean, emoji, …); encode via bytes.
      client.sendTermInput(sid, encodeUtf8Base64(data));
    },
    [sid, stopped],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (stopped) return;
      const client = getTransport();
      if (sid && client) {
        client.send({ t: "resize", sid, cols, rows });
      }
    },
    [sid, stopped],
  );

  const showEmptyFallback = stopped && !hasIo && replaySettled;

  return (
    <View
      className="flex-1"
      style={{ backgroundColor: TERMINAL_COLORS.background }}
    >
      {TerminalComponent && (
        <TerminalComponent
          onData={handleData}
          onResize={handleResize}
          termRef={termRef}
          onReady={handleTermReady}
          searchRef={searchRef}
        />
      )}
      {showEmptyFallback && (
        <View
          testID="terminal-empty-fallback"
          className="absolute inset-0 items-center justify-center px-6"
          style={{ pointerEvents: "none" }}
        >
          <Text className="text-tp-text-tertiary text-[13px] text-center">
            No terminal output captured for this session.
          </Text>
        </View>
      )}
    </View>
  );
}
