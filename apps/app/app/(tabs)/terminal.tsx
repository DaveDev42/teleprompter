import type { WsClientMessage, WsRec } from "@teleprompter/protocol/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { getDaemonClient } from "../../src/hooks/use-daemon";
import type { TerminalSearch } from "../../src/lib/terminal-search";
import { useSessionStore } from "../../src/stores/session-store";
import { setGlobalTermRef } from "../../src/stores/voice-store";

// Platform-specific terminal component
let TerminalComponent: any = null;
if (Platform.OS === "web") {
  TerminalComponent =
    require("../../src/components/GhosttyTerminal").GhosttyTerminal;
} else {
  TerminalComponent =
    require("../../src/components/GhosttyNative").GhosttyNative;
}

// Mobile keyboard toolbar (native only)
let TerminalToolbar: any = null;
if (Platform.OS !== "web") {
  try {
    TerminalToolbar =
      require("../../src/components/TerminalToolbar").TerminalToolbar;
  } catch {
    // Not available yet
  }
}

export default function TerminalScreen() {
  const connected = useSessionStore((s) => s.connected);
  const sid = useSessionStore((s) => s.sid);
  const addRecHandler = useSessionStore((s) => s.addRecHandler);
  const removeRecHandler = useSessionStore((s) => s.removeRecHandler);
  const termRef = useRef<any>(null);
  const searchRef = useRef<TerminalSearch | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInfo, setSearchInfo] = useState("");

  // Expose terminal ref globally for voice context
  useEffect(() => {
    setGlobalTermRef(termRef.current);
    return () => setGlobalTermRef(null);
  });

  // When terminal is ready, request full backlog from daemon
  const handleTermReady = useCallback(() => {
    if (!sid) return;
    const client = getDaemonClient();
    if (client) {
      client.resume(sid, 0);
    }
  }, [sid]);

  // Wire io records to terminal (live data)
  useEffect(() => {
    const handler = (rec: WsRec) => {
      if (rec.k !== "io") return;
      const term = termRef.current;
      if (!term) return;
      try {
        // Decode base64 → binary bytes (preserves ANSI sequences)
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
        client.send({ t: "resize", sid, cols, rows } as WsClientMessage);
      }
    },
    [sid],
  );

  // Search handlers
  const handleSearchNext = useCallback(() => {
    if (!searchQuery || !searchRef.current) return;
    searchRef.current.findNext(searchQuery);
    const info = searchRef.current.resultInfo;
    setSearchInfo(
      info.total > 0 ? `${info.index}/${info.total}` : "No results",
    );
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    if (!searchQuery || !searchRef.current) return;
    searchRef.current.findPrevious(searchQuery);
    const info = searchRef.current.resultInfo;
    setSearchInfo(
      info.total > 0 ? `${info.index}/${info.total}` : "No results",
    );
  }, [searchQuery]);

  const handleSearchClose = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchInfo("");
    searchRef.current?.clear();
  }, []);

  return (
    <View className="flex-1 bg-black">
      <View className="flex-row items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
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
              if (q && searchRef.current) {
                searchRef.current.findNext(q);
                const info = searchRef.current.resultInfo;
                setSearchInfo(
                  info.total > 0 ? `${info.index}/${info.total}` : "No results",
                );
              } else {
                setSearchInfo("");
              }
            }}
            onSubmitEditing={handleSearchNext}
            autoFocus
          />
          {searchInfo ? (
            <Text className="text-gray-500 text-xs">{searchInfo}</Text>
          ) : null}
          <Pressable onPress={handleSearchNext}>
            <Text className="text-gray-400 text-xs">Next</Text>
          </Pressable>
          <Pressable onPress={handleSearchPrev}>
            <Text className="text-gray-400 text-xs">Prev</Text>
          </Pressable>
          <Pressable onPress={handleSearchClose}>
            <Text className="text-gray-500 text-xs">Close</Text>
          </Pressable>
        </View>
      )}
      <View className="flex-1">
        {TerminalComponent && (
          <TerminalComponent
            onData={handleData}
            onResize={handleResize}
            termRef={termRef}
            onReady={handleTermReady}
            searchRef={searchRef}
          />
        )}
      </View>
      {TerminalToolbar && Platform.OS !== "web" && (
        <TerminalToolbar onData={handleData} />
      )}
    </View>
  );
}
