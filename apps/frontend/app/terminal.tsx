import { useEffect, useRef, useCallback } from "react";
import { View, Text, Platform } from "react-native";
import { useSessionStore } from "../src/stores/session-store";
import { useDaemon } from "../src/hooks/use-daemon";
import type { WsRec } from "@teleprompter/protocol";

// Conditionally import XTermWeb only on web
let XTermWeb: any = null;
if (Platform.OS === "web") {
  XTermWeb = require("../src/components/XTermWeb").XTermWeb;
}

export default function TerminalScreen() {
  const connected = useSessionStore((s) => s.connected);
  const sid = useSessionStore((s) => s.sid);
  const setOnRec = useSessionStore((s) => s.setOnRec);
  const clientRef = useDaemon();
  const termRef = useRef<any>(null);

  // Wire records to xterm
  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k !== "io") return;
      const term = termRef.current;
      if (!term) return;
      // Decode base64 payload and write to terminal
      try {
        const bytes = atob(rec.d);
        term.write(bytes);
      } catch {
        // fallback: write as-is
        term.write(rec.d);
      }
    };

    setOnRec(handler);
    return () => setOnRec(null);
  }, [setOnRec]);

  // Handle keyboard input → Daemon
  const handleData = useCallback(
    (data: string) => {
      if (!sid || !clientRef.current) return;
      clientRef.current.sendTermInput(sid, btoa(data));
    },
    [sid],
  );

  // Handle resize
  const handleResize = useCallback(
    (_cols: number, _rows: number) => {
      // TODO: send resize to daemon when protocol supports it
    },
    [],
  );

  if (Platform.OS !== "web") {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <Text className="text-white text-xl">Terminal</Text>
        <Text className="text-gray-400 mt-2">
          Native terminal requires WebView (Stage 5)
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      <View className="flex-row items-center px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <View
          className={`w-2 h-2 rounded-full mr-2 ${connected ? "bg-green-500" : "bg-red-500"}`}
        />
        <Text className="text-gray-400 text-xs">
          {sid ? `Session: ${sid}` : "No session"}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <XTermWeb
          onData={handleData}
          onResize={handleResize}
          termRef={termRef}
        />
      </View>
    </View>
  );
}
