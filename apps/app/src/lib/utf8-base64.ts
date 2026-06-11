/**
 * Base64 encode raw bytes. Chunked `String.fromCharCode` keeps the
 * argument count below the engine's spread limit on large buffers.
 * Used by the terminal write bridge (GhosttyNative) so binary PTY
 * output survives the JSON postMessage boundary intact.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * UTF-8 safe base64 encode. `btoa()` throws InvalidCharacterError on any
 * code point outside Latin-1 (0–255), so any user input containing Korean,
 * emoji, or other multi-byte UTF-8 cannot be passed directly. The terminal
 * input path hit this and unmounted ghostty-web mid-session.
 */
export function encodeUtf8Base64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
