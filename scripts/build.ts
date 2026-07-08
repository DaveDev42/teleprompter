/**
 * Multi-platform build script for the `tp` CLI binary.
 *
 * Usage:
 *   bun run scripts/build.ts              # Build Bun tpd for current platform (dev fallback)
 *   bun run scripts/build.ts --all        # Build Bun tpd for all platforms
 *   bun run scripts/build.ts --target X   # Build Bun tpd for specific target
 *   bun run scripts/build.ts --bundle     # THE release/CI path: build bin/tp (Rust) +
 *                                         # libexec/tp/tpd (Bun SEA) + assemble
 *                                         # per-platform tarballs in dist/bundles/
 *
 * Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64
 *
 * # Packaging layout (--bundle — the release and CI path as of #5 hard-swap)
 *
 * When `--bundle` is passed, build.ts emits per-platform tarballs with the tree:
 *   bin/tp                 ← Rust CLI binary (cargo build --release for each target)
 *   libexec/tp/tpd         ← Bun SEA (bun build --compile apps/cli/src/index.ts)
 *   libexec/tp/tp-daemon   ← Rust daemon binary (cargo build --release --bin tp-daemon;
 *                            ADR-0003 Phase 4 A1 — shipped + locatable, NOT the default)
 *   libexec/tp/tp-relay    ← Rust relay binary (cargo build --release --bin tp-relay;
 *                            task #17 #25 — `tp relay start` execs it; locate_tp_relay())
 *   libexec/tp/tp-runner   ← Rust runner binary (cargo build --release --bin tp-runner;
 *                            task #8 flip-prep — shipped + locatable, NOT the default)
 *
 * These tarballs are the release assets consumed by Homebrew and install.sh.
 * The live release pipeline (release.yml) uses `--bundle` for every target.
 * CI (`build-cli` job) also uses `--bundle --target bun-linux-x64`.
 *
 * Each target builds on its native runner in CI:
 *   darwin-arm64  → macos-latest (arm64)
 *   linux-x64     → ubuntu-latest (x86_64)
 *   linux-arm64   → ubuntu-24.04-arm (native ARM)
 * `rustup target add <rust-target>` is run in CI before the build.
 *
 * The bare-local Bun `dist/tp` path (no --bundle) is preserved as the
 * `locate_bun_blob()` dev fallback (ADR-0003 tranche 4d) so local dev without
 * a full tarball install keeps working. The `--all` / `--target` bare paths
 * are kept for compatibility but are no longer used by release.yml.
 */

import { $ } from "bun";
import { mkdirSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

const BINARIES = [{ entry: "apps/cli/src/index.ts", name: "tp" }];

const OUT_DIR = "dist";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

type Target = (typeof TARGETS)[number];

function outFile(name: string, target: Target): string {
  const suffix = target.replace("bun-", "").replaceAll("-", "_");
  return `${OUT_DIR}/${name}-${suffix}`;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    target: { type: "string" },
    bundle: { type: "boolean", default: false },
  },
});

mkdirSync(OUT_DIR, { recursive: true });

// Shared build flags across all modes:
//   --minify  — drops ~2 MB off the compiled SEA via tree-shaking + renaming.
//
// Flags considered but deliberately left off:
//   --sourcemap=none  Already the default for --compile.
//   --bytecode        +9 MB for ~20 ms faster warm start. Download size matters
//                     more than 20 ms. Revisit if cold-start becomes the
//                     dominant bottleneck (e.g. for `tp status` polling).
const COMMON_FLAGS = ["--compile", "--minify"] as const;

// ─── Tarball bundle assembly (--bundle flag) ──────────────────────────────────
// This is THE release/CI path as of #5 hard-swap (ADR-0003 Amendment 2).
// Each target builds on its native runner; no cross-linker is needed.
//
// Rust cross-compilation targets (matching bun target names):
const RUST_TARGETS: Record<string, string> = {
  "bun-darwin-arm64": "aarch64-apple-darwin",
  "bun-darwin-x64": "x86_64-apple-darwin",
  "bun-linux-x64": "x86_64-unknown-linux-gnu",
  "bun-linux-arm64": "aarch64-unknown-linux-gnu",
};

async function buildBundle(target: Target): Promise<void> {
  const rustTarget = RUST_TARGETS[target];
  if (!rustTarget) {
    console.error(`No Rust cross-compile target known for ${target}`);
    process.exit(1);
  }

  const suffix = target.replace("bun-", "").replaceAll("-", "_");
  const bundleDir = join(OUT_DIR, "bundles", `tp-${suffix}`);
  const binDir = join(bundleDir, "bin");
  const libexecDir = join(bundleDir, "libexec", "tp");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libexecDir, { recursive: true });

  // 1. Build Bun SEA as tpd
  const tpdPath = join(libexecDir, "tpd");
  console.log(`  [bundle] Building Bun SEA → ${tpdPath}`);
  await $`bun build apps/cli/src/index.ts ${COMMON_FLAGS} --target=${target} --outfile ${tpdPath}`;

  // 2. Build Rust tp binary for this target
  const rustBinPath = join("rust", "target", rustTarget, "release", "tp");
  console.log(
    `  [bundle] Building Rust tp (${rustTarget}) → ${join(binDir, "tp")}`,
  );
  // Each target builds on its native runner in CI (no cross-linker):
  //   darwin-arm64  → macos-latest (arm64):      rustup target add aarch64-apple-darwin
  //   linux-x64     → ubuntu-latest (x86_64):    rustup target add x86_64-unknown-linux-gnu
  //   linux-arm64   → ubuntu-24.04-arm (native): rustup target add aarch64-unknown-linux-gnu
  // rustup target add <rustTarget> is run in CI before this step.
  await $`cargo build --release --manifest-path rust/Cargo.toml --bin tp --target ${rustTarget}`;

  // Copy to bundle
  await $`cp ${rustBinPath} ${join(binDir, "tp")}`;
  await $`chmod +x ${join(binDir, "tp")} ${tpdPath}`;

  // 2b. Build Rust tp-daemon binary for this target (ADR-0003 Phase 4 A1: ship
  //     the daemon as a locatable release artifact — precondition for the
  //     daemon default-flip, changes NO default behavior). It is an internal
  //     exec target like tpd (not a user-facing command), so it lands in
  //     libexec/tp alongside tpd; `locate_tp_daemon()` resolves it there. Same
  //     --manifest-path/--target flags as the tp build above → output at
  //     rust/target/${rustTarget}/release/tp-daemon; each target builds on its
  //     native runner in CI (no cross-linker).
  const daemonBinPath = join(
    "rust",
    "target",
    rustTarget,
    "release",
    "tp-daemon",
  );
  const tpDaemonDest = join(libexecDir, "tp-daemon");
  console.log(
    `  [bundle] Building Rust tp-daemon (${rustTarget}) → ${tpDaemonDest}`,
  );
  await $`cargo build --release --manifest-path rust/Cargo.toml --bin tp-daemon --target ${rustTarget}`;
  await $`cp ${daemonBinPath} ${tpDaemonDest}`;
  await $`chmod +x ${tpDaemonDest}`;

  // 2c. Build Rust tp-relay binary for this target (task #17 #25: ship the relay
  //     as a locatable release artifact so a locally-run `tp relay start` execs
  //     the native binary instead of the Bun blob). Like tp-daemon it is an
  //     internal exec target (not clap-parsed), so it lands in libexec/tp
  //     alongside tpd/tp-daemon; `locate_tp_relay()` resolves it there. This is
  //     orthogonal to deploy-relay.yml, which ships tp-relay straight to the
  //     production host via a separate pipeline. Same --manifest-path/--target
  //     flags → rust/target/${rustTarget}/release/tp-relay; each target builds on
  //     its native runner in CI (no cross-linker).
  const relayBinPath = join(
    "rust",
    "target",
    rustTarget,
    "release",
    "tp-relay",
  );
  const tpRelayDest = join(libexecDir, "tp-relay");
  console.log(
    `  [bundle] Building Rust tp-relay (${rustTarget}) → ${tpRelayDest}`,
  );
  await $`cargo build --release --manifest-path rust/Cargo.toml --bin tp-relay --target ${rustTarget}`;
  await $`cp ${relayBinPath} ${tpRelayDest}`;
  await $`chmod +x ${tpRelayDest}`;

  // 2d. Build Rust tp-runner binary for this target (task #8 flip-prep: ship the
  //     per-session runtime as a locatable release artifact — precondition for
  //     the runner default-flip, changes NO default behavior). Like tp-daemon it
  //     is an internal exec target (the daemon spawns it per session; not a
  //     clap-parsed command), so it lands in libexec/tp alongside
  //     tpd/tp-daemon/tp-relay; `locate_tp_runner()` resolves it there. Same
  //     --manifest-path/--target flags → rust/target/${rustTarget}/release/tp-runner;
  //     each target builds on its native runner in CI (no cross-linker).
  const runnerBinPath = join(
    "rust",
    "target",
    rustTarget,
    "release",
    "tp-runner",
  );
  const tpRunnerDest = join(libexecDir, "tp-runner");
  console.log(
    `  [bundle] Building Rust tp-runner (${rustTarget}) → ${tpRunnerDest}`,
  );
  await $`cargo build --release --manifest-path rust/Cargo.toml --bin tp-runner --target ${rustTarget}`;
  await $`cp ${runnerBinPath} ${tpRunnerDest}`;
  await $`chmod +x ${tpRunnerDest}`;

  // 3. Pack into tarball
  const tarball = join(OUT_DIR, "bundles", `tp-${suffix}.tar.gz`);
  console.log(`  [bundle] Packing → ${tarball}`);
  await $`tar -czf ${tarball} -C ${join(OUT_DIR, "bundles")} tp-${suffix}`;

  console.log(`  [bundle] Done: ${tarball}`);
  console.log(
    `          Tree: bin/tp + libexec/tp/{tpd,tp-daemon,tp-relay,tp-runner} in tp-${suffix}.tar.gz`,
  );
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

if (values.bundle) {
  // --bundle: build Rust+Bun tarball for all platforms or a specific target.
  // This is the release/CI path as of #5 hard-swap.
  const bundleTargets = values.target
    ? ([values.target as Target] as Target[])
    : [...TARGETS];
  console.log(
    `Building tarball bundles for: ${bundleTargets.join(", ")} (--bundle)\n`,
  );
  mkdirSync(join(OUT_DIR, "bundles"), { recursive: true });
  for (const t of bundleTargets) {
    await buildBundle(t);
  }
  console.log("\nDone. Tarballs in dist/bundles/");
} else if (values.all) {
  console.log("Building for all platforms...\n");
  for (const target of TARGETS) {
    for (const bin of BINARIES) {
      const out = outFile(bin.name, target);
      console.log(`  ${bin.name} ${target} → ${out}`);
      await $`bun build ${bin.entry} ${COMMON_FLAGS} --target=${target} --outfile ${out}`;
    }
  }
  console.log("\nDone. Binaries in dist/");
} else if (values.target) {
  const target = values.target as Target;
  if (!TARGETS.includes(target)) {
    console.error(`Unknown target: ${target}`);
    console.error(`Available: ${TARGETS.join(", ")}`);
    process.exit(1);
  }
  for (const bin of BINARIES) {
    const out = outFile(bin.name, target);
    console.log(`Building ${bin.name} ${target} → ${out}`);
    await $`bun build ${bin.entry} ${COMMON_FLAGS} --target=${target} --outfile ${out}`;
  }
} else {
  // Local build for current platform (dist/tp — also the locate_bun_blob dev fallback)
  for (const bin of BINARIES) {
    const out = `${OUT_DIR}/${bin.name}`;
    console.log(`Building for current platform → ${out}`);
    await $`bun build ${bin.entry} ${COMMON_FLAGS} --outfile ${out}`;
  }
  console.log("Done.");
}
