import { describe, expect, test } from "bun:test";
import path from "node:path";

/**
 * Freshness + inline-safety oracle for the bundled ghostty-web UMD asset
 * (assets/ghostty-web.umd.txt) consumed by GhosttyNative's WebView.
 *
 * The asset is a verbatim copy of the installed package's UMD build. If a
 * ghostty-web upgrade lands without re-copying the asset, the native
 * terminal silently diverges from the web terminal again (the exact skew
 * Rung 1 of docs/native-terminal-plan.md eliminated) — this test turns
 * that into a hard failure: re-copy with
 * `cp node_modules/ghostty-web/dist/ghostty-web.umd.cjs apps/app/assets/ghostty-web.umd.txt`.
 */

const assetPath = path.join(
  import.meta.dir,
  "../../assets/ghostty-web.umd.txt",
);
const packageUmdPath = path.join(
  path.dirname(Bun.resolveSync("ghostty-web", import.meta.dir)),
  "ghostty-web.umd.cjs",
);

async function sha256(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).bytes();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

describe("ghostty-web.umd.txt asset", () => {
  test("is byte-identical to the installed ghostty-web UMD build", async () => {
    expect(await sha256(assetPath)).toBe(await sha256(packageUmdPath));
  });

  test("exposes the GhosttyWeb UMD global", async () => {
    const js = await Bun.file(assetPath).text();
    expect(js).toContain("GhosttyWeb");
  });

  test("embeds the WASM as a data URL (no network fetch needed)", async () => {
    const js = await Bun.file(assetPath).text();
    expect(js).toContain("data:application/wasm");
  });

  // buildGhosttyHtml inlines the UMD into a <script> element. The HTML
  // parser ends a script at the first `</script` and treats `<!--` as the
  // start of a script-content comment hide — escapeInlineScript handles
  // the former defensively, but the asset must not rely on it.
  test("is safe to inline in a classic script tag", async () => {
    const js = await Bun.file(assetPath).text();
    expect(js.toLowerCase()).not.toContain("</script");
    expect(js).not.toContain("<!--");
  });
});
