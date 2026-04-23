import { Store } from "@teleprompter/daemon";
import type {
  IpcSessionDelete,
  IpcSessionDeleteErr,
  IpcSessionDeleteOk,
  IpcSessionPrune,
  IpcSessionPruneErr,
  IpcSessionPruneOk,
} from "@teleprompter/protocol";
import { getSocketPath } from "@teleprompter/protocol";
import { parseArgs } from "util";
import { dim, fail, ok } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { formatAge } from "../lib/format";
import { connectIpcAsClient, type IpcClient } from "../lib/ipc-client";

export async function sessionCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "list":
      await sessionList(argv.slice(1));
      return;
    case "delete":
      await sessionDelete(argv.slice(1));
      return;
    case "prune":
      await sessionPrune(argv.slice(1));
      return;
    case "--help":
    case "-h":
    case undefined:
      printSessionUsage();
      return;
    default:
      console.error(fail(`Unknown subcommand: tp session ${sub}`));
      printSessionUsage();
      process.exit(1);
  }
}

/**
 * Parse a human duration like `7d`, `24h`, `30m`, `45s` into milliseconds.
 * Throws on unknown or non-positive inputs — the CLI converts the throw into
 * a clear "Invalid duration" error.
 */
export function parseDuration(raw: string): number {
  const match = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Invalid duration '${raw}'. Expected <N><s|m|h|d>, e.g. 7d / 24h / 30m.`,
    );
  }
  const n = Number(match[1]);
  const unit = match[2]!;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid duration '${raw}'. Must be a positive integer.`);
  }
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return n * multipliers[unit]!;
}

/**
 * Resolve a sid fragment against a candidate list. Exact match wins, prefix
 * match next, otherwise empty. No substring matches — sids can be long and
 * collide easily in the middle.
 */
export function matchSessions<T extends { sid: string }>(
  candidates: readonly T[],
  fragment: string,
): T[] {
  const exact = candidates.filter((c) => c.sid === fragment);
  if (exact.length > 0) return exact;
  return candidates.filter((c) => c.sid.startsWith(fragment));
}

async function sessionList(argv: string[]): Promise<void> {
  parseArgs({
    args: argv,
    options: {},
    allowPositionals: false,
    strict: true,
  });

  const store = new Store();
  let sessions: ReturnType<Store["listSessions"]>;
  try {
    sessions = store.listSessions();
  } finally {
    store.close();
  }

  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }

  const rows = sessions.map((s) => ({
    sid: s.sid,
    state: s.state,
    cwd: s.worktree_path ?? s.cwd,
    age: formatAge(Date.now() - s.updated_at),
  }));

  const sidW = Math.max(3, ...rows.map((r) => r.sid.length));
  const stateW = Math.max(5, ...rows.map((r) => r.state.length));
  const cwdW = Math.max(3, ...rows.map((r) => r.cwd.length));

  console.log(
    `${"SID".padEnd(sidW)}  ${"STATE".padEnd(stateW)}  ${"CWD".padEnd(cwdW)}  UPDATED`,
  );
  for (const r of rows) {
    console.log(
      `${r.sid.padEnd(sidW)}  ${r.state.padEnd(stateW)}  ${r.cwd.padEnd(cwdW)}  ${r.age}`,
    );
  }
}

async function sessionDelete(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", short: "y", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length !== 1) {
    console.error(fail("Usage: tp session delete <sid> [--yes]"));
    process.exit(1);
  }
  const prefix = positionals[0]!;

  const store = new Store();
  let target: { sid: string };
  try {
    const candidates = store.listSessions().map((s) => ({ sid: s.sid }));
    const matches = matchSessions(candidates, prefix);
    if (matches.length === 0) {
      console.error(fail(`No session matches '${prefix}'.`));
      if (candidates.length > 0) {
        console.error(dim("Known sids:"));
        for (const c of candidates) console.error(dim(`  ${c.sid}`));
      }
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(fail(`Prefix '${prefix}' is ambiguous. Candidates:`));
      for (const c of matches) console.error(`  ${c.sid}`);
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
    const answer = await prompt(`Delete session ${target.sid}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
  }

  // Prefer the daemon path when one is already running: the daemon holds the
  // Runner process reference and will kill it cleanly before deleting the
  // store rows. Without a daemon the session cannot be "running" anymore
  // (daemon death already orphans Runners), so a direct Store write is safe.
  if (await isDaemonRunning()) {
    const result = await requestSessionOp<
      IpcSessionDeleteOk | IpcSessionDeleteErr
    >({ t: "session.delete", sid: target.sid }, [
      "session.delete.ok",
      "session.delete.err",
    ]);
    if (result.t === "session.delete.err") {
      console.error(
        fail(
          `Session delete failed: ${result.reason}${result.message ? ` — ${result.message}` : ""}`,
        ),
      );
      process.exit(1);
    }
    console.log(ok(`Deleted session ${result.sid}`));
    if (result.wasRunning) {
      console.log(dim("Killed running runner before delete."));
    }
    return;
  }

  const deleteStore = new Store();
  try {
    deleteStore.deleteSession(target.sid);
  } finally {
    deleteStore.close();
  }
  console.log(ok(`Deleted session ${target.sid}`));
}

async function sessionPrune(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "older-than": { type: "string", default: "7d" },
      all: { type: "boolean", default: false },
      running: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  let olderThanMs: number | null;
  if (values.all) {
    olderThanMs = null;
  } else {
    try {
      olderThanMs = parseDuration(values["older-than"] as string);
    } catch (err) {
      console.error(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  const includeRunning = Boolean(values.running);
  const dryRun = Boolean(values["dry-run"]);

  // Confirmation gate: running-session inclusion is the dangerous mode and
  // requires an explicit --yes (two "walls" — --running flag + --yes). For a
  // pure stopped-session prune a single --yes covers it; --dry-run never
  // needs confirmation.
  if (!dryRun && !values.yes) {
    if (!process.stdin.isTTY) {
      const msg = includeRunning
        ? "Refusing to prune (including running) without --yes."
        : "Refusing to prune without --yes (use --dry-run to preview).";
      console.error(fail(msg));
      process.exit(1);
    }
    const question = includeRunning
      ? `Prune stopped + running sessions (older than ${values["older-than"]})? [y/N] `
      : `Prune stopped sessions (older than ${values["older-than"]})? [y/N] `;
    const answer = await prompt(question);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
    if (includeRunning) {
      const answer2 = await prompt(
        "This will KILL running Claude sessions. Are you sure? [y/N] ",
      );
      if (!/^y(es)?$/i.test(answer2.trim())) {
        console.log("Aborted.");
        return;
      }
    }
  }

  const daemonUp = await isDaemonRunning();
  let result: IpcSessionPruneOk;

  if (daemonUp) {
    const reply = await requestSessionOp<
      IpcSessionPruneOk | IpcSessionPruneErr
    >(
      {
        t: "session.prune",
        olderThanMs,
        includeRunning,
        dryRun,
      },
      ["session.prune.ok", "session.prune.err"],
    );
    if (reply.t === "session.prune.err") {
      console.error(
        fail(
          `Session prune failed: ${reply.reason}${reply.message ? ` — ${reply.message}` : ""}`,
        ),
      );
      process.exit(1);
    }
    result = reply;
  } else {
    // Daemon-less path: select + delete directly. Without a live daemon no
    // Runner is attached, so `includeRunning` only affects whether stale
    // "running" rows from a prior crash get swept.
    const store = new Store();
    let candidates: ReturnType<Store["listSessions"]>;
    try {
      const now = Date.now();
      candidates = store.listSessions().filter((s) => {
        if (s.state === "running" && !includeRunning) return false;
        if (olderThanMs === null) return true;
        return s.updated_at < now - olderThanMs;
      });

      if (dryRun) {
        result = {
          t: "session.prune.ok",
          sids: candidates.map((s) => s.sid),
          runningKilled: 0,
          dryRun: true,
        };
      } else {
        const deleted: string[] = [];
        let runningKilled = 0;
        for (const s of candidates) {
          if (s.state === "running") runningKilled++;
          store.deleteSession(s.sid);
          deleted.push(s.sid);
        }
        result = {
          t: "session.prune.ok",
          sids: deleted,
          runningKilled,
          dryRun: false,
        };
      }
    } finally {
      store.close();
    }
  }

  if (result.sids.length === 0) {
    console.log("No sessions selected (0 matched).");
    return;
  }

  if (result.dryRun) {
    console.log(`Would delete ${result.sids.length} session(s) (dry-run):`);
    for (const sid of result.sids) console.log(`  ${sid}`);
    return;
  }

  console.log(ok(`Pruned ${result.sids.length} session(s):`));
  for (const sid of result.sids) console.log(`  ${sid}`);
  if (result.runningKilled > 0) {
    console.log(dim(`Killed ${result.runningKilled} running runner(s).`));
  }
}

async function requestSessionOp<R extends { t: string }>(
  msg: IpcSessionDelete | IpcSessionPrune,
  expectedTypes: readonly string[],
): Promise<R> {
  let ipc: IpcClient | null = null;
  try {
    ipc = await connectIpcAsClient(getSocketPath());
    return await new Promise<R>((resolve, reject) => {
      ipc!.onMessage((raw) => {
        const r = raw as R;
        if (expectedTypes.includes(r.t)) resolve(r);
      });
      ipc!.onClose(() =>
        reject(new Error("Daemon disconnected before replying")),
      );
      ipc!.send(msg);
    });
  } finally {
    try {
      ipc?.close();
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

function printSessionUsage(): void {
  console.log(`
tp session — manage stored sessions

Usage:
  tp session list                                  List sessions (running + stopped)
  tp session delete <sid> [-y]                     Delete a session (prefix match allowed)
  tp session prune [options]                       Bulk-delete stopped sessions
    --older-than <Nd|Nh|Nm|Ns>   Age cutoff (default: 7d)
    --all                        Delete every stopped session (overrides --older-than)
    --running                    Also kill & delete running sessions (dangerous)
    --dry-run                    Print selection without deleting
    -y, --yes                    Skip confirmation

Notes:
  Runs against a running daemon when available (kills Runners cleanly).
  Falls back to a direct store write when no daemon is up.
`);
}
