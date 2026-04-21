import { Store } from "@teleprompter/daemon";
import type {
  IpcPairBegin,
  IpcPairBeginErr,
  IpcPairBeginOk,
  IpcPairCancel,
  IpcPairCancelled,
  IpcPairCompleted,
  IpcPairError,
  IpcPairRemove,
  IpcPairRemoveErr,
  IpcPairRemoveOk,
  IpcPairRename,
  IpcPairRenameErr,
  IpcPairRenameOk,
} from "@teleprompter/protocol";
import { getSocketPath } from "@teleprompter/protocol";
import { hostname } from "os";
import { join } from "path";
import qrcode from "qrcode-terminal";
import { parseArgs } from "util";
import { dim, fail, ok } from "../lib/colors";
import { ensureDaemon, isDaemonRunning } from "../lib/ensure-daemon";
import { formatAge } from "../lib/format";
import { connectIpcAsClient, type IpcClient } from "../lib/ipc-client";
import { acquirePairLock, releasePairLock } from "../lib/pair-lock";
import { getConfigDir } from "../lib/paths";

const PAIRING_DIR = getConfigDir();

export async function pairCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "list":
      await pairList(argv.slice(1));
      return;
    case "delete":
      await pairDelete(argv.slice(1));
      return;
    case "rename":
      await pairRename(argv.slice(1));
      return;
    case "new":
      await pairNew(argv.slice(1));
      return;
    case "--help":
    case "-h":
      printPairUsage();
      return;
    default:
      await pairNew(argv);
      return;
  }
}

async function pairNew(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      relay: { type: "string", default: "wss://relay.tpmt.dev" },
      "daemon-id": { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    printPairUsage();
    return;
  }

  const relayUrl = values.relay as string;
  const daemonId = values["daemon-id"] as string | undefined;
  const rawLabel = (values.label as string | undefined)?.trim() ?? "";
  const label = rawLabel || defaultLabel();

  const lockPath = join(PAIRING_DIR, "pair.lock");
  const lockRelease = await acquirePairLock(lockPath);
  if (!lockRelease) {
    console.error(
      fail("Another `tp pair new` is already running. Cancel it first."),
    );
    process.exit(1);
  }

  let ipc: IpcClient | null = null;
  let cleanedUp = false;
  const cleanup = async (code: number): Promise<never> => {
    if (!cleanedUp) {
      cleanedUp = true;
      try {
        ipc?.close();
      } catch {
        /* best effort */
      }
      await releasePairLock(lockRelease);
    }
    process.exit(code);
  };

  try {
    const daemonOk = await ensureDaemon();
    if (!daemonOk) await cleanup(1);

    ipc = await connectIpcAsClient(getSocketPath());
    let pairingId: string | null = null;

    const done = new Promise<number>((resolve) => {
      ipc!.onMessage((raw) => {
        const m = raw as
          | IpcPairBeginOk
          | IpcPairBeginErr
          | IpcPairCompleted
          | IpcPairCancelled
          | IpcPairError;
        switch (m.t) {
          case "pair.begin.ok": {
            pairingId = m.pairingId;
            qrcode.generate(m.qrString, { small: true }, (qr: string) => {
              console.log(qr);
            });
            console.log(`\nDaemon ID:    ${m.daemonId}`);
            console.log(`Label:        ${label}`);
            console.log(`Relay:        ${relayUrl}`);
            console.log(`\nPairing data (paste into frontend):`);
            console.log(m.qrString);
            console.log(
              `\n${dim("Waiting for your app to scan the QR...")} (Ctrl+C to cancel)`,
            );
            return;
          }
          case "pair.begin.err":
            console.error(
              fail(
                `Pairing failed: ${m.reason}${m.message ? ` — ${m.message}` : ""}`,
              ),
            );
            resolve(1);
            return;
          case "pair.completed":
            console.log(ok(`Paired ${m.label ?? m.daemonId} (${m.daemonId})`));
            resolve(0);
            return;
          case "pair.cancelled":
            console.error(dim("Pairing cancelled."));
            resolve(130);
            return;
          case "pair.error":
            console.error(
              fail(
                `Pairing error: ${m.reason}${m.message ? ` — ${m.message}` : ""}`,
              ),
            );
            resolve(1);
            return;
          default: {
            const _exhaustive: never = m;
            void _exhaustive;
            resolve(1);
            return;
          }
        }
      });
      ipc!.onClose(() => {
        console.error(fail("Daemon disconnected — pairing aborted."));
        resolve(1);
      });
    });

    const onSigint = (): void => {
      if (pairingId && ipc) {
        ipc.send({ t: "pair.cancel", pairingId } satisfies IpcPairCancel);
      } else {
        // Pre-ok: no pairingId yet, so a pair.cancel frame wouldn't identify
        // anything server-side. Close the socket instead — the daemon's
        // onDisconnect will cancel any half-begun PendingPairing.
        try {
          ipc?.close();
        } catch {
          /* best effort */
        }
      }
    };
    process.on("SIGINT", onSigint);

    const begin: IpcPairBegin = {
      t: "pair.begin",
      relayUrl,
      daemonId,
      label,
    };
    ipc.send(begin);

    const code = await done;
    process.off("SIGINT", onSigint);
    await cleanup(code);
  } catch (err) {
    console.error(
      fail(
        `Pairing failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    await cleanup(1);
  }
}

/**
 * Resolve a daemon ID fragment against a list of pairings.
 *
 * Match precedence (first non-empty result wins):
 *   1. Exact daemon ID
 *   2. Prefix match (e.g. `daemon-mncx`)
 *   3. `daemon-<fragment>` shorthand (e.g. `mncx9824` → `daemon-mncx9824`)
 *
 * `rename` and `delete` share this helper so users get identical matching in
 * both. Substring/middle matches are intentionally excluded — they collide
 * far too easily on real installs.
 */
export function matchPairings<T extends { daemonId: string }>(
  candidates: readonly T[],
  fragment: string,
): T[] {
  const exact = candidates.filter((c) => c.daemonId === fragment);
  if (exact.length > 0) return exact;

  const prefix = candidates.filter((c) => c.daemonId.startsWith(fragment));
  if (prefix.length > 0) return prefix;

  const shorthand = `daemon-${fragment}`;
  return candidates.filter((c) => c.daemonId === shorthand);
}

function defaultLabel(): string {
  try {
    const h = hostname();
    return h && h.length > 0 ? h : "daemon";
  } catch {
    return "daemon";
  }
}

async function pairList(argv: string[]): Promise<void> {
  parseArgs({
    args: argv,
    options: {},
    allowPositionals: false,
    strict: true,
  });

  const store = new Store();
  let pairings: ReturnType<Store["listPairings"]>;
  try {
    pairings = store.listPairings();
  } finally {
    store.close();
  }

  if (pairings.length === 0) {
    console.log("No pairings registered.");
    console.log("");
    console.log("Create one with: tp pair new");
    return;
  }

  const rows = pairings.map((p) => ({
    daemonId: p.daemonId,
    label: p.label ?? "",
    relayUrl: p.relayUrl,
    created: formatAge(Date.now() - p.createdAt),
  }));

  const labelW = Math.max(5, ...rows.map((r) => r.label.length));
  const idW = Math.max(9, ...rows.map((r) => r.daemonId.length));
  const relayW = Math.max(5, ...rows.map((r) => r.relayUrl.length));

  console.log(
    `${"LABEL".padEnd(labelW)}  ${"DAEMON ID".padEnd(idW)}  ${"RELAY".padEnd(relayW)}  CREATED`,
  );
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(labelW)}  ${r.daemonId.padEnd(idW)}  ${r.relayUrl.padEnd(relayW)}  ${r.created}`,
    );
  }
}

async function pairDelete(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length > 1) {
    console.error(fail("Usage: tp pair delete <daemon-id> [--yes]"));
    process.exit(1);
  }

  const prefix = positionals[0];
  if (!prefix) {
    console.error(fail("Usage: tp pair delete <daemon-id> [--yes]"));
    process.exit(1);
  }

  // Resolve the prefix locally from the store to give clear error messages
  // *before* we bother the daemon. The daemon holds the same state, so this
  // read is safe regardless of whether the daemon is running.
  const store = new Store();
  let target: { daemonId: string; relayUrl: string };
  try {
    const candidates = store.listPairings().map((p) => ({
      daemonId: p.daemonId,
      relayUrl: p.relayUrl,
    }));
    const matches = matchPairings(candidates, prefix);
    if (matches.length === 0) {
      console.error(fail(`No pairing matches '${prefix}'.`));
      if (candidates.length > 0) {
        console.error(dim("Known daemon IDs:"));
        for (const c of candidates) console.error(dim(`  ${c.daemonId}`));
      }
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(fail(`Prefix '${prefix}' is ambiguous. Candidates:`));
      for (const c of matches) console.error(`  ${c.daemonId}  ${c.relayUrl}`);
      process.exit(1);
    }
    target = matches[0]!;
  } finally {
    store.close();
  }

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        fail("Refusing to delete without confirmation — pass --yes."),
      );
      process.exit(1);
    }
    const answer = await prompt(
      `Delete pairing for ${target.daemonId} (relay ${target.relayUrl})? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  // Prefer the daemon path when one is already running: it holds the
  // authoritative RelayClient for this pairing and can cleanly notify the
  // peer before tearing the client down. When no daemon is running we fall
  // back to a local store delete — any connected peer will learn about the
  // unpair on its own next connect attempt.
  if (await isDaemonRunning()) {
    const result = await requestPairOp({
      t: "pair.remove",
      daemonId: target.daemonId,
    });

    if (result.t === "pair.remove.err") {
      console.error(
        fail(
          `Pair delete failed: ${result.reason}${result.message ? ` — ${result.message}` : ""}`,
        ),
      );
      process.exit(1);
    }

    console.log(ok(`Deleted pairing ${result.daemonId}`));
    if (result.notifiedPeers > 0) {
      console.log(dim(`Notified ${result.notifiedPeers} frontend(s).`));
    }
    return;
  }

  // Daemon-less path: delete from the store directly.
  const deleteStore = new Store();
  try {
    deleteStore.deletePairing(target.daemonId);
  } finally {
    deleteStore.close();
  }
  console.log(ok(`Deleted pairing ${target.daemonId}`));
}

async function pairRename(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printPairUsage();
    return;
  }
  if (positionals.length < 2) {
    console.error(fail("Usage: tp pair rename <daemon-id-prefix> <label...>"));
    process.exit(1);
  }

  const [prefix, ...labelParts] = positionals;
  if (!prefix) {
    console.error(fail("Usage: tp pair rename <daemon-id-prefix> <label...>"));
    process.exit(1);
  }
  const newLabel = labelParts.join(" ").trim();
  const label = newLabel === "" ? null : newLabel;

  const store = new Store();
  let target: { daemonId: string; relayUrl: string };
  try {
    const pairings = store.listPairings();
    const matches = matchPairings(pairings, prefix);
    if (matches.length === 0) {
      console.error(fail(`No pairing matches '${prefix}'.`));
      if (pairings.length > 0) {
        console.error(dim("Known daemon IDs:"));
        for (const p of pairings) console.error(dim(`  ${p.daemonId}`));
      }
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(fail(`Prefix '${prefix}' is ambiguous. Candidates:`));
      for (const m of matches) console.error(`  ${m.daemonId}  ${m.relayUrl}`);
      process.exit(1);
    }
    target = matches[0]!;
  } finally {
    store.close();
  }

  // Prefer the daemon path when one is already running so connected peers
  // get a live `control.rename` frame. When no daemon is running we update
  // the store directly — connected peers (if any) will sync on reconnect.
  if (await isDaemonRunning()) {
    const result = await requestPairOp({
      t: "pair.rename",
      daemonId: target.daemonId,
      label,
    });

    if (result.t === "pair.rename.err") {
      console.error(
        fail(
          `Pair rename failed: ${result.reason}${result.message ? ` — ${result.message}` : ""}`,
        ),
      );
      process.exit(1);
    }

    console.log(
      ok(
        `Renamed ${result.daemonId} → ${result.label === null ? "(cleared)" : `"${result.label}"`}`,
      ),
    );
    if (result.notifiedPeers > 0) {
      console.log(dim(`Notified ${result.notifiedPeers} frontend(s).`));
    }
    return;
  }

  // Daemon-less path: update the store directly.
  const renameStore = new Store();
  try {
    renameStore.updatePairingLabel(target.daemonId, label);
  } finally {
    renameStore.close();
  }
  console.log(
    ok(
      `Renamed ${target.daemonId} → ${label === null ? "(cleared)" : `"${label}"`}`,
    ),
  );
}

type PairRemoveResult = IpcPairRemoveOk | IpcPairRemoveErr;
type PairRenameResult = IpcPairRenameOk | IpcPairRenameErr;

/**
 * Send a `pair.remove` / `pair.rename` request to the running daemon and
 * await its single-shot reply. The daemon already holds the authoritative
 * RelayClient for that pairing, so we never open our own relay connection.
 */
async function requestPairOp(
  msg: IpcPairRemove,
): Promise<PairRemoveResult>;
async function requestPairOp(
  msg: IpcPairRename,
): Promise<PairRenameResult>;
async function requestPairOp(
  msg: IpcPairRemove | IpcPairRename,
): Promise<PairRemoveResult | PairRenameResult> {
  const ipc = await connectIpcAsClient(getSocketPath());
  try {
    return await new Promise<PairRemoveResult | PairRenameResult>(
      (resolve, reject) => {
        ipc.onMessage((raw) => {
          const r = raw as PairRemoveResult | PairRenameResult;
          switch (r.t) {
            case "pair.remove.ok":
            case "pair.remove.err":
            case "pair.rename.ok":
            case "pair.rename.err":
              resolve(r);
              return;
          }
        });
        ipc.onClose(() =>
          reject(new Error("Daemon disconnected before replying")),
        );
        ipc.send(msg);
      },
    );
  } finally {
    try {
      ipc.close();
    } catch {
      /* best effort */
    }
  }
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const done = (value: string) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("close", onEnd);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (data: string) => done(data);
    const onEnd = () => done("");
    process.stdin.once("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("close", onEnd);
  });
}

function printPairUsage(): void {
  console.log(`
tp pair — manage mobile app pairings

Usage:
  tp pair [--relay URL]                        Alias for 'tp pair new'
  tp pair new [--relay URL] [--label <name>]   Generate a QR and BLOCK until the
                                               mobile app scans it (Ctrl+C to cancel).
                                               Auto-starts the daemon if needed.
  tp pair list                                 List registered (completed) pairings
  tp pair rename <daemon-id> <label...>        Rename a pairing (prefix match)
  tp pair delete <daemon-id> [-y]              Delete a pairing (prefix match allowed)
`);
}
