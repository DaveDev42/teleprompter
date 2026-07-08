import { accessSync, constants } from "fs";

import { errorWithHints } from "./format";

/**
 * Resolve the opt-in Rust-daemon override (`TP_DAEMON_BIN`, ADR-0003 Phase 4
 * increment 6). Returns `null` when unset/empty — the caller then stays on the
 * default Bun daemon, byte-identical to pre-inc6 behavior.
 *
 * When set to a non-empty value, it is treated as an absolute path to the Rust
 * `tp-daemon` binary and validated with `accessSync(path, X_OK)`. An invalid
 * value (missing / non-executable) **throws** rather than silently falling back
 * to Bun: a typo'd override that quietly ran Bun would make a dual-run/parity
 * exercise *look* like it exercised the Rust daemon when it did not — the one
 * outcome that defeats the whole point of the seam.
 *
 * The value is a full path only — never a boolean/toggle. This mirrors the
 * proven `TP_RUNNER_BIN` seam (`runner-bin.ts`) and the symmetric in-repo
 * precedent `TP_BUN_BLOB` (`rust/tp-cli/src/locate.rs`): a full-path escape
 * hatch rather than an auto-locating switch. The only callers (the parity
 * harness and an operator dogfooding the Rust daemon) already know the exact
 * path they built, and a toggle would risk silently launching a stale binary
 * from an ambiguous search path.
 *
 * Trust boundary: this seam reads the daemon-spawning *process env* only —
 * nothing relay-supplied can ever choose the daemon binary.
 */
export function resolveDaemonBinOverride(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env["TP_DAEMON_BIN"];
  if (!raw) return null;
  try {
    accessSync(raw, constants.X_OK);
  } catch {
    throw new Error(
      errorWithHints(`TP_DAEMON_BIN='${raw}' is not an executable file`, [
        "Build it: (cd rust && cargo build --release --bin tp-daemon)",
        "Point TP_DAEMON_BIN at rust/target/release/tp-daemon (or debug)",
        "Unset TP_DAEMON_BIN to use the default Bun daemon",
      ]),
    );
  }
  return raw;
}
