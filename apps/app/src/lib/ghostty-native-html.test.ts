import { describe, expect, test } from "bun:test";
import {
  buildGhosttyHtml,
  escapeHtml,
  escapeInlineScript,
} from "./ghostty-native-html";
import { TERMINAL_COLORS } from "./tokens";

describe("escapeHtml", () => {
  test("escapes quote, angle-bracket, ampersand, backslash", () => {
    expect(escapeHtml(`a"b'c<d>e&f\\g`)).toBe(
      "a&#34;b&#39;c&#60;d&#62;e&#38;f&#92;g",
    );
  });

  test("passes plain font names through", () => {
    expect(escapeHtml("JetBrains Mono")).toBe("JetBrains Mono");
  });
});

describe("escapeInlineScript", () => {
  test("neutralizes </script> regardless of case", () => {
    // The replacement is a fixed lowercase literal — what matters is that
    // no `</script` byte sequence survives, not case preservation.
    const out = escapeInlineScript(`x = "</script>"; y = "</SCRIPT>";`);
    expect(out).toBe(`x = "<\\/script>"; y = "<\\/script>";`);
    expect(out.toLowerCase()).not.toContain("</script");
  });

  test("leaves ordinary JS untouched", () => {
    const js = `const a = "<div>" + 1 < 2 + "/script";`;
    expect(escapeInlineScript(js)).toBe(js);
  });
});

describe("buildGhosttyHtml", () => {
  const html = buildGhosttyHtml("globalThis.GhosttyWeb = {};", "Test Font", 17);

  test("inlines the UMD source in a classic script tag", () => {
    expect(html).toContain("<script>globalThis.GhosttyWeb = {};</script>");
  });

  test("a UMD containing </script> cannot break out of the script tag", () => {
    const evil = buildGhosttyHtml(
      `const s = "</script><script>alert(1)//";`,
      "Test Font",
      15,
    );
    // The only </script> occurrences must be the builder's own closers.
    const body = evil.split("<script>").slice(1).join("<script>");
    expect(body).toContain("<\\/script>");
    expect(evil).not.toContain(`"</script>`);
  });

  test("escapes the font name", () => {
    const out = buildGhosttyHtml("x", `Evil"</style>`, 15);
    expect(out).not.toContain(`Evil"</style>`);
    expect(out).toContain("Evil&#34;&#60;/style&#62;");
  });

  test("interpolates fontSize and theme colors", () => {
    expect(html).toContain("fontSize: 17");
    expect(html).toContain(`background: '${TERMINAL_COLORS.background}'`);
    expect(html).toContain(`foreground: '${TERMINAL_COLORS.foreground}'`);
    expect(html).toContain(`cursor: '${TERMINAL_COLORS.cursor}'`);
  });

  test("contains the bridge protocol surface", () => {
    // RN → WebView arms
    expect(html).toContain("msg.type === 'write'");
    expect(html).toContain("msg.type === 'fit'");
    expect(html).toContain("b64ToBytes(msg.b64)");
    // WebView → RN arms
    expect(html).toContain("type: 'data'");
    expect(html).toContain("type: 'resize'");
    expect(html).toContain("type: 'ready'");
    expect(html).toContain("type: 'error'");
    // iOS delivers postMessage on document, not window.
    expect(html).toContain("document.addEventListener('message'");
  });

  test("initializes ghostty from the UMD global (no module imports)", () => {
    expect(html).toContain("globalThis.GhosttyWeb;");
    expect(html).toContain("await init();");
    expect(html).not.toContain("esm.sh");
    expect(html).not.toContain("import(");
  });
});
