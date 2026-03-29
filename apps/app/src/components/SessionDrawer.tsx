import { useState, useMemo } from "react";
import { View, Text, TextInput, Pressable, FlatList } from "react-native";
import { useSessionStore } from "../stores/session-store";
import { getDaemonClient } from "../hooks/use-daemon";
import { useChatStore } from "../stores/chat-store";
import type { WsSessionMeta, WsClientMessage } from "@teleprompter/protocol/client";

function SessionItem({
  session,
  isActive,
  onPress,
  onStop,
  onRestart,
}: {
  session: WsSessionMeta;
  isActive: boolean;
  onPress: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExport: () => void;
}) {
  const stateColor =
    session.state === "running"
      ? "bg-green-500"
      : session.state === "stopped"
        ? "bg-gray-500"
        : "bg-red-500";

  return (
    <Pressable
      onPress={onPress}
      className={`px-4 py-3 border-b border-zinc-800 ${isActive ? "bg-zinc-800" : ""}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <View className={`w-2 h-2 rounded-full ${stateColor} mr-2`} />
          <View className="flex-1">
            <Text className="text-white text-sm font-mono" numberOfLines={1}>
              {session.sid}
            </Text>
            <Text className="text-gray-500 text-xs" numberOfLines={1}>
              {session.cwd}
            </Text>
            {session.worktreePath && (
              <Text className="text-gray-600 text-xs" numberOfLines={1}>
                wt: {session.worktreePath}
              </Text>
            )}
            {session.claudeVersion && (
              <Text className="text-gray-600 text-xs">
                claude {session.claudeVersion}
              </Text>
            )}
          </View>
        </View>
        {session.state === "running" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onStop();
            }}
            className="bg-red-900/50 px-2 py-1 rounded"
          >
            <Text className="text-red-300 text-xs">Stop</Text>
          </Pressable>
        )}
        {session.state === "error" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onRestart();
            }}
            className="bg-orange-900/50 px-2 py-1 rounded"
          >
            <Text className="text-orange-300 text-xs">Restart</Text>
          </Pressable>
        )}
        {session.state === "stopped" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onExport();
            }}
            className="bg-zinc-700/50 px-2 py-1 rounded"
          >
            <Text className="text-gray-300 text-xs">Export</Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

export function SessionDrawer({ onClose }: { onClose?: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSid = useSessionStore((s) => s.sid);
  const setSid = useSessionStore((s) => s.setSid);
  const [filter, setFilter] = useState("");
  const [showWorktreeForm, setShowWorktreeForm] = useState(false);
  const [branchInput, setBranchInput] = useState("");

  // Filter sessions by search term
  const filteredSessions = useMemo(() => {
    if (!filter.trim()) return sessions;
    const q = filter.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sid.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.worktreePath?.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  const switchSession = (sid: string) => {
    const client = getDaemonClient();
    if (!client) return;

    // Detach current
    if (currentSid) {
      client.detach(currentSid);
    }

    // Attach new
    client.attach(sid);
    setSid(sid);

    // Clear chat for the new session
    useChatStore.getState().clear();

    onClose?.();
  };

  const stopSession = (sid: string) => {
    getDaemonClient()?.stopSession(sid);
  };

  const restartSession = (sid: string) => {
    getDaemonClient()?.restartSession(sid);
  };

  const exportSession = (sid: string) => {
    getDaemonClient()?.exportSession(sid, "markdown");
  };

  const createWorktree = () => {
    const branch = branchInput.trim();
    if (!branch) return;
    const client = getDaemonClient();
    if (!client) return;
    client.send({ t: "worktree.create", branch } as WsClientMessage);
    setBranchInput("");
    setShowWorktreeForm(false);
  };

  // Group by worktree
  const grouped = new Map<string, WsSessionMeta[]>();
  for (const s of filteredSessions) {
    const key = s.worktreePath ?? s.cwd;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  const flatData: (
    | { type: "header"; key: string }
    | { type: "session"; session: WsSessionMeta }
  )[] = [];

  for (const [key, group] of grouped) {
    flatData.push({ type: "header", key });
    for (const s of group) {
      flatData.push({ type: "session", session: s });
    }
  }

  return (
    <View className="flex-1 bg-zinc-900">
      <View className="px-4 py-3 border-b border-zinc-700">
        <View className="flex-row items-center justify-between mb-2">
          <Text className="text-white font-bold">Sessions</Text>
          <Text className="text-gray-500 text-xs">
            {filteredSessions.length}/{sessions.length}
          </Text>
        </View>
        {sessions.length > 3 && (
          <TextInput
            className="bg-zinc-800 text-white rounded-lg px-3 py-1.5 text-sm"
            placeholder="Search sessions..."
            placeholderTextColor="#555"
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
          />
        )}
      </View>

      <FlatList
        data={flatData}
        keyExtractor={(item, i) =>
          item.type === "header" ? `h-${item.key}` : `s-${item.session.sid}`
        }
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <View className="px-4 py-2 bg-zinc-950">
                <Text className="text-gray-400 text-xs font-mono">
                  {item.key}
                </Text>
              </View>
            );
          }
          return (
            <SessionItem
              session={item.session}
              isActive={item.session.sid === currentSid}
              onPress={() => switchSession(item.session.sid)}
              onStop={() => stopSession(item.session.sid)}
              onRestart={() => restartSession(item.session.sid)}
              onExport={() => exportSession(item.session.sid)}
            />
          );
        }}
        ListEmptyComponent={
          <View className="p-8 items-center">
            <Text className="text-gray-500">No sessions yet</Text>
          </View>
        }
      />

      {/* Worktree Creation */}
      <View className="px-4 py-3 border-t border-zinc-700">
        {showWorktreeForm ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-1.5 text-sm font-mono"
              placeholder="branch-name"
              placeholderTextColor="#555"
              value={branchInput}
              onChangeText={setBranchInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              onPress={createWorktree}
              disabled={!branchInput.trim()}
              className="bg-blue-600 px-3 py-1.5 rounded-lg"
              style={{ opacity: branchInput.trim() ? 1 : 0.4 }}
            >
              <Text className="text-white text-xs">Create</Text>
            </Pressable>
            <Pressable onPress={() => setShowWorktreeForm(false)}>
              <Text className="text-gray-500 text-xs">Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setShowWorktreeForm(true)}
            className="border border-zinc-600 rounded-lg py-2 items-center"
          >
            <Text className="text-gray-400 text-xs">New Worktree</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
