// NOTE: This file is also embedded as a string constant in pty-host-installer.ts
// (PTY_HOST_SCRIPT). When modifying this file, update the embedded copy too.
// The embedded version is used for compiled binary deployment where this file
// is not available on disk.
"use strict";

const pty = require("@aspect-build/node-pty");
const readline = require("readline");

let ptyProcess = null;

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ type: "error", message: "invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "spawn": {
      if (ptyProcess) {
        send({ type: "error", message: "already spawned" });
        return;
      }
      try {
        const cmd = msg.command[0];
        const args = msg.command.slice(1);
        ptyProcess = pty.spawn(cmd, args, {
          name: "xterm-256color",
          cols: msg.cols || 120,
          rows: msg.rows || 40,
          cwd: msg.cwd,
        });

        send({ type: "pid", pid: ptyProcess.pid });

        ptyProcess.onData((data) => {
          send({ type: "data", data: Buffer.from(data).toString("base64") });
        });

        ptyProcess.onExit(({ exitCode }) => {
          send({ type: "exit", code: exitCode ?? 1 });
          ptyProcess = null;
        });
      } catch (err) {
        send({ type: "error", message: err.message });
      }
      break;
    }

    case "write": {
      if (!ptyProcess) return;
      const buf = Buffer.from(msg.data, "base64");
      ptyProcess.write(buf.toString());
      break;
    }

    case "resize": {
      if (!ptyProcess) return;
      ptyProcess.resize(msg.cols, msg.rows);
      break;
    }

    case "kill": {
      if (!ptyProcess) return;
      ptyProcess.kill(msg.signal);
      break;
    }

    default:
      send({ type: "error", message: `unknown type: ${msg.type}` });
  }
});

rl.on("close", () => {
  if (ptyProcess) {
    ptyProcess.kill();
  }
  process.exit(0);
});
