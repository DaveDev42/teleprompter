import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { DiagnosticsPanel } from "../../src/components/DiagnosticsPanel";
import { secureGet, secureSet } from "../../src/lib/secure-storage";
import { useConnectionStore } from "../../src/stores/connection-store";
import { usePairingStore } from "../../src/stores/pairing-store";
import { useRelaySettingsStore } from "../../src/stores/relay-settings-store";
import { type Theme, useThemeStore } from "../../src/stores/theme-store";
import { useVoiceStore } from "../../src/stores/voice-store";

export default function SettingsScreen() {
  const router = useRouter();
  const apiKey = useVoiceStore((s) => s.apiKey);
  const setApiKey = useVoiceStore((s) => s.setApiKey);
  const _pairingState = usePairingStore((s) => s.state);
  const pairings = usePairingStore((s) => s.pairings);
  const activeDaemonId = usePairingStore((s) => s.activeDaemonId);
  const setActiveDaemon = usePairingStore((s) => s.setActiveDaemon);
  const removePairing = usePairingStore((s) => s.removePairing);
  const _resetPairing = usePairingStore((s) => s.reset);

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const relays = useRelaySettingsStore((s) => s.relays);
  const loadRelays = useRelaySettingsStore((s) => s.load);
  const addRelay = useRelaySettingsStore((s) => s.addRelay);
  const removeRelay = useRelaySettingsStore((s) => s.removeRelay);
  const toggleRelay = useRelaySettingsStore((s) => s.toggleRelay);

  const daemonUrl = useConnectionStore((s) => s.daemonUrl);
  const setDaemonUrl = useConnectionStore((s) => s.setDaemonUrl);

  const [keyInput, setKeyInput] = useState(apiKey ?? "");
  const [daemonUrlInput, setDaemonUrlInput] = useState(daemonUrl ?? "");
  const [relayInput, setRelayInput] = useState("");
  const [saved, setSaved] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // Load persisted data on mount
  useEffect(() => {
    secureGet("openai_api_key").then((key) => {
      if (key && !apiKey) {
        setApiKey(key);
        setKeyInput(key);
      }
    });
    loadRelays();
  }, [setApiKey, loadRelays, apiKey]);

  const handleSave = async () => {
    const key = keyInput.trim();
    if (key) {
      setApiKey(key);
      await secureSet("openai_api_key", key);
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

      {/* Daemon Connection */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">Daemon URL</Text>
        <View className="flex-row items-center gap-2">
          <TextInput
            className="flex-1 bg-zinc-800 text-white rounded-lg px-4 py-3 font-mono text-sm"
            placeholder="Auto-detect (ws://localhost:7080)"
            placeholderTextColor="#555"
            value={daemonUrlInput}
            onChangeText={setDaemonUrlInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={async () => {
              const url = daemonUrlInput.trim() || null;
              await setDaemonUrl(url);
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            }}
            className="bg-blue-600 px-3 py-3 rounded-lg"
          >
            <Text className="text-white text-sm">Set</Text>
          </Pressable>
        </View>
        <Text className="text-gray-600 text-xs mt-1">
          Leave empty for auto-detection. Set manually for remote daemons.
        </Text>
      </View>

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
        <Text className="text-gray-600 text-xs mt-2">
          {Platform.OS === "web"
            ? "Key stored in localStorage."
            : "Key stored in secure Keychain/Keystore."}
        </Text>
      </View>

      {/* Theme */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">Theme</Text>
        <View className="flex-row gap-2">
          {(["dark", "light", "system"] as Theme[]).map((t) => (
            <Pressable
              key={t}
              onPress={() => setTheme(t)}
              className={`flex-1 py-2 rounded-lg items-center ${theme === t ? "bg-blue-600" : "bg-zinc-800"}`}
            >
              <Text
                className={`text-sm ${theme === t ? "text-white" : "text-gray-400"}`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Paired Daemons */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">
          Paired Daemons ({pairings.size})
        </Text>
        {[...pairings.values()].map((info) => {
          const isActive = activeDaemonId === info.daemonId;
          return (
            <Pressable
              key={info.daemonId}
              onPress={() => setActiveDaemon(info.daemonId)}
              className={`flex-row items-center justify-between rounded-lg px-4 py-2 mb-1 ${isActive ? "bg-blue-900/40 border border-blue-800" : "bg-zinc-800"}`}
            >
              <View className="flex-1">
                <View className="flex-row items-center">
                  <View
                    className={`w-2 h-2 rounded-full mr-2 ${isActive ? "bg-blue-400" : "bg-gray-500"}`}
                  />
                  <Text
                    className="text-white text-sm font-mono"
                    numberOfLines={1}
                  >
                    {info.daemonId}
                  </Text>
                </View>
                <Text
                  className="text-gray-500 text-xs font-mono ml-4"
                  numberOfLines={1}
                >
                  {info.relayUrl}
                </Text>
              </View>
              <Pressable onPress={() => removePairing(info.daemonId)}>
                <Text className="text-red-400 text-xs ml-2">Unpair</Text>
              </Pressable>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => router.push("/pairing")}
          className="mt-2 bg-blue-600 rounded-lg py-2 items-center"
        >
          <Text className="text-white text-sm">Pair with Daemon</Text>
        </Pressable>
      </View>

      {/* Relay Endpoints */}
      <View className="mb-8">
        <Text className="text-gray-400 text-sm mb-2">Relay Servers</Text>
        {relays.map((r) => (
          <View
            key={r.url}
            className="flex-row items-center justify-between bg-zinc-800 rounded-lg px-4 py-2 mb-1"
          >
            <Pressable
              onPress={() => toggleRelay(r.url)}
              className="flex-1 flex-row items-center"
            >
              <View
                className={`w-2 h-2 rounded-full mr-2 ${r.active ? "bg-green-500" : "bg-gray-600"}`}
              />
              <Text
                className={`text-sm font-mono ${r.active ? "text-white" : "text-gray-500"}`}
                numberOfLines={1}
              >
                {r.label}
              </Text>
            </Pressable>
            <Pressable onPress={() => removeRelay(r.url)}>
              <Text className="text-red-400 text-xs ml-2">Remove</Text>
            </Pressable>
          </View>
        ))}
        <View className="flex-row items-center mt-2">
          <TextInput
            className="flex-1 bg-zinc-800 text-white rounded-lg px-3 py-2 text-sm font-mono mr-2"
            placeholder="wss://relay.example.com"
            placeholderTextColor="#555"
            value={relayInput}
            onChangeText={setRelayInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={() => {
              if (relayInput.trim()) {
                addRelay(relayInput.trim());
                setRelayInput("");
              }
            }}
            disabled={!relayInput.trim()}
            className="bg-blue-600 px-3 py-2 rounded-lg"
            style={{ opacity: relayInput.trim() ? 1 : 0.4 }}
          >
            <Text className="text-white text-sm">Add</Text>
          </Pressable>
        </View>
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
        <Text className="text-gray-600 text-xs">Teleprompter v0.1.0</Text>
      </View>
    </ScrollView>
  );
}
