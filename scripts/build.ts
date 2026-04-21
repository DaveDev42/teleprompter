/**
 * Multi-platform build script for the `tp` CLI binary.
 *
 * Usage:
 *   bun run scripts/build.ts              # Build for current platform
 *   bun run scripts/build.ts --all        # Build for all platforms
 *   bun run scripts/build.ts --target X   # Build for specific target
 *
 * Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64
 */

import { $ } from "bun";
import { mkdirSync } from "fs";
import { parseArgs } from "util";

const BINARIES = [{ entry: "apps/cli/src/index.ts", name: "tp" }];

const OUT_DIR = "dist";

const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
] as const;

type Target = (typeof TARGETS)[number];

function outFile(name: string, target: Target): string {
  const suffix = target.replace("bun-", "").replaceAll("-", "_");
  const ext = target.includes("windows") ? ".exe" : "";
  return `${OUT_DIR}/${name}-${suffix}${ext}`;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    target: { type: "string" },
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

if (values.all) {
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
  // Local build for current platform
  for (const bin of BINARIES) {
    const out = `${OUT_DIR}/${bin.name}`;
    console.log(`Building for current platform → ${out}`);
    await $`bun build ${bin.entry} ${COMMON_FLAGS} --outfile ${out}`;
  }
  console.log("Done.");
}
