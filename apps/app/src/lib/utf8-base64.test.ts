import { describe, expect, test } from "bun:test";
import { encodeUtf8Base64 } from "./utf8-base64";

describe("encodeUtf8Base64", () => {
  test("ascii is identical to btoa", () => {
    expect(encodeUtf8Base64("hello world")).toBe(btoa("hello world"));
  });

  test("empty string", () => {
    expect(encodeUtf8Base64("")).toBe("");
  });

  // Without UTF-8 encoding, btoa() throws "String contains an invalid
  // character" on these inputs and unmounts the terminal mid-session.
  // See `apps/app/app/session/[sid].tsx` handleData — this helper exists
  // specifically because the raw btoa(data) regression hit there.
  test("Korean round-trips", () => {
    const b64 = encodeUtf8Base64("안녕하세요");
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("안녕하세요");
  });

  test("emoji round-trips", () => {
    const b64 = encodeUtf8Base64("hi 👋 there");
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe("hi 👋 there");
  });

  test("mixed ascii + multibyte + control chars", () => {
    const input = "echo '한글 + 🚀 + \x1b[A'";
    const b64 = encodeUtf8Base64(input);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(input);
  });

  test("large paste does not exceed engine arg limit (chunking)", () => {
    // 200KB of mixed UTF-8 bytes would blow the spread-to-fromCharCode
    // argument count without the CHUNK loop on some engines.
    const big = "한".repeat(50000);
    const b64 = encodeUtf8Base64(big);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(big);
  });
});
