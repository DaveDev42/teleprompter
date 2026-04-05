import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePlatformProps } from "../../src/hooks/use-platform-props";
import { useRelayConnectionStore } from "../../src/hooks/use-relay";
import type { PairingInfo } from "../../src/stores/pairing-store";
import { usePairingStore } from "../../src/stores/pairing-store";
import { useSessionStore } from "../../src/stores/session-store";
import { useThemeStore } from "../../src/stores/theme-store";

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

function DaemonCard({ info }: { info: PairingInfo }) {
  const connections = useRelayConnectionStore((s) => s.connections);
  const sessions = useSessionStore((s) => s.sessions);
  useThemeStore((s) => s.isDark);
  const pp = usePlatformProps();
  const isOnline = connections.get(info.daemonId) ?? false;

  // Count active sessions for this daemon (approximation — sessions don't track daemonId yet)
  const sessionCount = sessions.length;

  // Short daemon ID for display
  const shortId = info.daemonId.slice(0, 8);
  // Derive a display name from daemonId
  const displayName = shortId;

  return (
    <View
      className="mx-4 mb-4 rounded-bubble bg-tp-surface border border-tp-border overflow-hidden"
      accessibilityLabel={`Daemon ${displayName}, ${isOnline ? "connected" : "offline"}, ${sessionCount} sessions`}
    >
      {/* Header row */}
      <View className="flex-row items-center px-4 pt-4 pb-2">
        <View
          className={`w-2.5 h-2.5 rounded-full mr-2.5 ${
            isOnline ? "bg-tp-success" : "bg-tp-text-tertiary"
          }`}
        />
        <Text className="text-tp-text-primary text-[17px] font-semibold flex-1">
          {displayName}
        </Text>
        <Text
          className={`text-xs font-medium ${
            isOnline ? "text-tp-success" : "text-tp-text-tertiary"
          }`}
        >
          {isOnline ? "Connected" : `Last seen ${timeAgo(info.pairedAt)}`}
        </Text>
      </View>

      {/* Info rows */}
      <View className="px-4 py-2">
        <View className="flex-row justify-between py-1">
          <Text className="text-tp-text-secondary text-[13px]">Relay</Text>
          <Text className="text-tp-text-primary text-[13px]">
            {info.relayUrl.replace("wss://", "")}
          </Text>
        </View>
        <View className="flex-row justify-between py-1">
          <Text className="text-tp-text-secondary text-[13px]">
            Active Sessions
          </Text>
          <Text className="text-tp-text-primary text-[13px]">
            {sessionCount}
          </Text>
        </View>
      </View>

      {/* Action buttons */}
      <View className="flex-row px-4 pb-4 gap-2">
        {isOnline ? (
          <>
            <Pressable
              className={`flex-1 bg-tp-accent rounded-btn py-2 items-center ${pp.className ?? ""}`}
              tabIndex={pp.tabIndex}
              accessibilityRole="button"
              accessibilityLabel={`New session on ${displayName}`}
            >
              <Text className="text-white text-[13px] font-medium">
                New Session
              </Text>
            </Pressable>
            <Pressable
              className={`flex-1 bg-tp-bg-tertiary rounded-btn py-2 items-center ${pp.className ?? ""}`}
              tabIndex={pp.tabIndex}
              accessibilityRole="button"
              accessibilityLabel={`View status of ${displayName}`}
            >
              <Text className="text-tp-text-primary text-[13px] font-medium">
                View Status
              </Text>
            </Pressable>
          </>
        ) : (
          <Text className="text-tp-text-tertiary text-xs py-2">
            Waiting for daemon to come online...
          </Text>
        )}
      </View>
    </View>
  );
}

export default function DaemonsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pairings = usePairingStore((s) => s.pairings);
  const pp = usePlatformProps();

  const pairingList = [...pairings.values()];

  return (
    <View className="flex-1 bg-tp-bg" style={{ paddingTop: insets.top }}>
      {/* Header */}
      <View className="flex-row items-center justify-between px-4 pt-2 pb-4">
        <Text
          className="text-tp-text-primary text-[28px] font-bold"
          accessibilityRole="header"
        >
          Daemons
        </Text>
        <Pressable
          onPress={() => router.push("/pairing")}
          className={`w-8 h-8 rounded-btn bg-tp-accent items-center justify-center ${pp.className ?? ""}`}
          tabIndex={pp.tabIndex}
          accessibilityRole="button"
          accessibilityLabel="Add daemon"
        >
          <Text className="text-white text-xl leading-5">+</Text>
        </Pressable>
      </View>

      {pairingList.length > 0 ? (
        <ScrollView>
          {pairingList.map((info) => (
            <DaemonCard key={info.daemonId} info={info} />
          ))}
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-8">
          <View className="w-16 h-16 rounded-2xl bg-tp-bg-secondary items-center justify-center mb-6">
            <Text className="text-[28px]">🖥</Text>
          </View>
          <Text className="text-tp-text-primary text-xl font-semibold mb-2">
            No daemons connected
          </Text>
          <Text className="text-tp-text-secondary text-[15px] text-center leading-6 mb-6">
            Connect to a daemon to start{"\n"}controlling Claude Code remotely.
          </Text>

          <Text className="text-tp-text-tertiary text-[13px] text-center leading-5 mb-6">
            1. Run tp daemon start on your machine{"\n"}
            2. Run tp pair to generate a QR code{"\n"}
            3. Scan the QR code below to connect
          </Text>

          <Pressable
            onPress={() => router.push("/pairing/scan")}
            className={`w-full bg-tp-accent rounded-card py-4 items-center mb-3 ${pp.className ?? ""}`}
            tabIndex={pp.tabIndex}
            accessibilityRole="button"
            accessibilityLabel="Scan QR code to pair"
          >
            <Text className="text-white font-semibold text-base">
              Scan QR Code to Pair
            </Text>
          </Pressable>

          <Pressable
            onPress={() => router.push("/pairing")}
            tabIndex={pp.tabIndex}
            className={pp.className}
            accessibilityRole="link"
            accessibilityLabel="Enter pairing data manually"
          >
            <Text className="text-tp-accent text-[13px]">
              or enter pairing data manually
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
