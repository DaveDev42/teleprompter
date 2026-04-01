import { useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSessionStore } from "../../src/stores/session-store";
import { useThemeStore } from "../../src/stores/theme-store";
import type { WsSessionMeta } from "@teleprompter/protocol/client";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SessionRow({
  session,
  isActive,
  onPress,
}: {
  session: WsSessionMeta;
  isActive: boolean;
  onPress: () => void;
}) {
  const isDark = useThemeStore((s) => s.isDark);
  const running = session.state === "running";

  // Extract a description from cwd (last path segment)
  const desc = session.cwd.split("/").pop() ?? session.cwd;

  return (
    <Pressable onPress={onPress}>
      <View
        className={`flex-row items-center py-4 mx-4 ${
          isActive
            ? isDark
              ? "bg-tp-bg-secondary rounded-lg px-3"
              : "bg-tp-bg-secondary rounded-lg px-3"
            : ""
        }`}
      >
        {/* Active indicator */}
        {isActive && (
          <View className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full bg-tp-accent" />
        )}

        {/* Status dot */}
        <View
          className={`w-2 h-2 rounded-full mr-3 ${
            running ? "bg-tp-success" : "bg-tp-text-tertiary"
          }`}
        />

        {/* Content */}
        <View className="flex-1">
          <Text
            className="text-tp-text-primary text-[15px] font-semibold"
            numberOfLines={1}
          >
            {desc}
          </Text>
          <Text
            className="text-tp-text-secondary text-[13px] mt-0.5"
            numberOfLines={1}
          >
            {session.sid}
            {session.worktreePath ? ` · ${session.worktreePath}` : ""}
          </Text>
        </View>

        {/* Time */}
        <Text className="text-tp-text-tertiary text-[11px] ml-2">
          {timeAgo(session.updatedAt)}
        </Text>

        {/* Chevron */}
        <Text className="text-tp-text-tertiary text-lg ml-2">›</Text>
      </View>

      {/* Divider */}
      {!isActive && (
        <View className="h-[0.5px] bg-tp-border ml-[52px] mr-4" />
      )}
    </Pressable>
  );
}

export default function SessionsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const sessions = useSessionStore((s) => s.sessions);
  const currentSid = useSessionStore((s) => s.sid);
  const [filter, setFilter] = useState("");

  // Sort by updatedAt desc, filter by search
  const filteredSessions = useMemo(() => {
    let list = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter.trim()) {
      const q = filter.toLowerCase();
      list = list.filter(
        (s) =>
          s.sid.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.worktreePath?.toLowerCase().includes(q) ||
          s.state.toLowerCase().includes(q),
      );
    }
    return list;
  }, [sessions, filter]);

  const handleSessionPress = (session: WsSessionMeta) => {
    router.push(`/session/${session.sid}`);
  };

  return (
    <View className="flex-1 bg-tp-bg" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="px-4 pt-2 pb-1">
        <Text className="text-tp-text-primary text-[28px] font-bold">
          Sessions
        </Text>
      </View>

      {/* Search */}
      {sessions.length > 2 && (
        <View className="px-4 py-2">
          <TextInput
            className="bg-tp-bg-secondary text-tp-text-primary rounded-search px-4 py-2.5 text-[15px]"
            placeholder="Search sessions..."
            placeholderTextColor="var(--tp-text-tertiary)"
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
          />
        </View>
      )}

      {/* Session list */}
      <FlatList
        data={filteredSessions}
        keyExtractor={(item) => item.sid}
        renderItem={({ item }) => (
          <SessionRow
            session={item}
            isActive={item.sid === currentSid}
            onPress={() => handleSessionPress(item)}
          />
        )}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center pt-40">
            <View className="w-16 h-16 rounded-2xl bg-tp-bg-secondary items-center justify-center mb-6">
              <Text className="text-[28px]">💬</Text>
            </View>
            <Text className="text-tp-text-primary text-xl font-semibold mb-2">
              No active sessions
            </Text>
            <Text className="text-tp-text-secondary text-[15px] text-center leading-6 px-8">
              Start a new session from the{"\n"}Daemons tab or run tp on your
              machine.
            </Text>
            <Pressable
              onPress={() => router.push("/(tabs)/daemons")}
              className="mt-6 bg-tp-accent rounded-card px-8 py-3"
            >
              <Text className="text-white font-semibold text-base">
                Go to Daemons
              </Text>
            </Pressable>
          </View>
        }
        contentContainerStyle={
          filteredSessions.length === 0 ? { flex: 1 } : undefined
        }
      />
    </View>
  );
}
