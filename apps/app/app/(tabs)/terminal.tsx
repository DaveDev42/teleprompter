import { useEffect, useRef, useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, Platform } from "react-native";
import { useSessionStore } from "../../src/stores/session-store";
import { getDaemonClient } from "../../src/hooks/use-daemon";
import { setGlobalTermRef } from "../../src/stores/voice-store";
import type { WsRec } from "@teleprompter/protocol/client";

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
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Expose terminal ref globally for voice context
  useEffect(() => {
    setGlobalTermRef(termRef.current);
    return () => setGlobalTermRef(null);
  });

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

  // Handle resize → send to daemon
  const handleResize = useCallback(
    (cols: number, rows: number) => {
      const client = getDaemonClient();
      if (sid && client) {
        client.send({ t: "resize", sid, cols, rows } as any);
      }
    },
    [sid],
  );

  return (
    <View className="flex-1 bg-black" style={{ flex: 1, backgroundColor: "#000" }}>
      <View className="flex-row items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800" style={{ backgroundColor: "#18181b" }}>
        <View className="flex-row items-center">
          <View
            className={`w-2 h-2 rounded-full mr-2 ${connected ? "bg-green-500" : "bg-red-500"}`}
          />
          <Text className="text-gray-400 text-xs">
            {sid ? `Session: ${sid}` : "No session"}
          </Text>
        </View>
        {Platform.OS === "web" && (
          <Pressable onPress={() => setShowSearch((s) => !s)}>
            <Text className="text-gray-500 text-xs">Search</Text>
          </Pressable>
        )}
      </View>
      {showSearch && Platform.OS === "web" && (
        <View className="flex-row items-center px-3 py-1 bg-zinc-900 border-b border-zinc-800 gap-2">
          <TextInput
            className="flex-1 bg-zinc-800 text-white rounded px-3 py-1 text-sm"
            placeholder="Search terminal..."
            placeholderTextColor="#555"
            value={searchQuery}
            onChangeText={(q) => {
              setSearchQuery(q);
              if (q && termRef.current?.searchAddon) {
                termRef.current.searchAddon.findNext(q);
              }
            }}
            onSubmitEditing={() => {
              termRef.current?.searchAddon?.findNext(searchQuery);
            }}
            autoFocus
          />
          <Pressable
            onPress={() => termRef.current?.searchAddon?.findNext(searchQuery)}
          >
            <Text className="text-gray-400 text-xs">Next</Text>
          </Pressable>
          <Pressable
            onPress={() => termRef.current?.searchAddon?.findPrevious(searchQuery)}
          >
            <Text className="text-gray-400 text-xs">Prev</Text>
          </Pressable>
          <Pressable onPress={() => { setShowSearch(false); setSearchQuery(""); }}>
            <Text className="text-gray-500 text-xs">Close</Text>
          </Pressable>
        </View>
      )}
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
