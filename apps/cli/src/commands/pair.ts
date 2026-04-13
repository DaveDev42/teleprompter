import { RelayClient, Store } from "@teleprompter/daemon";
import {
  createPairingBundle,
  encodePairingData,
  RELAY_CHANNEL_CONTROL,
  toBase64,
} from "@teleprompter/protocol";
import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { hostname } from "os";
import { join } from "path";
import qrcode from "qrcode-terminal";
import { parseArgs } from "util";
import { dim, fail, ok, warn } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { spinner } from "../lib/spinner";

const PAIRING_DIR = join(process.env.HOME ?? "/tmp", ".config", "teleprompter");
const PAIRING_FILE = join(PAIRING_DIR, "pairing.json");

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
      save: { type: "boolean", default: true },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    printPairUsage();
    return;
  }

  const relayUrl = values.relay as string;
  const daemonId =
    (values["daemon-id"] as string) ?? `daemon-${Date.now().toString(36)}`;
  const rawLabel = (values.label as string | undefined)?.trim() ?? "";
  const label = rawLabel || defaultLabel();

  const stop = spinner("Generating pairing keys...");
  const bundle = await createPairingBundle(relayUrl, daemonId, { label });
  const qrString = encodePairingData(bundle.qrData);
  stop(`${ok("Keys generated")}\n`);

  qrcode.generate(qrString, { small: true }, (qr: string) => {
    console.log(qr);
  });

  console.log(`\nDaemon ID:    ${daemonId}`);
  console.log(`Label:        ${label}`);
  console.log(`Relay:        ${relayUrl}`);
  console.log(`Relay Token:  ${bundle.relayToken.substring(0, 16)}...`);

  console.log(`\nPairing data (paste into frontend):`);
  console.log(qrString);

  if (values.save !== false) {
    await mkdir(PAIRING_DIR, { recursive: true });
    const pairingData = {
      daemonId,
      relayUrl,
      relayToken: bundle.relayToken,
      publicKey: await toBase64(bundle.keyPair.publicKey),
      secretKey: await toBase64(bundle.keyPair.secretKey),
      qrData: bundle.qrData,
      label,
      createdAt: Date.now(),
    };
    await writeFile(PAIRING_FILE, JSON.stringify(pairingData, null, 2));
    console.log(`\nPairing saved to ${PAIRING_FILE}`);
  }
}

/**
 * Resolve a daemon ID fragment against a list of pairings.
 *
 * Exact matches win outright — otherwise we match by prefix OR substring so
 * the user can type either `daemon-mncx9824` or just `mncx9824`. `rename` and
 * `delete` share this helper to keep their matching behavior identical.
 */
export function matchPairings<T extends { daemonId: string }>(
  candidates: readonly T[],
  fragment: string,
): T[] {
  const exact = candidates.filter((c) => c.daemonId === fragment);
  if (exact.length > 0) return exact;
  return candidates.filter(
    (c) => c.daemonId.startsWith(fragment) || c.daemonId.includes(fragment),
  );
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

  const pending = await loadPairingData();
  const pendingIsPersisted =
    pending != null && pairings.some((p) => p.daemonId === pending.daemonId);
  const showPending = pending != null && !pendingIsPersisted;

  if (pairings.length === 0 && !showPending) {
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

  if (rows.length > 0) {
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

  if (showPending) {
    if (rows.length > 0) console.log("");
    console.log(
      warn(
        `Pending pairing in ${PAIRING_FILE} (daemon will register on next start):`,
      ),
    );
    const createdLabel =
      pending.createdAt != null
        ? formatAge(Date.now() - pending.createdAt)
        : "unknown";
    const pendingLbl = pending.label ?? pending.qrData?.label ?? "";
    console.log(
      `  ${pendingLbl ? `${pendingLbl}  ` : ""}${pending.daemonId}  ${pending.relayUrl}  ${createdLabel}`,
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

  if (await isDaemonRunning()) {
    console.error(
      fail(
        "Daemon is running. Stop it first with `tp daemon stop` (or via the app's Daemons screen) before running `tp pair delete`, to avoid relay conflicts.",
      ),
    );
    process.exit(1);
  }

  const store = new Store();
  try {
    const pairings = store.listPairings();
    const pending = await loadPairingData();

    type Candidate = { daemonId: string; relayUrl: string; pending: boolean };
    const candidates: Candidate[] = pairings.map((p) => ({
      daemonId: p.daemonId,
      relayUrl: p.relayUrl,
      pending: false,
    }));
    if (
      pending != null &&
      !candidates.some((c) => c.daemonId === pending.daemonId)
    ) {
      candidates.push({
        daemonId: pending.daemonId,
        relayUrl: pending.relayUrl,
        pending: true,
      });
    }

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

    const target = matches[0]!;
    const fullPairing = store
      .loadPairings()
      .find((p) => p.daemonId === target.daemonId);

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

    if (fullPairing) {
      // TP_UNPAIR_* env vars gate both unpair and rename notifications — same flow.
      const { timeoutMs, connectCutoffMs } = readNotifyTimeouts();
      try {
        await notifyPeerUnpair(fullPairing, { timeoutMs, connectCutoffMs });
      } catch (err) {
        console.warn(`[pair] could not notify peer: ${err}`);
      }
    }

    store.deletePairing(target.daemonId);

    // If the pending handoff file matches, remove it too so the daemon
    // doesn't re-ingest the just-deleted pairing on next start.
    if (pending != null && pending.daemonId === target.daemonId) {
      try {
        await unlink(PAIRING_FILE);
      } catch {
        // best effort
      }
    }

    console.log(ok(`Deleted pairing ${target.daemonId}`));
    console.log(
      `${warn("Daemon may still hold an active relay connection.")} ${dim("Restart the daemon to fully disconnect.")}`,
    );
  } finally {
    store.close();
  }
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

  // CLI is source of truth when stopped; label is already written to store
  // before we notify the peer, so even if notification fails the rename
  // persists locally.
  if (await isDaemonRunning()) {
    console.error(
      fail(
        "Daemon is running. Stop it first with `tp daemon stop` (or via the app's Daemons screen) before running `tp pair rename`, to avoid relay conflicts.",
      ),
    );
    process.exit(1);
  }

  const [prefix, ...labelParts] = positionals;
  if (!prefix) {
    console.error(fail("Usage: tp pair rename <daemon-id-prefix> <label...>"));
    process.exit(1);
  }
  const newLabel = labelParts.join(" ").trim();

  const store = new Store();
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

    const target = matches[0]!;
    const full = store
      .loadPairings()
      .find((p) => p.daemonId === target.daemonId);

    store.updatePairingLabel(
      target.daemonId,
      newLabel === "" ? null : newLabel,
    );

    console.log(
      ok(
        `Renamed ${target.daemonId} → ${newLabel === "" ? "(cleared)" : `"${newLabel}"`}`,
      ),
    );

    if (full) {
      // TP_UNPAIR_* env vars gate both unpair and rename notifications — same flow.
      const { timeoutMs, connectCutoffMs } = readNotifyTimeouts();
      try {
        await notifyPeerRename(full, newLabel, { timeoutMs, connectCutoffMs });
      } catch (err) {
        console.warn(`[pair] could not notify peer: ${err}`);
      }
    }
  } finally {
    store.close();
  }
}

const DEFAULT_UNPAIR_TIMEOUT_MS = 3000;
const DEFAULT_UNPAIR_GRACE_MS = 100;
const UNPAIR_CONNECT_CUTOFF_MS = 1500;

/**
 * Read peer-notification timeouts from env. Used by both `tp pair delete`
 * (control.unpair) and `tp pair rename` (control.rename). Env var names are
 * kept as `TP_UNPAIR_*` for backward compatibility.
 */
function readNotifyTimeouts(): {
  timeoutMs: number;
  connectCutoffMs: number;
} {
  const raw = Number(process.env.TP_UNPAIR_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_UNPAIR_TIMEOUT_MS;
  const cutoffRaw = Number(process.env.TP_UNPAIR_CONNECT_CUTOFF_MS);
  const connectCutoffMs =
    Number.isFinite(cutoffRaw) && cutoffRaw > 0
      ? cutoffRaw
      : UNPAIR_CONNECT_CUTOFF_MS;
  return { timeoutMs, connectCutoffMs };
}

type FullPairing = ReturnType<Store["loadPairings"]>[number];

/**
 * Best-effort peer notification over a short-lived relay connection.
 *
 * `timeoutMs` is the maximum wall-clock time spent waiting for at least one
 * frontend to complete kx before we give up on notification. Once any peer
 * appears, we send immediately and then wait DEFAULT_UNPAIR_GRACE_MS for the
 * relay to forward the encrypted control frame before disconnecting.
 *
 * Used by `tp pair delete` (control.unpair) and `tp pair rename`
 * (control.rename). Keeps CLI ⇄ daemon separation: the CLI opens its own
 * short-lived RelayClient while the daemon is stopped.
 */
async function notifyPeer(
  pairing: FullPairing,
  opts: { timeoutMs: number; connectCutoffMs: number },
  send: (client: RelayClient, frontendId: string) => Promise<boolean>,
): Promise<void> {
  const client = new RelayClient(
    {
      daemonId: pairing.daemonId,
      relayUrl: pairing.relayUrl,
      token: pairing.relayToken,
      registrationProof: pairing.registrationProof,
      keyPair: {
        publicKey: pairing.publicKey,
        secretKey: pairing.secretKey,
      },
      pairingSecret: pairing.pairingSecret,
    },
    {},
  );

  const connectStart = Date.now();
  const deadline = connectStart + opts.timeoutMs;
  try {
    await client.connect();
    client.subscribe(RELAY_CHANNEL_CONTROL);

    while (Date.now() < deadline) {
      if (client.listPeerFrontendIds().length > 0) break;
      // Early exit: relay unreachable (never connected) and cutoff elapsed.
      if (
        !client.isConnected() &&
        Date.now() - connectStart >= opts.connectCutoffMs
      ) {
        break;
      }
      await Bun.sleep(DEFAULT_UNPAIR_GRACE_MS);
    }

    const peers = client.listPeerFrontendIds();
    let notified = 0;
    for (const fid of peers) {
      try {
        if (await send(client, fid)) notified++;
      } catch {
        // best effort
      }
    }
    if (peers.length > 0) {
      console.log(dim(`Notified ${notified}/${peers.length} frontend(s).`));
    }

    // Grace period so the relay can forward the control frame before we
    // disconnect. If the peer was still completing kx at send time, the
    // frame waits in the relay's per-session 10-frame cache.
    await Bun.sleep(DEFAULT_UNPAIR_GRACE_MS);
  } finally {
    client.dispose();
  }
}

async function notifyPeerUnpair(
  pairing: FullPairing,
  opts: { timeoutMs: number; connectCutoffMs: number },
): Promise<void> {
  return notifyPeer(pairing, opts, (c, fid) =>
    c.sendUnpairNotice(fid, "user-initiated"),
  );
}

async function notifyPeerRename(
  pairing: FullPairing,
  label: string,
  opts: { timeoutMs: number; connectCutoffMs: number },
): Promise<void> {
  return notifyPeer(pairing, opts, (c, fid) => c.sendRenameNotice(fid, label));
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

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(Date.now() - ms).toISOString().slice(0, 10);
}

function printPairUsage(): void {
  console.log(`
tp pair — manage mobile app pairings

Usage:
  tp pair [--relay URL]                        Alias for 'tp pair new'
  tp pair new [--relay URL] [--label <name>]   Generate a new pairing (QR code)
                                               (label defaults to os.hostname())
  tp pair list                                 List registered pairings
  tp pair rename <daemon-id> <label...>        Rename a pairing (prefix match)
  tp pair delete <daemon-id> [-y]              Delete a pairing (prefix match allowed)
`);
}

/**
 * Load saved pairing data (used by daemon CLI).
 */
export async function loadPairingData(): Promise<{
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  publicKey: string;
  secretKey: string;
  label?: string;
  createdAt?: number;
  qrData?: {
    ps: string;
    pk: string;
    relay: string;
    did: string;
    v: number;
    label?: string;
  };
} | null> {
  try {
    const raw = await readFile(PAIRING_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
