import { decodePairingData } from "@teleprompter/protocol/client";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
  const params = useLocalSearchParams<{ pairingData?: string }>();
  const { state, error, processScan } = usePairingStore();
  const [manualInput, setManualInput] = useState(params.pairingData ?? "");

  // Preview the daemon being requested when arriving via deep link, so the
  // user has to explicitly confirm rather than be paired automatically.
  // Label is no longer in the QR — the daemon broadcasts it during relay
  // key exchange — so the preview shows the daemon ID until kx completes.
  const preview = useMemo(() => {
    const text = manualInput.trim();
    if (!text) return null;
    try {
      const data = decodePairingData(text);
      return {
        did: data.did,
        relay: data.relay,
      };
    } catch {
      return null;
    }
  }, [manualInput]);

  // Sync incoming deep-link payload into the input on mount/update.
  useEffect(() => {
    if (params.pairingData && params.pairingData !== manualInput) {
      setManualInput(params.pairingData);
    }
    // We intentionally do not depend on manualInput — only react to the param.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  }, [params.pairingData]);

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
      <Text className="text-gray-400 text-sm mb-2">Paste pairing data:</Text>
      <TextInput
        className="bg-zinc-800 text-white rounded-lg px-4 py-3 font-mono text-xs mb-4"
        placeholder="tp://p?d=..."
        placeholderTextColor="#555"
        value={manualInput}
        onChangeText={setManualInput}
        multiline
        numberOfLines={4}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ minHeight: 100, textAlignVertical: "top" }}
      />

      {preview && (
        <View className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 mb-4">
          <Text className="text-gray-500 text-xs uppercase mb-1">
            Pairing with
          </Text>
          <Text className="text-white text-base font-semibold font-mono">
            {preview.did}
          </Text>
          <Text className="text-gray-500 text-xs mt-1">
            via {preview.relay.replace(/^wss:\/\//, "")}
          </Text>
        </View>
      )}

      <Pressable
        onPress={handlePaste}
        disabled={!manualInput.trim()}
        className="bg-blue-600 rounded-lg py-3 items-center"
        style={{ opacity: manualInput.trim() ? 1 : 0.4 }}
      >
        <Text className="text-white font-bold">
          {preview ? "Confirm pairing" : "Connect"}
        </Text>
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
