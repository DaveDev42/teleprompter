import { View, Text } from "react-native";
import { useSessionStore } from "../src/stores/session-store";

export default function ChatScreen() {
  const connected = useSessionStore((s) => s.connected);

  return (
    <View className="flex-1 bg-black items-center justify-center">
      <Text className="text-white text-xl font-bold">Teleprompter</Text>
      <Text className="text-gray-400 mt-2">Chat Tab</Text>
      <View className="mt-4 flex-row items-center gap-2">
        <View
          className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`}
        />
        <Text className="text-gray-500 text-sm">
          {connected ? "Connected" : "Disconnected"}
        </Text>
      </View>
    </View>
  );
}
