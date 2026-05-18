/**
 * UTF-8 safe base64 encode. `btoa()` throws InvalidCharacterError on any
 * code point outside Latin-1 (0–255), so any user input containing Korean,
 * emoji, or other multi-byte UTF-8 cannot be passed directly. The terminal
 * input path hit this and unmounted ghostty-web mid-session.
 *
 * Chunked `String.fromCharCode` over the UTF-8 byte buffer keeps the
 * argument count below the engine's spread limit on large pastes.
 */
export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}
