import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { getRelayClient, useRelayConnectionStore } from "../hooks/use-relay";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
import { labelValueOf } from "../lib/pairing-label";
import { getPalette } from "../lib/tokens";
import { useNotificationStore } from "../stores/notification-store";
import { usePairingStore } from "../stores/pairing-store";
import { useSessionStore } from "../stores/session-store";
import { useThemeStore } from "../stores/theme-store";
import { ModalContainer } from "./ModalContainer";

export function NewSessionModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = getPalette(isDark).textTertiary;

  const pairings = usePairingStore((s) => s.pairings);
  const pairingList = [...pairings.values()];
  const connections = useRelayConnectionStore((s) => s.connections);

  const [cwd, setCwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedDaemonId, setSelectedDaemonId] = useState<string | null>(null);

  // On open: reset state, pre-select first online daemon (fallback: first paired)
  useEffect(() => {
    if (!visible) return;
    setCwd("");
    setError(null);

    const firstOnline = pairingList.find(
      (info) => connections.get(info.daemonId) ?? false,
    );
    const firstAny = pairingList[0];
    setSelectedDaemonId(
      firstOnline?.daemonId ?? firstAny?.daemonId ?? null,
    );
    // pairingList / connections are derived from stores — stable string keys
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-run when visible flips true
  }, [visible]);

  const isDisabled = cwd.trim() === "" || selectedDaemonId === null;

  // Mirror disabled state to aria-disabled on web (same pattern as RenamePairingModal)
  const startRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!visible) return;
    const el = startRef.current as unknown as HTMLElement | null;
    if (!el) return;
    if (isDisabled) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
  }, [visible, isDisabled]);

  // Pending-sid timeout watcher: track session sids before sending so we can
  // detect when a new session appears (onState auto-select path)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beforeSidsRef = useRef<Set<string>>(new Set());

  // Clear pending timer when a new sid appears in the store
  useEffect(() => {
    if (!visible) return;
    const currentSids = new Set(
      useSessionStore.getState().sessions.map((s) => s.sid),
    );
    for (const sid of currentSids) {
      if (!beforeSidsRef.current.has(sid)) {
        // New session appeared — clear the timeout
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        return;
      }
    }
  });

  // Subscribe to session list changes to clear timer when new session arrives
  useEffect(() => {
    if (!visible) return;
    return useSessionStore.subscribe((state) => {
      const currentSids = new Set(state.sessions.map((s) => s.sid));
      for (const sid of currentSids) {
        if (!beforeSidsRef.current.has(sid)) {
          if (pendingTimerRef.current) {
            clearTimeout(pendingTimerRef.current);
            pendingTimerRef.current = null;
          }
          break;
        }
      }
    });
  }, [visible]);

  const handleStart = () => {
    const trimmed = cwd.trim();
    if (trimmed === "") {
      setError("Working directory is required.");
      return;
    }
    if (selectedDaemonId === null) {
      setError("No daemon selected.");
      return;
    }
    const client = getRelayClient(selectedDaemonId);
    if (!client || !client.isConnected()) {
      setError("Daemon offline — try again.");
      return;
    }

    // Capture current sids before sending
    beforeSidsRef.current = new Set(
      useSessionStore.getState().sessions.map((s) => s.sid),
    );

    client.createSession(trimmed);

    // Start timeout watcher: if no new session appears in 3s, show toast
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      useNotificationStore.getState().showToast({
        title: "Couldn't start session",
        body: "The daemon rejected the request — check the path.",
      });
    }, 3000);

    // Optimistically close the modal
    onClose();
  };

  const multiDaemon = pairingList.length >= 2;

  return (
    <ModalContainer
      visible={visible}
      onClose={onClose}
      accessibilityLabel="New Session"
      accessibilityLabelledBy="new-session-modal-title"
    >
      <View className="px-5 pt-5 pb-6">
        {/* Header row */}
        <View className="flex-row items-center justify-between pb-3">
          <Pressable
            className={pp.className}
            tabIndex={pp.tabIndex}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel new session"
          >
            <Text className="text-tp-text-secondary text-base">Cancel</Text>
          </Pressable>

          <Text
            nativeID="new-session-modal-title"
            className="text-tp-text-primary text-lg font-bold"
            accessibilityRole="header"
            {...ariaLevel(2)}
          >
            New Session
          </Text>

          <Pressable
            ref={startRef}
            className={`${pp.className} ${isDisabled ? "opacity-40" : ""}`}
            tabIndex={pp.tabIndex}
            onPress={handleStart}
            accessibilityRole="button"
            accessibilityLabel="Start session"
            accessibilityState={{ disabled: isDisabled }}
            testID="new-session-start"
          >
            <Text className="text-tp-accent text-base font-semibold">Start</Text>
          </Pressable>
        </View>

        {/* Daemon selector */}
        {multiDaemon ? (
          // N≥2 daemons: radiogroup
          <View
            accessibilityRole="radiogroup"
            {...(Platform.OS === "web"
              ? ({ "aria-label": "Select daemon" } as object)
              : { accessibilityLabel: "Select daemon" })}
            className="mb-4"
          >
            <Text className="text-tp-text-secondary text-xs uppercase tracking-wide mb-2">
              Daemon
            </Text>
            {pairingList.map((info) => {
              const online = connections.get(info.daemonId) ?? false;
              const isSelected = selectedDaemonId === info.daemonId;
              const shortId = info.daemonId.slice(0, 8);
              const label = labelValueOf(info) ?? shortId;

              return (
                <Pressable
                  key={info.daemonId}
                  onPress={() => {
                    if (!online) return;
                    setSelectedDaemonId(info.daemonId);
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{
                    selected: isSelected,
                    disabled: !online,
                  }}
                  {...(Platform.OS === "web"
                    ? ({
                        "aria-checked": isSelected,
                      } as object)
                    : {})}
                  className={`flex-row items-center gap-3 py-2 ${!online ? "opacity-40" : ""}`}
                  tabIndex={online ? pp.tabIndex : getPlatformProps({ focusable: false }).tabIndex}
                >
                  {/* Status dot */}
                  <View
                    className={`w-2 h-2 rounded-full ${online ? "bg-tp-success" : "bg-tp-text-tertiary"}`}
                    {...(Platform.OS === "web"
                      ? ({ "aria-hidden": true } as object)
                      : {})}
                  />
                  <Text
                    className={`flex-1 text-[15px] ${isSelected ? "text-tp-text-primary font-semibold" : "text-tp-text-secondary"}`}
                  >
                    {label}
                  </Text>
                  {isSelected && (
                    <Text
                      className="text-tp-accent text-sm"
                      {...(Platform.OS === "web"
                        ? ({ "aria-hidden": true } as object)
                        : {})}
                    >
                      ✓
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ) : pairingList.length === 1 ? (
          // 1 daemon: static row
          <View className="flex-row items-center gap-3 mb-4">
            <View
              className={`w-2 h-2 rounded-full ${
                connections.get(pairingList[0]!.daemonId) ?? false
                  ? "bg-tp-success"
                  : "bg-tp-text-tertiary"
              }`}
              {...(Platform.OS === "web"
                ? ({ "aria-hidden": true } as object)
                : {})}
            />
            <Text className="text-tp-text-secondary text-[15px]">
              On:{" "}
              <Text className="text-tp-text-primary font-medium">
                {labelValueOf(pairingList[0]!) ??
                  pairingList[0]!.daemonId.slice(0, 8)}
              </Text>
            </Text>
          </View>
        ) : null}

        {/* Working directory input */}
        <Text className="text-tp-text-secondary text-xs uppercase tracking-wide mb-2">
          Working directory
        </Text>
        <TextInput
          value={cwd}
          onChangeText={(text) => {
            setCwd(text);
            if (error) setError(null);
          }}
          placeholder="e.g. ~/projects/my-repo"
          placeholderTextColor={placeholderColor}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={handleStart}
          className="bg-tp-bg-input text-tp-text-primary rounded-btn px-3 py-3 text-[15px]"
          accessibilityLabel="Working directory"
          testID="new-session-cwd-input"
        />

        {/* Inline error */}
        {error !== null && (
          <Text
            className="text-tp-error text-xs mt-2"
            accessibilityRole="alert"
            testID="new-session-error"
          >
            {error}
          </Text>
        )}
      </View>
    </ModalContainer>
  );
}
