import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-level connection resume tokens.
 *
 * The relay issues a token on every successful relay.auth (full path). On
 * reconnect the client sends relay.auth.resume {token}. The relay verifies
 * the HMAC signature without consulting any per-daemon state — tokens are
 * self-contained, so the relay stays stateless and resume survives a relay
 * restart as long as the secret persists.
 *
 * Token wire format: `b64url(payload).b64url(hmac)` where payload is
 * `<role>.<daemonId>.<frontendId|"">.<expiresAtMs>`.
 *
 * The secret is loaded from TP_RELAY_RESUME_SECRET; if unset, a random
 * secret is generated at startup. Generated secrets do not survive a
 * restart — clients fall back to full auth — which is fine for development
 * but production should set the env var so resume keeps working across
 * deploys.
 */

export interface ResumeTokenPayload {
  role: "daemon" | "frontend";
  daemonId: string;
  frontendId?: string;
  /** Epoch milliseconds */
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour
const SECRET_MIN_BYTES = 32;

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function payloadString(p: ResumeTokenPayload): string {
  return [p.role, p.daemonId, p.frontendId ?? "", p.expiresAt].join(".");
}

export class ResumeTokenSigner {
  private readonly secret: Buffer;
  readonly ttlMs: number;
  /** True when the secret was randomly generated (not from env). */
  readonly ephemeral: boolean;

  constructor(options?: { secret?: string; ttlMs?: number }) {
    const envSecret = process.env.TP_RELAY_RESUME_SECRET ?? "";
    const provided = options?.secret ?? envSecret;
    if (provided && provided.length >= SECRET_MIN_BYTES) {
      this.secret = Buffer.from(provided, "utf8");
      this.ephemeral = false;
    } else {
      this.secret = randomBytes(SECRET_MIN_BYTES);
      this.ephemeral = true;
    }
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Issue a token. expiresAt defaults to now+ttlMs. */
  issue(
    payload: Omit<ResumeTokenPayload, "expiresAt"> & { expiresAt?: number },
  ): { token: string; expiresAt: number } {
    const expiresAt = payload.expiresAt ?? Date.now() + this.ttlMs;
    const full: ResumeTokenPayload = {
      role: payload.role,
      daemonId: payload.daemonId,
      frontendId: payload.frontendId,
      expiresAt,
    };
    const body = payloadString(full);
    const sig = createHmac("sha256", this.secret).update(body).digest();
    const token = `${b64url(Buffer.from(body, "utf8"))}.${b64url(sig)}`;
    return { token, expiresAt };
  }

  /**
   * Verify a token. Returns the payload on success, null on failure
   * (bad shape, bad signature, expired). Constant-time signature compare.
   */
  verify(token: string, now: number = Date.now()): ResumeTokenPayload | null {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) return null;
    const bodyB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    let body: Buffer;
    let sig: Buffer;
    try {
      body = b64urlDecode(bodyB64);
      sig = b64urlDecode(sigB64);
    } catch {
      return null;
    }
    const expected = createHmac("sha256", this.secret).update(body).digest();
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(sig, expected)) return null;

    const parts = body.toString("utf8").split(".");
    if (parts.length !== 4) return null;
    const [role, daemonId, frontendId, expiresAtStr] = parts;
    if (role !== "daemon" && role !== "frontend") return null;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt)) return null;
    if (expiresAt <= now) return null;
    if (!daemonId) return null;

    return {
      role,
      daemonId,
      frontendId: frontendId === "" ? undefined : frontendId,
      expiresAt,
    };
  }
}
