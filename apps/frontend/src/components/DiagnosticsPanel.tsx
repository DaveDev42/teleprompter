import { View, Text, ScrollView } from "react-native";
import { useSessionStore } from "../stores/session-store";
import type { WsSessionMeta } from "@teleprompter/protocol";

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className="text-gray-500 text-xs">{label}</Text>
      <Text className="text-gray-300 text-xs font-mono">{value}</Text>
    </View>
  );
}

function SessionDiagnostics({ session }: { session: WsSessionMeta }) {
  return (
    <View className="bg-zinc-900 rounded-lg px-3 py-2 mb-2">
      <Text className="text-white text-sm font-mono mb-1">{session.sid}</Text>
      <MetricRow label="State" value={session.state} />
      <MetricRow label="CWD" value={session.cwd} />
      {session.worktreePath && (
        <MetricRow label="Worktree" value={session.worktreePath} />
      )}
      {session.claudeVersion && (
        <MetricRow label="Claude" value={session.claudeVersion} />
      )}
      <MetricRow label="Last Seq" value={String(session.lastSeq)} />
      <MetricRow
        label="Created"
        value={new Date(session.createdAt).toLocaleString()}
      />
      <MetricRow
        label="Updated"
        value={new Date(session.updatedAt).toLocaleString()}
      />
    </View>
  );
}

export function DiagnosticsPanel() {
  const connected = useSessionStore((s) => s.connected);
  const lastSeq = useSessionStore((s) => s.lastSeq);
  const sid = useSessionStore((s) => s.sid);
  const sessions = useSessionStore((s) => s.sessions);

  return (
    <ScrollView className="flex-1 bg-black px-4 pt-4">
      <Text className="text-white text-lg font-bold mb-4">Diagnostics</Text>

      {/* Connection */}
      <View className="bg-zinc-900 rounded-lg px-3 py-2 mb-4">
        <Text className="text-gray-400 text-xs font-bold mb-1">
          CONNECTION
        </Text>
        <MetricRow
          label="Daemon WS"
          value={connected ? "Connected" : "Disconnected"}
        />
        <MetricRow label="Active Session" value={sid ?? "none"} />
        <MetricRow label="Last Seq" value={String(lastSeq)} />
      </View>

      {/* Sessions */}
      <Text className="text-gray-400 text-xs font-bold mb-2">
        SESSIONS ({sessions.length})
      </Text>
      {sessions.map((s) => (
        <SessionDiagnostics key={s.sid} session={s} />
      ))}
      {sessions.length === 0 && (
        <Text className="text-gray-600 text-xs">No sessions</Text>
      )}
    </ScrollView>
  );
}
