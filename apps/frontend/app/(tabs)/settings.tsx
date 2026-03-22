import { useState } from "react";
import { View, Text, TextInput, Pressable, Platform, ScrollView } from "react-native";
import { useVoiceStore } from "../../src/stores/voice-store";
import { usePairingStore } from "../../src/stores/pairing-store";
import { DiagnosticsPanel } from "../../src/components/DiagnosticsPanel";

export default function SettingsScreen() {
  const apiKey = useVoiceStore((s) => s.apiKey);
  const setApiKey = useVoiceStore((s) => s.setApiKey);
  const pairingState = usePairingStore((s) => s.state);
  const pairingInfo = usePairingStore((s) => s.info);
  const resetPairing = usePairingStore((s) => s.reset);

  const [keyInput, setKeyInput] = useState(apiKey ?? "");
  const [saved, setSaved] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const handleSave = () => {
    const key = keyInput.trim();
    if (key) {
      setApiKey(key);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (showDiagnostics) {
    return (
      <View className="flex-1 bg-black">
        <View className="flex-row items-center justify-between px-6 pt-10 pb-4">
          <Text className="text-white text-2xl font-bold">Diagnostics</Text>
          <Pressable onPress={() => setShowDiagnostics(false)}>
            <Text className="text-blue-400">Done</Text>
          </Pressable>
        </View>
        <DiagnosticsPanel />
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-black px-6 pt-10">
      <Text className="text-white text-2xl font-bold mb-8">Settings</Text>

      {/* Voice API Key */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">
          OpenAI API Key (for Voice)
        </Text>
        <TextInput
          className="bg-zinc-800 text-white rounded-lg px-4 py-3 font-mono text-sm mb-3"
          placeholder="sk-..."
          placeholderTextColor="#555"
          value={keyInput}
          onChangeText={setKeyInput}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          onPress={handleSave}
          disabled={!keyInput.trim()}
          className="bg-blue-600 rounded-lg py-2 items-center"
          style={{ opacity: keyInput.trim() ? 1 : 0.4 }}
        >
          <Text className="text-white font-bold">
            {saved ? "Saved!" : "Save Key"}
          </Text>
        </Pressable>
        {Platform.OS === "web" && (
          <Text className="text-gray-600 text-xs mt-2">
            Key is stored in memory only (cleared on page refresh).
          </Text>
        )}
      </View>

      {/* Pairing Status */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">Daemon Pairing</Text>
        <View className="bg-zinc-800 rounded-lg px-4 py-3">
          <View className="flex-row items-center">
            <View
              className={`w-2 h-2 rounded-full mr-2 ${pairingState === "paired" ? "bg-green-500" : "bg-gray-500"}`}
            />
            <Text className="text-white text-sm">
              {pairingState === "paired" ? "Paired" : "Not paired"}
            </Text>
          </View>
          {pairingInfo && (
            <>
              <Text className="text-gray-500 text-xs mt-1 font-mono">
                Daemon: {pairingInfo.daemonId}
              </Text>
              <Text className="text-gray-500 text-xs font-mono">
                Relay: {pairingInfo.relayUrl}
              </Text>
            </>
          )}
        </View>
        {pairingState === "paired" && (
          <Pressable
            onPress={resetPairing}
            className="mt-2 border border-red-800 rounded-lg py-2 items-center"
          >
            <Text className="text-red-400 text-sm">Unpair</Text>
          </Pressable>
        )}
      </View>

      {/* Diagnostics */}
      <View className="mb-8">
        <Pressable
          onPress={() => setShowDiagnostics(true)}
          className="border border-zinc-700 rounded-lg py-3 items-center"
        >
          <Text className="text-gray-300 text-sm">Diagnostics</Text>
        </Pressable>
      </View>

      {/* Version */}
      <View className="mb-10">
        <Text className="text-gray-600 text-xs">
          Teleprompter v0.1.0
        </Text>
      </View>
    </View>
  );
}
