import { Runner } from "@teleprompter/runner";
import { parseArgs } from "util";

export async function runCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      sid: { type: "string" },
      cwd: { type: "string", default: process.cwd() },
      "worktree-path": { type: "string" },
      "socket-path": { type: "string" },
      cols: { type: "string", default: "120" },
      rows: { type: "string", default: "40" },
    },
    allowPositionals: true,
  });

  const sid = values.sid ?? `session-${Date.now()}`;
  const cwd = values.cwd ?? process.cwd();

  const runner = new Runner({
    sid,
    cwd,
    worktreePath: values["worktree-path"],
    socketPath: values["socket-path"],
    cols: parseInt(values.cols ?? "120", 10),
    rows: parseInt(values.rows ?? "40", 10),
    claudeArgs: positionals,
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  try {
    await runner.start();
  } catch (err) {
    console.error("[Runner] fatal:", err);
    process.exit(1);
  }
}
