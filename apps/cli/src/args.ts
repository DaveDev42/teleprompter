/**
 * Separates --tp-* arguments (consumed by tp) from the rest (passed to claude).
 *
 * Supported --tp-* flags:
 *   --tp-sid <string>       Session ID
 *   --tp-cwd <string>       Working directory
 *
 * Everything else is forwarded to claude as-is.
 *
 * Example:
 *   tp --tp-sid my-session -p "hello" --model opus
 *   → tpArgs: { sid: "my-session" }
 *   → claudeArgs: ["-p", "hello", "--model", "opus"]
 */

export interface TpArgs {
  sid?: string;
  cwd?: string;
}

export interface SplitResult {
  tpArgs: TpArgs;
  claudeArgs: string[];
}

const TP_VALUE_FLAGS = new Set(["--tp-sid", "--tp-cwd"]);

export function splitArgs(argv: string[]): SplitResult {
  const tpArgs: TpArgs = {};
  const claudeArgs: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;

    if (TP_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value.\n`);
        console.error(`Usage: tp ${arg} <value> [claude args...]`);
        console.error(
          `Example: tp ${arg} ${arg === "--tp-sid" ? "my-session" : "/path/to/project"} -p "hello"`,
        );
        process.exit(1);
      }
      switch (arg) {
        case "--tp-sid":
          tpArgs.sid = value;
          break;
        case "--tp-cwd":
          tpArgs.cwd = value;
          break;
      }
      i += 2;
    } else {
      claudeArgs.push(arg);
      i += 1;
    }
  }

  return { tpArgs, claudeArgs };
}
