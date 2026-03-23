import { parseArgs } from "util";
import { Daemon, SessionManager } from "@teleprompter/daemon";
import {
  createPairingBundle,
  deriveRelayToken,
  fromBase64,
  setLogLevel,
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
      "web-dir": { type: "string" },
      prune: { type: "string" },
      verbose: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
    },
    strict: false,
  });

  // Set log level
  if (values.verbose) setLogLevel("debug");
  else if (values.quiet) setLogLevel("error");

  // Inject self-spawn runner command so SessionManager uses `tp run` instead of relative path
  SessionManager.setRunnerCommand(resolveRunnerCommand());

  const daemon = new Daemon();
  const socketPath = daemon.start();

  const wsPort = parseInt(values["ws-port"] as string, 10);
  daemon.startWs(wsPort);

  // Prune old sessions on startup
  if (values.prune) {
    const hours = parseInt(values.prune as string, 10) || 24;
    const pruned = daemon.pruneOldSessions(hours * 60 * 60 * 1000);
    if (pruned > 0) {
      console.log(`[Daemon] pruned ${pruned} old session(s) (>${hours}h)`);
    }
  }

  // Serve frontend web build if specified
  if (values["web-dir"]) {
    daemon.setWebDir(values["web-dir"] as string);
    console.log(`[Daemon] serving frontend from ${values["web-dir"]}`);
  }

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
      let frontendPublicKey: Uint8Array = new Uint8Array(32);
      if (values["frontend-pubkey"]) {
        frontendPublicKey = new Uint8Array(await fromBase64(values["frontend-pubkey"] as string));
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

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n[Daemon] shutting down...");
    daemon.stop();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Auto-restart on crash (--watch mode)
  if (values.watch) {
    process.on("uncaughtException", (err) => {
      console.error("[Daemon] uncaught exception:", err.message);
      console.error("[Daemon] restarting in 3s...");
      daemon.stop();
      setTimeout(() => {
        daemonCommand(argv);
      }, 3000);
    });

    process.on("unhandledRejection", (err: any) => {
      console.error("[Daemon] unhandled rejection:", err?.message ?? err);
      // Don't restart for rejections — they're usually non-fatal
    });
  }
}
