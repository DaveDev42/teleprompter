/**
 * APNs token-based authentication — ES256 JWT signer.
 *
 * Apple requires a fresh ES256 JWT signed with the .p8 private key for each
 * APNs HTTP/2 request. Tokens are valid for up to 60 minutes; we cache the
 * signed token for ~50 minutes and re-sign when it approaches expiry. This
 * avoids the overhead of signing on every push while staying well within the
 * 60-minute Apple limit.
 *
 * References:
 *  - https://developer.apple.com/documentation/usernotifications/establishing_a_token-based_connection_to_apns
 *  - https://datatracker.ietf.org/doc/html/rfc7519 (JWT)
 *  - https://datatracker.ietf.org/doc/html/rfc7518#section-3.4 (ES256)
 *
 * Design:
 *  - No external JWT library — Bun/Node crypto handles ECDH and signing.
 *  - Pure: `ApnsJwtSigner` is a value class; its `getToken()` method has a
 *    synchronous-looking interface but returns a Promise so the key-import step
 *    is done once on first call and cached.
 *  - Fully unit-testable: you can generate a throwaway P-256 key pair in the
 *    test, pass the PEM to the signer, call `getToken()`, decode the JWT, and
 *    assert the header/claims shape — no network required.
 */

import { createSign } from "crypto";

/** How long an APNs JWT token is valid (Apple limit: 60 min). */
const _TOKEN_VALID_MS = 60 * 60 * 1000;
/** How long before expiry we proactively re-sign (50 min). */
const TOKEN_REFRESH_AFTER_MS = 50 * 60 * 1000;

function base64url(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64url");
}

function base64urlJson(obj: unknown): string {
  return base64url(Buffer.from(JSON.stringify(obj)));
}

export interface ApnsJwtOptions {
  /** ES256 private key: path to .p8 file OR PEM string (-----BEGIN EC PRIVATE KEY-----). */
  keyPemOrPath: string;
  /** 10-character key ID from Apple Developer portal. */
  keyId: string;
  /** 10-character team ID from Apple Developer portal. */
  teamId: string;
}

export class ApnsJwtSigner {
  private readonly opts: ApnsJwtOptions;
  private cachedToken: string | null = null;
  private cachedAt = 0;
  /** Resolved PEM (after reading file if a path was provided). */
  private resolvedPem: string | null = null;

  constructor(opts: ApnsJwtOptions) {
    this.opts = opts;
  }

  /**
   * Return a cached or freshly-signed APNs JWT.
   * The token is valid for ~50 minutes from this call.
   */
  async getToken(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedToken !== null &&
      now >= this.cachedAt &&
      now - this.cachedAt < TOKEN_REFRESH_AFTER_MS
    ) {
      return this.cachedToken;
    }

    const pem = await this.resolvePem();
    const iat = Math.floor(now / 1000);

    const header = base64urlJson({ alg: "ES256", kid: this.opts.keyId });
    const claims = base64urlJson({ iss: this.opts.teamId, iat });
    const signingInput = `${header}.${claims}`;

    // Node/Bun `createSign("SHA256")` with an EC private key produces a
    // DER-encoded ECDSA signature. APNs requires the raw IEEE P1363 format
    // (r || s, each 32 bytes). We convert DER → P1363 here.
    const sign = createSign("SHA256");
    sign.update(signingInput);
    const derSignature = sign.sign(pem);
    const p1363 = derToP1363(derSignature);

    const token = `${signingInput}.${base64url(p1363)}`;
    this.cachedToken = token;
    this.cachedAt = now;
    return token;
  }

  /** Invalidate the cache (useful for tests that want to force a re-sign). */
  invalidate(): void {
    this.cachedToken = null;
    this.cachedAt = 0;
  }

  /** How old the cached token is in ms (0 if not cached). For tests. */
  cachedAgeMs(): number {
    return this.cachedToken !== null ? Date.now() - this.cachedAt : 0;
  }

  private async resolvePem(): Promise<string> {
    if (this.resolvedPem !== null) return this.resolvedPem;

    const raw = this.opts.keyPemOrPath.trim();
    // If it looks like a PEM block, use it directly.
    // Otherwise treat as a file path (absolute or relative).
    if (raw.startsWith("-----")) {
      // Inline PEM — use verbatim
      this.resolvedPem = raw;
    } else {
      // File path — Bun.file or Node fs
      if (typeof Bun !== "undefined") {
        this.resolvedPem = await Bun.file(raw).text();
      } else {
        const { readFile } = await import("fs/promises");
        this.resolvedPem = await readFile(raw, "utf-8");
      }
    }
    return this.resolvedPem;
  }
}

/**
 * Convert a DER-encoded ECDSA signature to P1363 (raw r || s) format.
 *
 * DER SEQUENCE: 0x30 <len> 0x02 <r-len> <r> 0x02 <s-len> <s>
 * P1363 for P-256 (ES256): r padded to 32 bytes || s padded to 32 bytes = 64 bytes.
 *
 * APNs (and the JWT ES256 spec, RFC 7518 §3.4) requires the P1363 format.
 * Node's `createSign` emits DER, so we must convert.
 */
export function derToP1363(der: Buffer): Buffer {
  let offset = 0;

  if (der[offset] !== 0x30) throw new Error("DER: expected SEQUENCE");
  offset++;

  // DER length (may be 1- or 2-byte long-form)
  const lenByte = der[offset];
  if (lenByte === undefined) throw new Error("DER: truncated at length byte");
  if (lenByte >= 0x80) {
    const lenBytes = lenByte - 0x80;
    offset += 1 + lenBytes;
  } else {
    offset++;
  }

  // First INTEGER (r)
  if (der[offset] !== 0x02) throw new Error("DER: expected INTEGER for r");
  offset++;
  const rLen = der[offset];
  if (rLen === undefined) throw new Error("DER: truncated at r length");
  offset++;
  let r = der.slice(offset, offset + rLen);
  offset += rLen;

  // Second INTEGER (s)
  if (der[offset] !== 0x02) throw new Error("DER: expected INTEGER for s");
  offset++;
  const sLen = der[offset];
  if (sLen === undefined) throw new Error("DER: truncated at s length");
  offset++;
  let s = der.slice(offset, offset + sLen);

  // DER integers may be prefixed with a 0x00 byte to avoid sign ambiguity.
  // Strip it and left-pad both to 32 bytes.
  if (r[0] === 0x00) r = r.slice(1);
  if (s[0] === 0x00) s = s.slice(1);

  if (r.length > 32) throw new Error("DER: r component too large for P-256");
  if (s.length > 32) throw new Error("DER: s component too large for P-256");

  const p1363 = Buffer.alloc(64);
  r.copy(p1363, 32 - r.length);
  s.copy(p1363, 64 - s.length);
  return p1363;
}
