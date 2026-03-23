import { useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { useSessionStore } from "../stores/session-store";
import { useOfflineStore } from "../stores/offline-store";
import { usePairingStore } from "../stores/pairing-store";
import { getDaemonClient } from "../hooks/use-daemon";
import type { WsSessionMeta } from "@teleprompter/protocol/client";

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className="text-gray-500 text-xs">{label}</Text>
      <Text className="text-gray-300 text-xs font-mono">{value}</Text>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="bg-zinc-900 rounded-lg px-3 py-2 mb-4">
      <Text className="text-gray-400 text-xs font-bold mb-1">{title}</Text>
      {children}
    </View>
  );
}

function SessionDiagnostics({ session }: { session: WsSessionMeta }) {
  const offlineFrames = useOfflineStore((s) => s.recentFrames.get(session.sid)) ?? [];

  return (
    <View className="bg-zinc-900 rounded-lg px-3 py-2 mb-2">
      <Text className="text-white text-sm font-mono mb-1">{session.sid}</Text>
      <MetricRow label="State" value={session.state} />
      <MetricRow label="CWD" value={session.cwd} />
      {session.worktreePath && (
        <MetricRow label="Worktree" value={session.worktreePath} />
      )}
      {session.claudeVersion && (
        <MetricRow label="Claude Version" value={session.claudeVersion} />
      )}
      <MetricRow label="Last Seq" value={String(session.lastSeq)} />
      <MetricRow label="Cached Frames" value={String(offlineFrames.length)} />
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
  const pairingState = usePairingStore((s) => s.state);
  const pairingInfo = usePairingStore((s) => s.info);
  const [rtt, setRtt] = useState(-1);

  const handlePing = () => {
    const client = getDaemonClient();
    if (client) {
      client.ping();
      setTimeout(() => setRtt(client.getRtt()), 500);
    }
  };

  const runningSessions = sessions.filter((s) => s.state === "running").length;
  const stoppedSessions = sessions.filter((s) => s.state === "stopped").length;
  const errorSessions = sessions.filter((s) => s.state === "error").length;
  const worktrees = new Set(sessions.map((s) => s.worktreePath).filter(Boolean));

  return (
    <ScrollView className="flex-1 bg-black px-4 pt-4">
      <Text className="text-white text-lg font-bold mb-4">Diagnostics</Text>

      {/* Connection */}
      <Section title="CONNECTION">
        <MetricRow
          label="Daemon WS"
          value={connected ? "Connected" : "Disconnected"}
        />
        <MetricRow label="Active Session" value={sid ?? "none"} />
        <MetricRow label="Last Seq (cursor)" value={String(lastSeq)} />
        <View className="flex-row justify-between items-center py-1">
          <Text className="text-gray-500 text-xs">RTT</Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-gray-300 text-xs font-mono">
              {rtt >= 0 ? `${rtt}ms` : "—"}
            </Text>
            <Pressable
              onPress={handlePing}
              className="bg-zinc-800 px-2 py-0.5 rounded"
            >
              <Text className="text-gray-400 text-xs">Ping</Text>
            </Pressable>
          </View>
        </View>
      </Section>

      {/* Relay / Pairing */}
      <Section title="RELAY / PAIRING">
        <MetricRow label="Pairing" value={pairingState} />
        {pairingInfo && (
          <>
            <MetricRow label="Daemon ID" value={pairingInfo.daemonId} />
            <MetricRow label="Relay URL" value={pairingInfo.relayUrl} />
          </>
        )}
      </Section>

      {/* Session Summary */}
      <Section title="SESSION SUMMARY">
        <MetricRow label="Total" value={String(sessions.length)} />
        <MetricRow label="Running" value={String(runningSessions)} />
        <MetricRow label="Stopped" value={String(stoppedSessions)} />
        <MetricRow label="Error" value={String(errorSessions)} />
        <MetricRow label="Worktrees" value={String(worktrees.size)} />
      </Section>

      {/* Sessions Detail */}
      <Text className="text-gray-400 text-xs font-bold mb-2">
        SESSIONS ({sessions.length})
      </Text>
      {sessions.map((s) => (
        <SessionDiagnostics key={s.sid} session={s} />
      ))}
      {sessions.length === 0 && (
        <Text className="text-gray-600 text-xs mb-4">No sessions</Text>
      )}
    </ScrollView>
  );
}
