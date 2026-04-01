/**
 * Multi-platform build script for the `tp` CLI binary.
 *
 * Usage:
 *   bun run scripts/build.ts              # Build for current platform
 *   bun run scripts/build.ts --all        # Build for all platforms
 *   bun run scripts/build.ts --target X   # Build for specific target
 *
 * Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64
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
] as const;

type Target = (typeof TARGETS)[number];

function outFile(name: string, target: Target): string {
  const suffix = target.replace("bun-", "").replace("-", "_");
  return `${OUT_DIR}/${name}-${suffix}`;
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    target: { type: "string" },
  },
});

mkdirSync(OUT_DIR, { recursive: true });

if (values.all) {
  console.log("Building for all platforms...\n");
  for (const target of TARGETS) {
    for (const bin of BINARIES) {
      const out = outFile(bin.name, target);
      console.log(`  ${bin.name} ${target} → ${out}`);
      await $`bun build ${bin.entry} --compile --target=${target} --outfile ${out}`;
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
    await $`bun build ${bin.entry} --compile --target=${target} --outfile ${out}`;
  }
} else {
  // Local build for current platform
  for (const bin of BINARIES) {
    const out = `${OUT_DIR}/${bin.name}`;
    console.log(`Building for current platform → ${out}`);
    await $`bun build ${bin.entry} --compile --outfile ${out}`;
  }
  console.log("Done.");
}
