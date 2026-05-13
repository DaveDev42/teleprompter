import { type ParseArgsConfig, parseArgs } from "util";
import { dim, fail } from "./colors";

/**
 * Wraps `parseArgs` so unknown flags / malformed input exit 1 with a human
 * message (plus an optional usage line) instead of a raw Node `TypeError`
 * stack trace. Node throws `ERR_PARSE_ARGS_*` errors here — without this the
 * top-level `main().catch` would dump the whole stack.
 */
export function parseArgsFriendly<T extends ParseArgsConfig>(
  config: T,
  usage?: string,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(fail(message));
    if (usage) console.error(dim(usage));
    process.exit(1);
  }
}
