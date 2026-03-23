import { readFileSync } from "fs";
import { resolve } from "path";

export function versionCommand(): void {
  try {
    const pkgPath = resolve(import.meta.dir, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    console.log(`tp v${pkg.version}`);
  } catch {
    console.log("tp v0.1.5");
  }
}
