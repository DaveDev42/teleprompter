import { useEffect, useRef, useCallback } from "react";
import { View, Text, Platform } from "react-native";
import { useSessionStore } from "../../src/stores/session-store";
import { getDaemonClient } from "../../src/hooks/use-daemon";
import type { WsRec } from "@teleprompter/protocol";

// Platform-specific terminal component
let TerminalComponent: any = null;
if (Platform.OS === "web") {
  TerminalComponent = require("../../src/components/XTermWeb").XTermWeb;
} else {
  TerminalComponent = require("../../src/components/XTermNative").XTermNative;
}

export default function TerminalScreen() {
  const connected = useSessionStore((s) => s.connected);
  const sid = useSessionStore((s) => s.sid);
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const termRef = useRef<any>(null);

  // Wire io records to xterm
  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k !== "io") return;
      const term = termRef.current;
      if (!term) return;
      try {
        const bytes = atob(rec.d);
        term.write(bytes);
      } catch {
        term.write(rec.d);
      }
    };

    addRecHandler(handler);
    return () => removeRecHandler(handler);
  }, [addRecHandler, removeRecHandler]);

  // Handle keyboard input → Daemon
  const handleData = useCallback(
    (data: string) => {
      const client = getDaemonClient();
      if (!sid || !client) return;
      client.sendTermInput(sid, btoa(data));
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
        {TerminalComponent && (
          <TerminalComponent
            onData={handleData}
            onResize={handleResize}
            termRef={termRef}
          />
        )}
      </View>
    </View>
  );
}
