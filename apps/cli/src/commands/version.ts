import pkg from "../../../../package.json" with { type: "json" };

/**
 * tp version — print tp version.
 *
 * With --claude flag, also prints claude version.
 *
 * The version is read from the root package.json via a static JSON import so
 * Bun's `--compile` bundler inlines the value at build time. Runtime
 * filesystem reads fail inside the compiled binary because the original
 * package.json is not shipped alongside it.
 */
export async function versionCommand(argv: string[] = []): Promise<void> {
  console.log(`tp v${pkg.version}`);

  if (argv.includes("--claude")) {
    const proc = Bun.spawn(["claude", "--version"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}
