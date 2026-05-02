import pkg from "../../../../package.json" with { type: "json" };
import { dim } from "../lib/colors";

/**
 * tp version — print tp version, then claude's version below it.
 *
 * The version is read from the root package.json via a static JSON import so
 * Bun's `--compile` bundler inlines the value at build time. Runtime
 * filesystem reads fail inside the compiled binary because the original
 * package.json is not shipped alongside it.
 *
 * argv is ignored — past versions accepted `--claude` to opt in to the claude
 * version line, but printing both is now the default.
 */
export async function versionCommand(_argv: string[] = []): Promise<void> {
  console.log(`tp v${pkg.version}`);

  const check = Bun.spawnSync(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.log(dim("claude: not found on PATH"));
    return;
  }

  const claudeVersion = new TextDecoder().decode(check.stdout).trim();
  console.log(`claude ${claudeVersion}`);
}
