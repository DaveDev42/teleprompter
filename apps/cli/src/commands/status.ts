import type { WsServerMessage, WsSessionMeta } from "@teleprompter/protocol";

/**
 * tp status — shows the current daemon state.
 * Connects to the daemon WS, gets session list, and displays it.
 */
export async function statusCommand(argv: string[]): Promise<void> {
  const port = argv[0] ?? "7080";
  const url = `ws://localhost:${port}`;

  console.log(`Connecting to daemon at ${url}...`);

  const ws = new WebSocket(url);

  const timeout = setTimeout(() => {
    console.error("Connection timed out. Is the daemon running?");
    console.error(`  Start with: tp daemon start --ws-port ${port}`);
    process.exit(1);
  }, 3000);

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello" }));
  };

  ws.onerror = () => {
    clearTimeout(timeout);
    console.error(`Cannot connect to daemon at ${url}`);
    console.error(`  Start with: tp daemon start --ws-port ${port}`);
    process.exit(1);
  };

  ws.onmessage = (event) => {
    clearTimeout(timeout);
    const msg: WsServerMessage = JSON.parse(event.data as string);
    if (msg.t === "hello") {
      displayStatus(msg.d.sessions);
      ws.close();
      process.exit(0);
    }
  };
}

function displayStatus(sessions: WsSessionMeta[]): void {
  console.log("");
  console.log(`Daemon Status`);
  console.log(`─────────────`);
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

  // Group by worktree
  const groups = new Map<string, WsSessionMeta[]>();
  for (const s of sessions) {
    const key = s.worktreePath ?? s.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  for (const [path, group] of groups) {
    console.log(`  ${path}`);
    for (const s of group) {
      const stateIcon =
        s.state === "running" ? "●" : s.state === "stopped" ? "○" : "✕";
      const stateColor =
        s.state === "running" ? "\x1b[32m" : s.state === "stopped" ? "\x1b[90m" : "\x1b[31m";
      const reset = "\x1b[0m";

      console.log(
        `    ${stateColor}${stateIcon}${reset} ${s.sid}  seq=${s.lastSeq}  ${s.state}`,
      );
      if (s.claudeVersion) {
        console.log(`      claude ${s.claudeVersion}`);
      }
      const age = formatAge(Date.now() - s.updatedAt);
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
