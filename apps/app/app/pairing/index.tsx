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
      <View className="flex-1 bg-tp-bg items-center justify-center">
        <ActivityIndicator size="large" />
        <Text className="text-tp-text-secondary mt-4">
          Processing pairing data...
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-tp-bg px-6 pt-20">
      <Text className="text-tp-text-primary text-2xl font-bold text-center">
        Pair with Daemon
      </Text>
      <Text className="text-tp-text-secondary text-center mt-2 mb-8">
        Scan the QR code shown by your daemon, or paste the pairing data below.
      </Text>

      {error && (
        <View className="bg-tp-error/20 border border-tp-error rounded-lg px-4 py-3 mb-4">
          <Text className="text-tp-error text-sm">{error}</Text>
        </View>
      )}

      {/* Manual paste input (works on all platforms) */}
      <Text className="text-tp-text-secondary text-sm mb-2">
        Paste pairing data:
      </Text>
      <TextInput
        className="bg-tp-bg-input text-tp-text-primary rounded-lg px-4 py-3 font-mono text-xs mb-4"
        placeholder="tp://p?d=..."
        placeholderTextColor="var(--tp-text-tertiary)"
        value={manualInput}
        onChangeText={setManualInput}
        multiline
        numberOfLines={4}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ minHeight: 100, textAlignVertical: "top" }}
      />

      {preview && (
        <View className="bg-tp-bg-elevated border border-tp-border rounded-lg px-4 py-3 mb-4">
          <Text className="text-tp-text-tertiary text-xs uppercase mb-1">
            Pairing with
          </Text>
          <Text className="text-tp-text-primary text-base font-semibold font-mono">
            {preview.did}
          </Text>
          <Text className="text-tp-text-tertiary text-xs mt-1">
            via {preview.relay.replace(/^wss:\/\//, "")}
          </Text>
        </View>
      )}

      <Pressable
        onPress={handlePaste}
        disabled={!manualInput.trim()}
        className="bg-tp-accent rounded-lg py-3 items-center"
        style={{ opacity: manualInput.trim() ? 1 : 0.4 }}
      >
        <Text className="text-tp-text-on-color font-bold">
          {preview ? "Confirm pairing" : "Connect"}
        </Text>
      </Pressable>

      {Platform.OS !== "web" && (
        <>
          <View className="flex-row items-center my-6">
            <View className="flex-1 h-px bg-tp-border" />
            <Text className="text-tp-text-tertiary mx-3">or</Text>
            <View className="flex-1 h-px bg-tp-border" />
          </View>

          <Pressable
            onPress={() => router.push("/pairing/scan")}
            className="border border-tp-border rounded-lg py-3 items-center"
          >
            <Text className="text-tp-text-primary">Scan QR Code</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
