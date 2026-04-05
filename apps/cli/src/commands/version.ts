import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * tp version — print tp version.
 *
 * With --claude flag, also prints claude version.
 */
export async function versionCommand(argv: string[] = []): Promise<void> {
  try {
    const pkgPath = resolve(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    console.log(`tp v${pkg.version}`);
  } catch {
    console.log("tp v0.1.5");
  }

  if (argv.includes("--claude")) {
    const proc = Bun.spawn(["claude", "--version"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
}
