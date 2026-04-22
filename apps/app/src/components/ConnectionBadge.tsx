import { Text, View } from "react-native";
import { useAnyRelayConnected } from "../hooks/use-relay";
import { useSessionStore } from "../stores/session-store";

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

/**
 * Pill-style connection badge with themed colors.
 */
export function ConnectionBadge() {
  const connected = useAnyRelayConnected();
  const sid = useSessionStore((s) => s.sid);
  const sessions = useSessionStore((s) => s.sessions);

  const currentSession = sessions.find((s) => s.sid === sid);
  const lastSeen = currentSession?.updatedAt;

  if (connected) {
    return (
      <View
        className="flex-row items-center rounded-full px-2 py-0.5"
        accessibilityLabel="Connected"
        accessibilityRole="text"
      >
        <View className="w-1.5 h-1.5 rounded-full bg-tp-success mr-1.5" />
        <Text className="text-tp-success text-[11px] font-medium">
          Connected
        </Text>
      </View>
    );
  }

  return (
    <View
      className="flex-row items-center"
      accessibilityLabel={
        lastSeen
          ? `Disconnected, last seen ${formatRelativeTime(lastSeen)}`
          : "Disconnected"
      }
      accessibilityRole="text"
    >
      <View className="w-1.5 h-1.5 rounded-full bg-tp-text-tertiary mr-1.5" />
      {lastSeen && (
        <Text className="text-tp-text-tertiary text-[11px]">
          {formatRelativeTime(lastSeen)}
        </Text>
      )}
    </View>
  );
}
