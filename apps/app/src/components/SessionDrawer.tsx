import type {
  WsClientMessage,
  WsSessionMeta,
} from "@teleprompter/protocol/client";
import { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { getDaemonClient } from "../hooks/use-daemon";
import { useChatStore } from "../stores/chat-store";
import { useSessionStore } from "../stores/session-store";

function SessionItem({
  session,
  isActive,
  onPress,
  onStop,
  onRestart,
  onExport,
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
      ? "bg-tp-success"
      : session.state === "stopped"
        ? "bg-tp-text-tertiary"
        : "bg-tp-error";

  return (
    <Pressable
      onPress={onPress}
      className={`px-4 py-3 border-b border-tp-border ${isActive ? "bg-tp-surface-active" : ""}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <View className={`w-2 h-2 rounded-full ${stateColor} mr-2`} />
          <View className="flex-1">
            <Text
              className="text-tp-text-primary text-sm font-mono"
              numberOfLines={1}
            >
              {session.sid}
            </Text>
            <Text className="text-tp-text-secondary text-xs" numberOfLines={1}>
              {session.cwd}
            </Text>
            {session.worktreePath && (
              <Text className="text-tp-text-tertiary text-xs" numberOfLines={1}>
                wt: {session.worktreePath}
              </Text>
            )}
            {session.claudeVersion && (
              <Text className="text-tp-text-tertiary text-xs">
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
    grouped.get(key)?.push(s);
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
    <View className="flex-1 bg-tp-bg-secondary">
      <View className="px-4 py-3 border-b border-tp-border">
        <View className="flex-row items-center justify-between mb-2">
          <Text className="text-tp-text-primary font-bold">Sessions</Text>
          <Text className="text-tp-text-secondary text-xs">
            {filteredSessions.length}/{sessions.length}
          </Text>
        </View>
        {sessions.length > 3 && (
          <TextInput
            className="bg-tp-bg-tertiary text-tp-text-primary rounded-lg px-3 py-1.5 text-sm"
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
        keyExtractor={(item, _i) =>
          item.type === "header" ? `h-${item.key}` : `s-${item.session.sid}`
        }
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <View className="px-4 py-2 bg-tp-bg">
                <Text className="text-tp-text-tertiary text-xs font-mono">
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
            <Text className="text-tp-text-secondary">No sessions yet</Text>
          </View>
        }
      />

      {/* Worktree Creation */}
      <View className="px-4 py-3 border-t border-tp-border">
        {showWorktreeForm ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              className="flex-1 bg-tp-bg-tertiary text-tp-text-primary rounded-lg px-3 py-1.5 text-sm font-mono"
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
              className="bg-tp-accent px-3 py-1.5 rounded-lg"
              style={{ opacity: branchInput.trim() ? 1 : 0.4 }}
            >
              <Text className="text-tp-text-primary text-xs">Create</Text>
            </Pressable>
            <Pressable onPress={() => setShowWorktreeForm(false)}>
              <Text className="text-tp-text-secondary text-xs">Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setShowWorktreeForm(true)}
            className="border border-tp-border rounded-lg py-2 items-center"
          >
            <Text className="text-tp-text-tertiary text-xs">New Worktree</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
