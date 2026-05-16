import type { WsSessionMeta } from "@teleprompter/protocol/client";
import { useCallback, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  useAnyRelayConnected,
  useRelayConnectionStore,
} from "../hooks/use-relay";
import { getTransport } from "../hooks/use-transport";
import { checkCryptoAvailability } from "../lib/crypto-native";
import { ariaLevel, getPlatformProps } from "../lib/get-platform-props";
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
        {...ariaLevel(2)}
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
  const connected = useAnyRelayConnected();
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
    const client = getTransport();
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

    // Wrap the entire self-test so any unexpected throw (e.g. libsodium WASM
    // abort on platforms without WebAssembly) is contained in the UI handler
    // and cannot bring the app down via an unhandled rejection.
    try {
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

      let mod: typeof import("@teleprompter/protocol/client") | null = null;
      try {
        mod = await import("@teleprompter/protocol/client");
      } catch {
        result.keyGen = { ok: false, ms: 0 };
        result.encDec = { ok: false, ms: 0 };
        setCryptoTest(result);
        return;
      }
      const { generateKeyPair, encrypt, decrypt, deriveSessionKeys } = mod;

      t0 = Date.now();
      try {
        await generateKeyPair();
        result.keyGen = { ok: true, ms: Date.now() - t0 };
      } catch {
        result.keyGen = { ok: false, ms: Date.now() - t0 };
      }

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
    } catch {
      result.sodiumInit ??= { ok: false, ms: 0 };
      result.keyGen ??= { ok: false, ms: 0 };
      result.encDec ??= { ok: false, ms: 0 };
    }

    setCryptoTest(result);
  }, []);

  // Build a SR announcement summarizing the latest self-test outcome.
  // Empty until the user actually clicks Run Self-Test, otherwise an
  // SR would speak "Running…" on initial mount. Without this, the
  // results visually flip from "—" to "OK (Xms)" but a screen reader
  // hears nothing — the user has to manually re-traverse the rows.
  const cryptoAnnouncement = (() => {
    if (cryptoTest.running) return "Running crypto self-test";
    if (!cryptoTest.sodiumInit && !cryptoTest.keyGen && !cryptoTest.encDec)
      return "";
    const parts: string[] = [];
    if (cryptoTest.sodiumInit)
      parts.push(`Sodium Init: ${cryptoTest.sodiumInit.ok ? "OK" : "FAIL"}`);
    if (cryptoTest.keyGen)
      parts.push(`Key Gen: ${cryptoTest.keyGen.ok ? "OK" : "FAIL"}`);
    if (cryptoTest.encDec)
      parts.push(`Encrypt/Decrypt: ${cryptoTest.encDec.ok ? "OK" : "FAIL"}`);
    return `Self-test complete. ${parts.join(". ")}`;
  })();

  const pp = getPlatformProps();
  const runningSessions = sessions.filter((s) => s.state === "running").length;
  const stoppedSessions = sessions.filter((s) => s.state === "stopped").length;
  const errorSessions = sessions.filter((s) => s.state === "error").length;
  const worktrees = new Set(
    sessions.map((s) => s.worktreePath).filter(Boolean),
  );

  return (
    <ScrollView className="flex-1 bg-tp-bg px-4 pt-4">
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
        {/* SR-only polite live region for Run Self-Test result.
            Visually 1×1 hidden; AT picks up announcement string when
            handleCryptoTest finishes and setCryptoTest flips the row
            values from "—" to OK/FAIL. */}
        <View
          testID="crypto-selftest-announcement"
          accessibilityLiveRegion="polite"
          {...(Platform.OS === "web"
            ? {
                role: "status" as const,
                "aria-live": "polite" as const,
              }
            : {})}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            overflow: "hidden",
          }}
          pointerEvents="none"
        >
          <Text className="text-tp-text-primary">{cryptoAnnouncement}</Text>
        </View>
        <View className="flex-row justify-end py-1">
          <Pressable
            onPress={handleCryptoTest}
            disabled={cryptoTest.running}
            className={`border border-tp-border bg-tp-bg-elevated px-3 py-1.5 rounded-btn ${
              cryptoTest.running ? "opacity-50" : ""
            } ${pp.className}`}
            tabIndex={pp.tabIndex}
            accessibilityRole="button"
            accessibilityLabel={
              cryptoTest.running
                ? "Crypto self-test running"
                : "Run crypto self-test"
            }
            accessibilityState={{ disabled: cryptoTest.running }}
          >
            <Text className="text-tp-accent text-xs font-medium">
              {cryptoTest.running ? "Running…" : "Run Self-Test"}
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
        {...ariaLevel(2)}
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
