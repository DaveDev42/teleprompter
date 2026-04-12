import { Daemon, type SessionMeta } from "@teleprompter/daemon";
import { getSocketPath } from "@teleprompter/protocol";
import { existsSync } from "fs";
import { dim, green, red } from "../lib/colors";

/**
 * tp status — shows the current daemon state.
 *
 * Reads the Store directly (the Store is the source of truth regardless of
 * whether the background daemon is currently running). Also reports whether
 * the daemon IPC socket is live.
 */
export async function statusCommand(_argv: string[]): Promise<void> {
  const socketPath = getSocketPath();
  const backgroundRunning = existsSync(socketPath);

  const daemon = new Daemon();
  const sessions = daemon.listSessions();
  daemon.close();

  displayStatus(sessions, backgroundRunning);
  process.exit(0);
}

function displayStatus(
  sessions: SessionMeta[],
  backgroundRunning: boolean,
): void {
  console.log("");
  console.log(`Daemon Status`);
  console.log(`─────────────`);
  console.log(
    `Background daemon: ${
      backgroundRunning ? green("running") : dim("not running")
    }`,
  );
  console.log(`Sessions: ${sessions.length}`);
  console.log("");

  if (sessions.length === 0) {
    console.log("No active sessions.");
    console.log("");
    console.log("Start a session:");
    console.log("  tp -p 'hello'                    # passthrough mode");
    console.log("  tp daemon start --spawn --cwd .   # managed mode");
    return;
  }

  const groups = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const key = s.worktree_path ?? s.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(s);
  }

  for (const [path, group] of groups) {
    console.log(`  ${path}`);
    for (const s of group) {
      const indicator =
        s.state === "running"
          ? green("●")
          : s.state === "stopped"
            ? dim("○")
            : red("✕");

      console.log(`    ${indicator} ${s.sid}  seq=${s.last_seq}  ${s.state}`);
      if (s.claude_version) {
        console.log(`      claude ${s.claude_version}`);
      }
      const age = formatAge(Date.now() - s.updated_at);
      console.log(`      updated ${age}`);
    }
    console.log("");
  }
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
