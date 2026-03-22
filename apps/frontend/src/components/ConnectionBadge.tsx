import { View, Text } from "react-native";
import { useSessionStore } from "../stores/session-store";

/**
 * Shows connection status and last seen time.
 * Appears as a small badge in headers.
 */
export function ConnectionBadge() {
  const connected = useSessionStore((s) => s.connected);
  const sid = useSessionStore((s) => s.sid);
  const sessions = useSessionStore((s) => s.sessions);

  const currentSession = sessions.find((s) => s.sid === sid);
  const lastSeen = currentSession?.updatedAt;

  return (
    <View className="flex-row items-center gap-1">
      <View
        className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
      />
      {!connected && lastSeen && (
        <Text className="text-gray-500 text-xs">
          {formatRelativeTime(lastSeen)}
        </Text>
      )}
    </View>
  );
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
