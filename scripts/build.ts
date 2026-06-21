/**
 * Multi-platform build script for the `tp` CLI binary.
 *
 * Usage:
 *   bun run scripts/build.ts              # Build Bun tp for current platform
 *   bun run scripts/build.ts --all        # Build for all platforms
 *   bun run scripts/build.ts --target X   # Build for specific target
 *   bun run scripts/build.ts --bundle     # (tranche 4d) Build bin/tp (Rust) +
 *                                         # libexec/tp/tpd (Bun SEA) + assemble
 *                                         # per-platform tarballs in dist/bundles/
 *
 * Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64
 *
 * # Packaging layout (tranche 4d — local build only, NOT yet the CI default)
 *
 * When `--bundle` is passed, build.ts emits per-platform tarballs with the tree:
 *   bin/tp              ← Rust CLI binary (cargo build --release for each target)
 *   libexec/tp/tpd      ← Bun SEA (bun build --compile apps/cli/src/index.ts)
 *
 * These tarballs are the target for the #5 release-path flip (cargo build in CI,
 * Homebrew formula update, install.sh tarball detection). Until #5, the live
 * release pipeline (release.yml) still uses the Bun single-binary path produced
 * by the unguarded `--all` / `--target` / bare-local builds below.
 *
 * The dev fallback for `locate_bun_blob()` (ADR-0003 tranche 4d) continues to
 * resolve `dist/tp` (the plain Bun build) so local dev (no --bundle) keeps
 * working without a tarball install.
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

// ─── Tarball bundle assembly (tranche 4d, --bundle flag) ─────────────────────
// This is LOCAL only — the CI release path stays Bun single-binary until #5.
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
  // NOTE: cross-compilation requires the target to be installed:
  //   rustup target add <rustTarget>
  // On Linux CI the x86_64 native build doesn't need a cross-linker.
  // darwin targets from macOS don't need cross-compilers either.
  await $`cargo build --release --manifest-path rust/Cargo.toml --bin tp --target ${rustTarget}`;

  // Copy to bundle
  await $`cp ${rustBinPath} ${join(binDir, "tp")}`;
  await $`chmod +x ${join(binDir, "tp")} ${tpdPath}`;

  // 3. Pack into tarball
  const tarball = join(OUT_DIR, "bundles", `tp-${suffix}.tar.gz`);
  console.log(`  [bundle] Packing → ${tarball}`);
  await $`tar -czf ${tarball} -C ${join(OUT_DIR, "bundles")} tp-${suffix}`;

  console.log(`  [bundle] Done: ${tarball}`);
  console.log(`          Tree: bin/tp + libexec/tp/tpd in tp-${suffix}.tar.gz`);
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

if (values.bundle) {
  // --bundle: build Rust+Bun tarball for all platforms or a specific target.
  // LOCAL ONLY — not the live release path until #5.
  const bundleTargets = values.target
    ? ([values.target as Target] as Target[])
    : [...TARGETS];
  console.log(
    `Building tarball bundles for: ${bundleTargets.join(", ")} (--bundle, local only)\n`,
  );
  mkdirSync(join(OUT_DIR, "bundles"), { recursive: true });
  for (const t of bundleTargets) {
    await buildBundle(t);
  }
  console.log(
    "\nDone. Tarballs in dist/bundles/\n" +
      "NOTE: --bundle is local-only; CI still uses Bun single-binary until #5.",
  );
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
