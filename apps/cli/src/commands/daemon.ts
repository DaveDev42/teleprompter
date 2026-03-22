import { parseArgs } from "util";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import {
  createPairingBundle,
  deriveRelayToken,
  fromBase64,
} from "@teleprompter/protocol";
import { resolveRunnerCommand } from "../spawn";
import { loadPairingData } from "./pair";

export async function daemonCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  if (subcommand !== "start") {
    console.error(
      `Usage: tp daemon start [--ws-port 7080] [--repo-root /path] [--relay-url URL --relay-token TOKEN --daemon-id ID] [--spawn --sid X --cwd Y]`,
    );
    process.exit(1);
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      spawn: { type: "boolean", default: false },
      sid: { type: "string" },
      cwd: { type: "string" },
      "worktree-path": { type: "string" },
      "ws-port": { type: "string", default: "7080" },
      "repo-root": { type: "string" },
      "relay-url": { type: "string" },
      "relay-token": { type: "string" },
      "daemon-id": { type: "string" },
      "frontend-pubkey": { type: "string" },
    },
    strict: false,
  });

  // Inject self-spawn runner command so SessionManager uses `tp run` instead of relative path
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const daemon = new Daemon();
  const socketPath = daemon.start();

  const wsPort = parseInt(values["ws-port"] as string, 10);
  daemon.startWs(wsPort);

  // Enable worktree management if repo root is specified
  if (values["repo-root"]) {
    daemon.setRepoRoot(values["repo-root"] as string);
    console.log(`[Daemon] worktree management enabled for ${values["repo-root"]}`);
  }

  // Connect to relay: use CLI flags or auto-load from saved pairing data
  let relayUrl = values["relay-url"] as string | undefined;
  let relayToken = values["relay-token"] as string | undefined;
  let daemonId = values["daemon-id"] as string | undefined;

  if (!relayUrl) {
    const saved = await loadPairingData();
    if (saved) {
      relayUrl = saved.relayUrl;
      relayToken = saved.relayToken;
      daemonId = saved.daemonId;
      console.log(`[Daemon] loaded pairing data for ${saved.daemonId}`);
    }
  }

  if (relayUrl && relayToken && daemonId) {
    try {
      const { generateKeyPair } = await import("@teleprompter/protocol");
      const keyPair = await generateKeyPair();

      // Frontend public key is optional — if not provided, E2EE won't work
      // but the relay connection will still be established for presence
      let frontendPublicKey = new Uint8Array(32);
      if (values["frontend-pubkey"]) {
        frontendPublicKey = await fromBase64(values["frontend-pubkey"] as string);
      }

      await daemon.connectRelay({
        relayUrl: relayUrl,
        daemonId: daemonId,
        token: relayToken,
        keyPair,
        frontendPublicKey,
      });
      console.log(`[Daemon] connected to relay ${relayUrl}`);
    } catch (err) {
      console.error(`[Daemon] relay connection failed:`, err);
    }
  }

  console.log(`[Daemon] listening on ${socketPath}`);
  console.log("[Daemon] press Ctrl+C to stop");

  if (values.spawn) {
    const sid = (values.sid as string) ?? `session-${Date.now()}`;
    const cwd = (values.cwd as string) ?? process.cwd();
    daemon.createSession(sid, cwd, {
      worktreePath: values["worktree-path"] as string | undefined,
    });
  }

  function shutdown() {
    console.log("\n[Daemon] shutting down...");
    daemon.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
