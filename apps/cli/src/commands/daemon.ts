import { Daemon, SessionManager } from "@teleprompter/daemon";
import { type KeyPair, setLogLevel } from "@teleprompter/protocol";
import { parseArgs } from "util";
import { resolveRunnerCommand } from "../spawn";
import { loadPairingData } from "./pair";

export async function daemonCommand(argv: string[]): Promise<void> {
  const subcommand = argv[0];

  switch (subcommand) {
    case "start":
      break; // fall through to existing start logic
    case "install": {
      const { installService } = await import("../lib/service");
      return installService();
    }
    case "uninstall": {
      const { uninstallService } = await import("../lib/service");
      return uninstallService();
    }
    default:
      console.error(
        `Usage: tp daemon <start|install|uninstall> [options]\n` +
          `  start      Start daemon in foreground\n` +
          `  install    Register as OS service (launchd/systemd)\n` +
          `  uninstall  Remove OS service registration`,
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
    console.log(
      `[Daemon] worktree management enabled for ${values["repo-root"]}`,
    );
  }

  // Relay connection: CLI flags take priority, then store DB, then pairing.json
  const relayUrl = values["relay-url"] as string | undefined;
  const relayToken = values["relay-token"] as string | undefined;
  const daemonId = values["daemon-id"] as string | undefined;

  if (relayUrl && relayToken && daemonId) {
    // Explicit CLI flags — connect to specified relay
    try {
      const saved = await loadPairingData();
      const {
        generateKeyPair,
        deriveRegistrationProof,
        fromBase64: fb64,
      } = await import("@teleprompter/protocol");

      let keyPair: KeyPair;
      let pairingSecret: Uint8Array;
      let registrationProof: string;

      if (saved?.publicKey && saved?.secretKey && saved?.qrData?.ps) {
        keyPair = {
          publicKey: await fb64(saved.publicKey),
          secretKey: await fb64(saved.secretKey),
        };
        pairingSecret = await fb64(saved.qrData.ps);
        registrationProof = await deriveRegistrationProof(pairingSecret);
      } else {
        keyPair = await generateKeyPair();
        pairingSecret = new Uint8Array(32);
        registrationProof = "";
        console.warn(
          "[Daemon] no saved pairing data — E2EE key exchange will not work",
        );
      }

      await daemon.connectRelay({
        relayUrl,
        daemonId,
        token: relayToken,
        registrationProof,
        keyPair,
        pairingSecret,
      });
      console.log(`[Daemon] connected to relay ${relayUrl}`);
    } catch (err) {
      console.error(`[Daemon] relay connection failed:`, err);
    }
  } else {
    // No CLI flags — reconnect from saved pairings in store DB
    const count = await daemon.reconnectSavedRelays();
    if (count > 0) {
      console.log(`[Daemon] reconnected to ${count} saved relay(s)`);
    } else {
      // Fallback: try pairing.json file
      const saved = await loadPairingData();
      if (saved?.qrData?.ps) {
        try {
          const { deriveRegistrationProof, fromBase64: fb64 } = await import(
            "@teleprompter/protocol"
          );
          const pairingSecret = await fb64(saved.qrData.ps);
          await daemon.connectRelay({
            relayUrl: saved.relayUrl,
            daemonId: saved.daemonId,
            token: saved.relayToken,
            registrationProof: await deriveRegistrationProof(pairingSecret),
            keyPair: {
              publicKey: await fb64(saved.publicKey),
              secretKey: await fb64(saved.secretKey),
            },
            pairingSecret,
          });
          console.log(
            `[Daemon] connected to relay ${saved.relayUrl} (from pairing.json)`,
          );
        } catch (err) {
          console.error(`[Daemon] relay connection failed:`, err);
        }
      }
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
