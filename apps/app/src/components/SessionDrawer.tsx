import type { WsSessionMeta } from "@teleprompter/protocol/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { getTransport } from "../hooks/use-transport";
import { getPlatformProps } from "../lib/get-platform-props";
import { useChatStore } from "../stores/chat-store";
import { useSessionStore } from "../stores/session-store";
import { useThemeStore } from "../stores/theme-store";

// Mirror the placeholder + activity-indicator literals already used in
// session/[sid].tsx and ApiKeyModal. RN's TextInput.placeholderTextColor
// and ActivityIndicator.color want a plain string, not a CSS var, so a
// theme-aware constant is the cleanest path while keeping the rest of the
// drawer on tp-* classes.
const PLACEHOLDER_LIGHT = "#a1a1aa";
const PLACEHOLDER_DARK = "#71717a";
const INDICATOR_LIGHT = "#71717a";
const INDICATOR_DARK = "#a1a1aa";

function SessionItem({
  session,
  isActive,
  isExporting,
  onPress,
  onStop,
  onRestart,
  onExport,
}: {
  session: WsSessionMeta;
  isActive: boolean;
  isExporting: boolean;
  onPress: () => void;
  onStop: () => void;
  onRestart: () => void;
  onExport: () => void;
}) {
  const stateColor =
    session.state === "running"
      ? "bg-tp-success"
      : session.state === "stopped"
        ? "bg-tp-text-tertiary"
        : "bg-tp-error";
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const indicatorColor = isDark ? INDICATOR_DARK : INDICATOR_LIGHT;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Session ${session.sid}, ${session.state}${isActive ? ", selected" : ""}`}
      accessibilityHint="Switch to this session"
      tabIndex={pp.tabIndex}
      className={`px-4 py-3 border-b border-tp-border ${isActive ? "bg-tp-surface-active" : ""} ${pp.className}`}
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <View className={`w-2 h-2 rounded-full ${stateColor} mr-2`} />
          <View className="flex-1">
            <Text
              className="text-tp-text-primary text-sm font-mono"
              numberOfLines={1}
            >
              {session.sid}
            </Text>
            <Text className="text-tp-text-secondary text-xs" numberOfLines={1}>
              {session.cwd}
            </Text>
            {session.worktreePath && (
              <Text className="text-tp-text-tertiary text-xs" numberOfLines={1}>
                wt: {session.worktreePath}
              </Text>
            )}
            {session.claudeVersion && (
              <Text className="text-tp-text-tertiary text-xs">
                claude {session.claudeVersion}
              </Text>
            )}
          </View>
        </View>
        {session.state === "running" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onStop();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Stop session ${session.sid}`}
            tabIndex={pp.tabIndex}
            className={`bg-tp-error-soft px-2 py-1 rounded ${pp.className}`}
          >
            <Text className="text-tp-error-on-soft text-xs">Stop</Text>
          </Pressable>
        )}
        {session.state === "error" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onRestart();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Restart session ${session.sid}`}
            tabIndex={pp.tabIndex}
            className={`bg-tp-warning-soft px-2 py-1 rounded ${pp.className}`}
          >
            <Text className="text-tp-warning-on-soft text-xs">Restart</Text>
          </Pressable>
        )}
        {session.state === "stopped" && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onExport();
            }}
            accessibilityRole="button"
            accessibilityLabel={`Export session ${session.sid}`}
            tabIndex={pp.tabIndex}
            className={`bg-tp-surface px-2 py-1 rounded ${pp.className}`}
            disabled={isExporting}
            style={{ opacity: isExporting ? 0.5 : 1 }}
          >
            {isExporting ? (
              <ActivityIndicator size="small" color={indicatorColor} />
            ) : (
              <Text className="text-tp-text-secondary text-xs">Export</Text>
            )}
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

export function SessionDrawer({ onClose }: { onClose?: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentSid = useSessionStore((s) => s.sid);
  const setSid = useSessionStore((s) => s.setSid);
  const [filter, setFilter] = useState("");
  const [showWorktreeForm, setShowWorktreeForm] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [exportingSid, setExportingSid] = useState<string | null>(null);
  const pp = getPlatformProps();
  const isDark = useThemeStore((s) => s.isDark);
  const placeholderColor = isDark ? PLACEHOLDER_DARK : PLACEHOLDER_LIGHT;
  const exportCallbackRef = useRef<
    ((sid: string, format: string, content: string) => void) | null
  >(null);

  useEffect(() => {
    const client = getTransport();
    if (!client) return;

    client.onSessionExported = (
      sid: string,
      format: string,
      content: string,
    ) => {
      exportCallbackRef.current?.(sid, format, content);
    };
    return () => {
      client.onSessionExported = undefined;
    };
    // Re-run when sessions change — guarantees client is available after daemon connects
  }, []);

  // Filter sessions by search term
  const filteredSessions = useMemo(() => {
    if (!filter.trim()) return sessions;
    const q = filter.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sid.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.worktreePath?.toLowerCase().includes(q) ||
        s.state.toLowerCase().includes(q),
    );
  }, [sessions, filter]);

  const switchSession = (sid: string) => {
    const client = getTransport();
    if (!client) return;

    // Detach current
    if (currentSid) {
      client.detach(currentSid);
    }

    // Attach new
    client.attach(sid);
    setSid(sid);

    // Clear chat for the new session
    useChatStore.getState().clear();

    onClose?.();
  };

  const stopSession = (sid: string) => {
    getTransport()?.stopSession(sid);
  };

  const restartSession = (sid: string) => {
    getTransport()?.restartSession(sid);
  };

  const exportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExportState = useCallback(() => {
    setExportingSid(null);
    exportCallbackRef.current = null;
    if (exportTimeoutRef.current) {
      clearTimeout(exportTimeoutRef.current);
      exportTimeoutRef.current = null;
    }
  }, []);

  const exportSession = useCallback(
    (sid: string) => {
      const client = getTransport();
      if (!client) return;

      setExportingSid(sid);

      // Timeout: reset loading state if daemon doesn't respond within 30s
      exportTimeoutRef.current = setTimeout(() => {
        clearExportState();
        console.warn("Export timed out for session:", sid);
      }, 30000);

      exportCallbackRef.current = async (
        _sid: string,
        format: string,
        content: string,
      ) => {
        clearExportState();

        const ext = format === "json" ? "json" : "md";
        const filename = `session-${_sid.slice(0, 8)}.${ext}`;

        if (Platform.OS === "web") {
          const blob = new Blob([content], {
            type: "text/plain;charset=utf-8",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          URL.revokeObjectURL(url);
        } else {
          try {
            const { File, Paths } =
              require("expo-file-system") as typeof import("expo-file-system");
            const Sharing =
              require("expo-sharing") as typeof import("expo-sharing");
            const file = new File(Paths.document, filename);
            await file.write(content);
            await Sharing.shareAsync(file.uri, {
              mimeType: "text/plain",
              UTI: "public.plain-text",
            });
          } catch (err) {
            console.error("Export share failed:", err);
          }
        }
      };

      client.exportSession(sid, "markdown");
    },
    [clearExportState],
  );

  const createWorktree = () => {
    const branch = branchInput.trim();
    if (!branch) return;
    const client = getTransport();
    if (!client) return;
    client.createWorktree(branch);
    setBranchInput("");
    setShowWorktreeForm(false);
  };

  // Group by worktree
  const grouped = new Map<string, WsSessionMeta[]>();
  for (const s of filteredSessions) {
    const key = s.worktreePath ?? s.cwd;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(s);
  }

  const flatData: (
    | { type: "header"; key: string }
    | { type: "session"; session: WsSessionMeta }
  )[] = [];

  for (const [key, group] of grouped) {
    flatData.push({ type: "header", key });
    for (const s of group) {
      flatData.push({ type: "session", session: s });
    }
  }

  return (
    <View className="flex-1 bg-tp-bg-secondary">
      <View className="px-4 py-3 border-b border-tp-border">
        <View className="flex-row items-center justify-between mb-2">
          <Text
            className="text-tp-text-primary font-bold"
            accessibilityRole="header"
          >
            Sessions
          </Text>
          <Text className="text-tp-text-secondary text-xs">
            {filteredSessions.length}/{sessions.length}
          </Text>
        </View>
        {sessions.length > 3 && (
          <TextInput
            className={`bg-tp-bg-tertiary text-tp-text-primary rounded-lg px-3 py-1.5 text-sm ${pp.className}`}
            tabIndex={pp.tabIndex}
            placeholder="Search sessions..."
            placeholderTextColor={placeholderColor}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            accessibilityLabel="Search sessions"
          />
        )}
      </View>

      <FlatList
        data={flatData}
        keyExtractor={(item, _i) =>
          item.type === "header" ? `h-${item.key}` : `s-${item.session.sid}`
        }
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <View className="px-4 py-2 bg-tp-bg">
                <Text
                  className="text-tp-text-tertiary text-xs font-mono"
                  accessibilityRole="header"
                >
                  {item.key}
                </Text>
              </View>
            );
          }
          return (
            <SessionItem
              session={item.session}
              isActive={item.session.sid === currentSid}
              isExporting={exportingSid === item.session.sid}
              onPress={() => switchSession(item.session.sid)}
              onStop={() => stopSession(item.session.sid)}
              onRestart={() => restartSession(item.session.sid)}
              onExport={() => exportSession(item.session.sid)}
            />
          );
        }}
        ListEmptyComponent={
          <View className="p-8 items-center">
            <Text className="text-tp-text-secondary">No sessions yet</Text>
          </View>
        }
      />

      {/* Worktree Creation */}
      <View className="px-4 py-3 border-t border-tp-border">
        {showWorktreeForm ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              className="flex-1 bg-tp-bg-tertiary text-tp-text-primary rounded-lg px-3 py-1.5 text-sm font-mono"
              placeholder="branch-name"
              placeholderTextColor={placeholderColor}
              value={branchInput}
              onChangeText={setBranchInput}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Branch name"
              accessibilityHint="Enter a branch name for the new worktree"
            />
            <Pressable
              onPress={createWorktree}
              disabled={!branchInput.trim()}
              accessibilityRole="button"
              accessibilityLabel="Create worktree"
              accessibilityState={{ disabled: !branchInput.trim() }}
              tabIndex={pp.tabIndex}
              className={`bg-tp-accent px-3 py-1.5 rounded-lg ${pp.className}`}
              style={{ opacity: branchInput.trim() ? 1 : 0.4 }}
            >
              <Text className="text-tp-text-primary text-xs">Create</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowWorktreeForm(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              tabIndex={pp.tabIndex}
              className={pp.className}
            >
              <Text className="text-tp-text-secondary text-xs">Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setShowWorktreeForm(true)}
            accessibilityRole="button"
            accessibilityLabel="New worktree"
            tabIndex={pp.tabIndex}
            className={`border border-tp-border rounded-lg py-2 items-center ${pp.className}`}
          >
            <Text className="text-tp-text-tertiary text-xs">New Worktree</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
