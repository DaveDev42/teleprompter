import { accessSync, constants } from "fs";

import { errorWithHints } from "./format";

/**
 * Resolve the opt-in Rust-runner override (`TP_RUNNER_BIN`, ADR-0003 Stage 4
 * increment 3). Returns `null` when unset/empty — the caller then stays on the
 * default Bun runner, byte-identical to pre-inc3 behavior.
 *
 * When set to a non-empty value, it is treated as an absolute path to the Rust
 * `tp-runner` binary and validated with `accessSync(path, X_OK)`. An invalid
 * value (missing / non-executable) **throws** rather than silently falling back
 * to Bun: a typo'd override that quietly ran Bun would make a dual-run/parity
 * exercise *look* like it exercised the Rust runner when it did not — the one
 * outcome that defeats the whole point of the seam.
 *
 * The value is a full path only — never a boolean/toggle. This mirrors the
 * symmetric in-repo precedent `TP_BUN_BLOB` (`rust/tp-cli/src/locate.rs`), a
 * full-path escape hatch rather than an auto-locating switch. The only callers
 * (the parity harness and an operator dogfooding a single session) already know
 * the exact path they built, and a toggle would risk silently launching a stale
 * binary from an ambiguous search path.
 */
export function resolveRunnerBinOverride(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env["TP_RUNNER_BIN"];
  if (!raw) return null;
  try {
    accessSync(raw, constants.X_OK);
  } catch {
    throw new Error(
      errorWithHints(`TP_RUNNER_BIN='${raw}' is not an executable file`, [
        "Build it: (cd rust && cargo build --bin tp-runner)",
        "Point TP_RUNNER_BIN at rust/target/debug/tp-runner (or --release)",
        "Unset TP_RUNNER_BIN to use the default Bun runner",
      ]),
    );
  }
  return raw;
}
