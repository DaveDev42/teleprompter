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
import { type ParseArgsConfig, parseArgs } from "util";
import { dim, fail, ok, yellow } from "../lib/colors";
import { isDaemonRunning } from "../lib/ensure-daemon";
import { formatAge } from "../lib/format";
import { connectIpcAsClient } from "../lib/ipc-client";

/** Wraps `parseArgs` so unknown flags / malformed input exit 1 with a human
 * message instead of a raw node TypeError stack trace. */
function parseArgsFriendly<T extends ParseArgsConfig>(
  config: T,
  usage: string,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(fail(message));
    console.error(dim(usage));
    process.exit(1);
  }
}

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

const DURATION_MULTIPLIERS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const satisfies Record<string, number>;

type DurationUnit = keyof typeof DURATION_MULTIPLIERS;

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
  const unit = match[2] as DurationUnit;
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid duration '${raw}'. Must be a positive integer.`);
  }
  return n * DURATION_MULTIPLIERS[unit];
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
  parseArgsFriendly(
    {
      args: argv,
      options: {},
      allowPositionals: false,
      strict: true,
    },
    "Usage: tp session list",
  );

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
  const { values, positionals } = parseArgsFriendly(
    {
      args: argv,
      options: {
        yes: { type: "boolean", short: "y", default: false },
      },
      allowPositionals: true,
      strict: true,
    },
    "Usage: tp session delete <sid> [--yes]",
  );

  const prefix = positionals[0];
  if (positionals.length !== 1 || !prefix) {
    console.error(fail("Usage: tp session delete <sid> [--yes]"));
    process.exit(1);
  }

  const store = new Store();
  let target: { sid: string };
  try {
    const candidates = store.listSessions().map((s) => ({ sid: s.sid }));
    const matches = matchSessions(candidates, prefix);
    if (matches.length === 0) {
      console.error(fail(`No session matches '${prefix}'.`));
      if (candidates.length > 0) {
        // Cap the "Known sids:" hint so a store with hundreds of rows
        // doesn't flood the terminal. Users with that many sessions
        // typically already know the sid anyway.
        const MAX_HINT = 20;
        const shown = candidates.slice(0, MAX_HINT);
        console.error(dim("Known sids:"));
        for (const c of shown) console.error(dim(`  ${c.sid}`));
        if (candidates.length > MAX_HINT) {
          console.error(
            dim(
              `  … ${candidates.length - MAX_HINT} more (run 'tp session list')`,
            ),
          );
        }
      }
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(fail(`Prefix '${prefix}' is ambiguous. Candidates:`));
      for (const c of matches) console.error(`  ${c.sid}`);
      process.exit(1);
    }
    const first = matches[0];
    // matches.length === 1 already asserted by the branches above; this
    // narrows away the nullable for TS without a non-null assertion.
    if (!first) {
      console.error(fail("internal: empty match set"));
      process.exit(1);
    }
    target = first;
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
  const { values } = parseArgsFriendly(
    {
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
    },
    "Usage: tp session prune [--older-than <Nd|Nh|Nm|Ns>] [--all] [--running] [--dry-run] [-y]",
  );

  // `default: "7d"` on the option guarantees this is always a string at
  // runtime; the `?? "7d"` is a belt-and-suspenders fallback that also
  // narrows the type for TS without casting.
  const olderThanRaw =
    typeof values["older-than"] === "string" ? values["older-than"] : "7d";
  let olderThanMs: number | null;
  if (values.all) {
    olderThanMs = null;
  } else {
    try {
      olderThanMs = parseDuration(olderThanRaw);
    } catch (err) {
      console.error(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
  }

  const includeRunning = Boolean(values.running);
  const dryRun = Boolean(values["dry-run"]);

  // Confirmation gates:
  //   - dry-run: always proceeds, never prompts (read-only).
  //   - --yes: accepted both as a blanket bypass (non-TTY) AND (on TTY) is
  //     equivalent to a single "y" at the prompt. `--running` needs an extra
  //     challenge phrase on TTY — `--yes` still bypasses it, matching the
  //     spirit of the spec's "confirmation 2회" (two deliberate acts: the
  //     `--running` flag itself is the first act, `--yes` is the second).
  //   - non-TTY + no --yes: always refuse (never silently destroy).
  //   - TTY + no --yes: one y/N prompt for stopped-only, plus a typed
  //     challenge ("RUNNING") for `--running` to force a deliberate act.
  if (!dryRun && !values.yes) {
    if (!process.stdin.isTTY) {
      const msg = includeRunning
        ? "Refusing to prune (including running) without --yes."
        : "Refusing to prune without --yes (use --dry-run to preview).";
      console.error(fail(msg));
      process.exit(1);
    }
    const question = includeRunning
      ? `Prune stopped + running sessions (older than ${olderThanRaw})? [y/N] `
      : `Prune stopped sessions (older than ${olderThanRaw})? [y/N] `;
    const answer = await prompt(question);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }
    if (includeRunning) {
      const challenge = await prompt(
        `${yellow("This will KILL running Claude sessions.")} Type 'RUNNING' to confirm: `,
      );
      if (challenge.trim() !== "RUNNING") {
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
      if (reply.partialSids.length > 0) {
        console.error(
          dim(
            `Deleted ${reply.partialSids.length} session(s) before the error:`,
          ),
        );
        for (const sid of reply.partialSids) console.error(dim(`  ${sid}`));
      }
      process.exit(1);
    }
    result = reply;
  } else {
    // Daemon-less path: select + delete directly. Without a live daemon no
    // Runner is attached, so `includeRunning` only affects whether stale
    // "running" rows from a prior crash get swept.
    const store = new Store();
    const deleted: string[] = [];
    let runningKilled = 0;
    try {
      const now = Date.now();
      const candidates = store.listSessions().filter((s) => {
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
    } catch (err) {
      console.error(
        fail(
          `Session prune failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      if (deleted.length > 0) {
        console.error(
          dim(`Deleted ${deleted.length} session(s) before the error:`),
        );
        for (const sid of deleted) console.error(dim(`  ${sid}`));
      }
      process.exit(1);
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

/**
 * Fallback for a daemon that accepts the request but never sends a reply
 * of the expected shape (e.g. protocol drift, bug). `--all` on a giant store
 * still fits well under this cap because each delete is a single SQLite
 * write — 30s buys >> 1000 rows.
 */
const SESSION_OP_TIMEOUT_MS = 30_000;

async function requestSessionOp<R extends { t: string }>(
  msg: IpcSessionDelete | IpcSessionPrune,
  expectedTypes: readonly string[],
): Promise<R> {
  const ipc = await connectIpcAsClient(getSocketPath());
  try {
    return await new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Daemon did not reply within ${SESSION_OP_TIMEOUT_MS / 1000}s; try 'tp daemon status' or restart the daemon`,
          ),
        );
      }, SESSION_OP_TIMEOUT_MS);
      const done = (settle: () => void): void => {
        clearTimeout(timer);
        settle();
      };
      ipc.onMessage((raw) => {
        const r = raw as R;
        if (expectedTypes.includes(r.t)) done(() => resolve(r));
      });
      ipc.onClose(() =>
        done(() => reject(new Error("Daemon disconnected before replying"))),
      );
      ipc.send(msg);
    });
  } finally {
    try {
      ipc.close();
    } catch {
      /* best effort */
    }
  }
}

async function prompt(question: string): Promise<string> {
  // readline's line buffering yields one resolved answer per newline, which
  // is the right semantics for y/N and challenge-phrase confirmations —
  // raw `once("data")` can truncate a chunked paste.
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
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
    ${yellow("--running")}                    Also kill & delete running sessions (${yellow("dangerous")})
    --dry-run                    Print selection without deleting
    -y, --yes                    Skip confirmation

Notes:
  Runs against a running daemon when available (kills Runners cleanly).
  Falls back to a direct store write when no daemon is up.
`);
}
