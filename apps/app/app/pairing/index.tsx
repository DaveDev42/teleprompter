import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { usePairingStore } from "../../src/stores/pairing-store";

export default function PairingScreen() {
  const router = useRouter();
  const { state, error, processScan } = usePairingStore();
  const [manualInput, setManualInput] = useState("");

  const handlePaste = async () => {
    const text = manualInput.trim();
    if (!text) return;
    await processScan(text);
    if (usePairingStore.getState().state === "paired") {
      router.replace("/");
    }
  };

  if (state === "pairing") {
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <ActivityIndicator size="large" color="#fff" />
        <Text className="text-gray-400 mt-4">Processing pairing data...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black px-6 pt-20">
      <Text className="text-white text-2xl font-bold text-center">
        Pair with Daemon
      </Text>
      <Text className="text-gray-400 text-center mt-2 mb-8">
        Scan the QR code shown by your daemon, or paste the pairing data below.
      </Text>

      {error && (
        <View className="bg-red-900/50 border border-red-500 rounded-lg px-4 py-3 mb-4">
          <Text className="text-red-300 text-sm">{error}</Text>
        </View>
      )}

      {/* Manual paste input (works on all platforms) */}
      <Text className="text-gray-400 text-sm mb-2">
        Paste pairing data (JSON):
      </Text>
      <TextInput
        className="bg-zinc-800 text-white rounded-lg px-4 py-3 font-mono text-xs mb-4"
        placeholder='{"ps":"...","pk":"...","relay":"...","did":"...","v":1}'
        placeholderTextColor="#555"
        value={manualInput}
        onChangeText={setManualInput}
        multiline
        numberOfLines={4}
        style={{ minHeight: 100, textAlignVertical: "top" }}
      />

      <Pressable
        onPress={handlePaste}
        disabled={!manualInput.trim()}
        className="bg-blue-600 rounded-lg py-3 items-center"
        style={{ opacity: manualInput.trim() ? 1 : 0.4 }}
      >
        <Text className="text-white font-bold">Connect</Text>
      </Pressable>

      {Platform.OS !== "web" && (
        <>
          <View className="flex-row items-center my-6">
            <View className="flex-1 h-px bg-zinc-700" />
            <Text className="text-gray-500 mx-3">or</Text>
            <View className="flex-1 h-px bg-zinc-700" />
          </View>

          <Pressable
            onPress={() => router.push("/pairing/scan")}
            className="border border-zinc-600 rounded-lg py-3 items-center"
          >
            <Text className="text-white">Scan QR Code</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
