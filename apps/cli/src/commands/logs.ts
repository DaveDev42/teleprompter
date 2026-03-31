import type { WsRec, WsServerMessage } from "@teleprompter/protocol";
import { ensureDaemon } from "../lib/ensure-daemon";

/**
 * tp logs [sid] [--port 7080]
 *
 * Tails live records from a session. If no SID is given,
 * attaches to the first running session. Auto-starts daemon if needed.
 */
export async function logsCommand(argv: string[]): Promise<void> {
  let sid: string | undefined;
  let port = "7080";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      port = argv[i + 1];
      i++;
    } else if (!argv[i].startsWith("--")) {
      sid = argv[i];
    }
  }

  const portNum = parseInt(port, 10);
  const url = `ws://localhost:${port}`;

  const running = await ensureDaemon(portNum);
  if (!running) {
    process.exit(1);
  }

  const ws = new WebSocket(url);

  const timeout = setTimeout(() => {
    console.error("Connection timed out.");
    process.exit(1);
  }, 5000);

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello", v: 1 }));
  };

  ws.onerror = () => {
    clearTimeout(timeout);
    console.error(`Cannot connect to daemon at ${url}`);
    process.exit(1);
  };

  ws.onmessage = (event) => {
    const msg: WsServerMessage = JSON.parse(event.data as string);

    switch (msg.t) {
      case "hello": {
        clearTimeout(timeout);
        const sessions = msg.d.sessions;
        const target = sid
          ? sessions.find((s) => s.sid === sid)
          : sessions.find((s) => s.state === "running");

        if (!target) {
          console.error(
            sid ? `Session ${sid} not found.` : "No running sessions.",
          );
          if (sessions.length > 0) {
            console.error("Available sessions:");
            for (const s of sessions) {
              console.error(`  ${s.state === "running" ? "●" : "○"} ${s.sid}`);
            }
          }
          ws.close();
          process.exit(1);
          return;
        }

        console.error(`Tailing session: ${target.sid} (seq=${target.lastSeq})`);
        console.error("Press Ctrl+C to stop.\n");

        ws.send(JSON.stringify({ t: "attach", sid: target.sid }));
        // Also resume from current seq to get future records
        ws.send(
          JSON.stringify({ t: "resume", sid: target.sid, c: target.lastSeq }),
        );
        break;
      }

      case "rec":
        printRecord(msg);
        break;

      case "batch":
        for (const rec of msg.d) {
          printRecord(rec);
        }
        break;

      case "state":
        console.error(`[state] ${msg.sid}: ${msg.d.state}`);
        break;
    }
  };

  // Keep running until Ctrl+C
  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}

function printRecord(rec: WsRec): void {
  const ts = new Date(rec.ts).toISOString().slice(11, 23);
  const kind = rec.k.padEnd(5);

  if (rec.k === "io") {
    // Decode and print raw PTY output
    try {
      const text = Buffer.from(rec.d, "base64").toString("utf-8");
      process.stdout.write(text);
    } catch {
      console.log(`[${ts}] ${kind} <binary>`);
    }
  } else if (rec.k === "event") {
    try {
      const event = JSON.parse(Buffer.from(rec.d, "base64").toString("utf-8"));
      const name = event.hook_event_name ?? event.name ?? "unknown";
      console.error(`\n[${ts}] event ${name}`);
      if (event.last_assistant_message) {
        console.error(`  → ${event.last_assistant_message.slice(0, 200)}`);
      }
      if (event.tool_name) {
        console.error(`  tool: ${event.tool_name}`);
      }
    } catch {
      console.error(`[${ts}] event <parse error>`);
    }
  } else {
    console.error(`[${ts}] ${kind} seq=${rec.seq}`);
  }
}
