import type { WsSessionMeta } from "@teleprompter/protocol/client";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { getDaemonClient } from "../hooks/use-daemon";
import { useRelayConnectionStore } from "../hooks/use-relay";
import { checkCryptoAvailability } from "../lib/crypto-native";
import { getPlatformProps } from "../lib/get-platform-props";
import { useOfflineStore } from "../stores/offline-store";
import { usePairingStore } from "../stores/pairing-store";
import { useSessionStore } from "../stores/session-store";

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row justify-between py-1">
      <Text className="text-tp-text-tertiary text-xs">{label}</Text>
      <Text className="text-tp-text-secondary text-xs font-mono">{value}</Text>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View className="bg-tp-surface rounded-lg px-3 py-2 mb-4">
      <Text
        className="text-tp-text-tertiary text-xs font-bold mb-1"
        accessibilityRole="header"
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function SessionDiagnostics({ session }: { session: WsSessionMeta }) {
  const offlineFrames =
    useOfflineStore((s) => s.recentFrames.get(session.sid)) ?? [];

  return (
    <View className="bg-tp-surface rounded-lg px-3 py-2 mb-2">
      <Text className="text-tp-text-primary text-sm font-mono mb-1">
        {session.sid}
      </Text>
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
  const pairings = usePairingStore((s) => s.pairings);
  const activeDaemonId = usePairingStore((s) => s.activeDaemonId);
  const pairingInfo = activeDaemonId
    ? pairings.get(activeDaemonId)
    : (pairings.values().next().value ?? null);
  const relayConnections = useRelayConnectionStore((s) => s.connections);
  const relayConnected = activeDaemonId
    ? (relayConnections.get(activeDaemonId) ?? false)
    : false;
  const [rtt, setRtt] = useState(-1);
  const [cryptoTest, setCryptoTest] = useState<{
    running: boolean;
    sodiumInit?: { ok: boolean; ms: number };
    keyGen?: { ok: boolean; ms: number };
    encDec?: { ok: boolean; ms: number };
    platform?: string;
  }>({ running: false });

  const handlePing = () => {
    const client = getDaemonClient();
    if (client) {
      client.ping();
      setTimeout(() => setRtt(client.getRtt()), 500);
    }
  };

  const handleCryptoTest = useCallback(async () => {
    setCryptoTest({ running: true });
    const result: typeof cryptoTest = { running: false };

    // Detect platform
    if (
      typeof (globalThis as Record<string, unknown>).HermesInternal !==
      "undefined"
    )
      result.platform = "hermes";
    else if (typeof document !== "undefined") result.platform = "web";
    else result.platform = "unknown";

    // 1. Sodium init
    let t0 = Date.now();
    try {
      const ok = await checkCryptoAvailability();
      result.sodiumInit = { ok, ms: Date.now() - t0 };
    } catch {
      result.sodiumInit = { ok: false, ms: Date.now() - t0 };
    }

    if (!result.sodiumInit.ok) {
      setCryptoTest(result);
      return;
    }

    // 2. Key generation
    const { generateKeyPair, encrypt, decrypt, deriveSessionKeys } =
      await import("@teleprompter/protocol/client");
    t0 = Date.now();
    try {
      await generateKeyPair();
      result.keyGen = { ok: true, ms: Date.now() - t0 };
    } catch {
      result.keyGen = { ok: false, ms: Date.now() - t0 };
    }

    // 3. Encrypt/decrypt round-trip (using derived session keys)
    t0 = Date.now();
    try {
      const kpA = await generateKeyPair();
      const kpB = await generateKeyPair();
      const keysA = await deriveSessionKeys(kpA, kpB.publicKey, "daemon");
      const keysB = await deriveSessionKeys(kpB, kpA.publicKey, "frontend");
      const plaintext = new TextEncoder().encode("E2EE self-test payload");
      const ct = await encrypt(plaintext, keysA.tx);
      const decrypted = await decrypt(ct, keysB.rx);
      const ok =
        new TextDecoder().decode(decrypted) === "E2EE self-test payload";
      result.encDec = { ok, ms: Date.now() - t0 };
    } catch {
      result.encDec = { ok: false, ms: Date.now() - t0 };
    }

    setCryptoTest(result);
  }, []);

  const pp = getPlatformProps();
  const runningSessions = sessions.filter((s) => s.state === "running").length;
  const stoppedSessions = sessions.filter((s) => s.state === "stopped").length;
  const errorSessions = sessions.filter((s) => s.state === "error").length;
  const worktrees = new Set(
    sessions.map((s) => s.worktreePath).filter(Boolean),
  );

  return (
    <ScrollView className="flex-1 bg-tp-bg px-4 pt-4">
      <Text
        className="text-tp-text-primary text-lg font-bold mb-4"
        accessibilityRole="header"
      >
        Diagnostics
      </Text>

      {/* Connection */}
      <Section title="CONNECTION">
        <MetricRow
          label="Daemon WS"
          value={connected ? "Connected" : "Disconnected"}
        />
        <MetricRow label="Active Session" value={sid ?? "none"} />
        <MetricRow label="Last Seq (cursor)" value={String(lastSeq)} />
        <View className="flex-row justify-between items-center py-1">
          <Text className="text-tp-text-tertiary text-xs">RTT</Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-tp-text-secondary text-xs font-mono">
              {rtt >= 0 ? `${rtt}ms` : "—"}
            </Text>
            <Pressable
              onPress={handlePing}
              className={`bg-tp-surface px-2 py-0.5 rounded ${pp.className}`}
              tabIndex={pp.tabIndex}
              accessibilityRole="button"
              accessibilityLabel="Ping daemon"
            >
              <Text className="text-tp-text-tertiary text-xs">Ping</Text>
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
            <MetricRow
              label="Relay WS"
              value={relayConnected ? "Connected" : "Disconnected"}
            />
            <MetricRow
              label="E2EE"
              value={relayConnected ? "Active" : "Inactive"}
            />
          </>
        )}
      </Section>

      {/* E2EE Crypto Self-Test */}
      <Section title="E2EE CRYPTO">
        {cryptoTest.platform && (
          <MetricRow label="Platform" value={cryptoTest.platform} />
        )}
        <MetricRow
          label="Sodium Init"
          value={
            cryptoTest.sodiumInit
              ? `${cryptoTest.sodiumInit.ok ? "OK" : "FAIL"} (${cryptoTest.sodiumInit.ms}ms)`
              : "—"
          }
        />
        <MetricRow
          label="Key Gen"
          value={
            cryptoTest.keyGen
              ? `${cryptoTest.keyGen.ok ? "OK" : "FAIL"} (${cryptoTest.keyGen.ms}ms)`
              : "—"
          }
        />
        <MetricRow
          label="Encrypt/Decrypt"
          value={
            cryptoTest.encDec
              ? `${cryptoTest.encDec.ok ? "OK" : "FAIL"} (${cryptoTest.encDec.ms}ms)`
              : "—"
          }
        />
        <View className="flex-row justify-end py-1">
          <Pressable
            onPress={handleCryptoTest}
            disabled={cryptoTest.running}
            className={`bg-tp-surface px-3 py-1 rounded ${pp.className}`}
            tabIndex={pp.tabIndex}
            accessibilityRole="button"
            accessibilityLabel={
              cryptoTest.running
                ? "Crypto self-test running"
                : "Run crypto self-test"
            }
            accessibilityState={{ disabled: cryptoTest.running }}
          >
            <Text className="text-tp-text-tertiary text-xs">
              {cryptoTest.running ? "Running..." : "Run Self-Test"}
            </Text>
          </Pressable>
        </View>
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
      <Text
        className="text-tp-text-tertiary text-xs font-bold mb-2"
        accessibilityRole="header"
      >
        SESSIONS ({sessions.length})
      </Text>
      {sessions.map((s) => (
        <SessionDiagnostics key={s.sid} session={s} />
      ))}
      {sessions.length === 0 && (
        <Text className="text-tp-text-tertiary text-xs mb-4">No sessions</Text>
      )}
    </ScrollView>
  );
}
