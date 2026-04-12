import { Daemon } from "@teleprompter/daemon";

/**
 * tp logs [sid]
 *
 * Tails live records from a session by polling the Store every 500ms.
 * If no SID is given, prints the list of known sessions and exits.
 */
export async function logsCommand(argv: string[]): Promise<void> {
  let sid: string | undefined;
  for (const a of argv) {
    if (!a.startsWith("--")) {
      sid = a;
      break;
    }
  }

  const daemon = new Daemon();

  if (!sid) {
    const sessions = daemon.listSessions();
    if (sessions.length === 0) {
      console.error("No sessions found.");
    } else {
      console.error("Usage: tp logs <sid>");
      console.error("Available sessions:");
      for (const s of sessions) {
        const mark = s.state === "running" ? "●" : "○";
        console.error(`  ${mark} ${s.sid}  seq=${s.last_seq}  ${s.state}`);
      }
    }
    daemon.close();
    process.exit(sessions.length === 0 ? 1 : 0);
    return;
  }

  const session = daemon.getSession(sid);
  if (!session) {
    console.error(`Session ${sid} not found.`);
    daemon.close();
    process.exit(1);
    return;
  }

  console.error(`Tailing session: ${sid} (seq=${session.last_seq})`);
  console.error("Press Ctrl+C to stop.\n");

  let lastSeq = 0;
  const tick = (): void => {
    const recs = daemon.getRecordsSince(sid!, lastSeq);
    for (const r of recs) {
      if (r.kind === "io") {
        process.stdout.write(Buffer.from(r.payload).toString("utf-8"));
      } else if (r.kind === "event") {
        try {
          const event = JSON.parse(Buffer.from(r.payload).toString("utf-8"));
          const name = event.hook_event_name ?? event.name ?? "unknown";
          const ts = new Date(r.ts).toISOString().slice(11, 23);
          console.error(`\n[${ts}] event ${name}`);
          if (event.last_assistant_message) {
            console.error(
              `  → ${String(event.last_assistant_message).slice(0, 200)}`,
            );
          }
          if (event.tool_name) {
            console.error(`  tool: ${event.tool_name}`);
          }
        } catch {
          /* ignore parse errors */
        }
      }
      lastSeq = r.seq;
    }
  };

  // Initial drain, then poll.
  tick();
  const timer = setInterval(tick, 500);

  process.on("SIGINT", () => {
    clearInterval(timer);
    daemon.close();
    process.exit(0);
  });
}
