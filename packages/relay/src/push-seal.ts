import {
  derivePushSealKey,
  ensureSodium,
  openWithAad,
  sealWithAad,
} from "@teleprompter/protocol";

/**
 * Sealed push-token blob format:
 *   "tpps1." + <version:decimal> + "." + base64(nonce24 || aead_ciphertext)
 *
 * "tpps1." = format magic + format-version (1).
 * <version> = integer key version (from TP_RELAY_PUSH_SEAL_VERSION, default 1).
 * AAD = UTF-8 bytes of the prefix string "tpps1." + <version>, binding both
 *   the format-version and key-version into the AEAD tag.
 *
 * A blob NOT starting with "tpps1." is a legacy plaintext token (back-compat
 * path: the relay uses the blob verbatim as the Expo push token).
 */

const BLOB_PREFIX = "tpps1.";
const SECRET_MIN_CHARS = 32;

export type UnsealResult =
  | { ok: true; token: string }
  | { ok: false; reason: "legacy" | "unseal_failed" | "parse_error" };

export interface PushSealerOptions {
  /** Override TP_RELAY_PUSH_SEAL_SECRET */
  secret?: string;
  /** Override TP_RELAY_PUSH_SEAL_SECRET_PREV */
  secretPrev?: string;
  /** Override TP_RELAY_PUSH_SEAL_VERSION (decimal integer, default 1) */
  version?: number;
}

/**
 * Relay-side push token sealer.
 *
 * Modelled on `ResumeTokenSigner`. Reads config from env or constructor
 * options. Keys are derived lazily (first use) and cached.
 *
 * `ephemeral` is true when no secret was configured — seals are still
 * self-consistent within a process lifetime but stop working after a restart.
 */
export class PushSealer {
  private readonly currentSecret: string;
  private readonly prevSecret: string | null;
  readonly version: number;
  readonly ephemeral: boolean;

  /** Cached derived keys: version number → Uint8Array key */
  private readonly keyCache = new Map<number, Uint8Array>();

  constructor(options?: PushSealerOptions) {
    const envSecret = process.env["TP_RELAY_PUSH_SEAL_SECRET"] ?? "";
    const envPrev = process.env["TP_RELAY_PUSH_SEAL_SECRET_PREV"] ?? "";
    const envVersion = process.env["TP_RELAY_PUSH_SEAL_VERSION"];

    const provided = options?.secret ?? envSecret;
    if (provided && provided.length >= SECRET_MIN_CHARS) {
      this.currentSecret = provided;
      this.ephemeral = false;
    } else {
      // Ephemeral: generate a random 32-char hex secret at startup.
      this.currentSecret = [...Array(32)]
        .map(() => Math.floor(Math.random() * 16).toString(16))
        .join("");
      this.ephemeral = true;
    }

    const prevProvided = options?.secretPrev ?? (envPrev || null);
    this.prevSecret =
      prevProvided && prevProvided.length >= SECRET_MIN_CHARS
        ? prevProvided
        : null;

    // Version must be a positive integer. Both config paths (options + env)
    // apply the same `> 0` guard so version=0 can never select currentSecret
    // and silently collide with the legacy/parse_error sentinels.
    if (options?.version !== undefined && options.version > 0) {
      this.version = Math.floor(options.version);
    } else if (envVersion) {
      const v = parseInt(envVersion, 10);
      this.version = Number.isFinite(v) && v > 0 ? v : 1;
    } else {
      this.version = 1;
    }
  }

  private async deriveKey(secret: string): Promise<Uint8Array> {
    const provider = await ensureSodium();
    return derivePushSealKey(provider.fromString(secret));
  }

  private async getKey(version: number): Promise<Uint8Array | null> {
    if (this.keyCache.has(version)) {
      return this.keyCache.get(version)!;
    }
    // Current version → current secret
    if (version === this.version) {
      const key = await this.deriveKey(this.currentSecret);
      this.keyCache.set(version, key);
      return key;
    }
    // Previous version (version - 1) → prevSecret
    if (version === this.version - 1 && this.prevSecret) {
      const key = await this.deriveKey(this.prevSecret);
      this.keyCache.set(version, key);
      return key;
    }
    return null;
  }

  private blobPrefix(version: number): string {
    return `${BLOB_PREFIX}${version}`;
  }

  /**
   * Seal a plaintext Expo push token.
   * Returns a blob of the form "tpps1.<version>.<base64(nonce||ct)>".
   */
  async seal(token: string): Promise<string> {
    const provider = await ensureSodium();
    const key = await this.getKey(this.version);
    if (!key) throw new Error("PushSealer: could not derive current key");

    const prefix = this.blobPrefix(this.version);
    const aad = provider.fromString(prefix);
    const plaintext = provider.fromString(token);
    const b64 = await sealWithAad(plaintext, key, aad);
    return `${prefix}.${b64}`;
  }

  /**
   * Unseal a blob produced by `seal`.
   *
   * Returns `{ ok: true, token }` on success.
   * Returns `{ ok: false, reason: "legacy" }` for non-"tpps1." blobs.
   * Returns `{ ok: false, reason: "parse_error" }` for malformed "tpps1." blobs.
   * Returns `{ ok: false, reason: "unseal_failed" }` for AEAD failures (wrong
   *   key, tampered ciphertext, rotated-out version).
   */
  async unseal(blob: string): Promise<UnsealResult> {
    if (!blob.startsWith(BLOB_PREFIX)) {
      return { ok: false, reason: "legacy" };
    }

    // Parse "tpps1.<version>.<b64>"
    const afterMagic = blob.slice(BLOB_PREFIX.length); // "<version>.<b64>"
    const dotIdx = afterMagic.indexOf(".");
    if (dotIdx < 0) return { ok: false, reason: "parse_error" };

    const versionStr = afterMagic.slice(0, dotIdx);
    const b64 = afterMagic.slice(dotIdx + 1);

    const version = parseInt(versionStr, 10);
    if (!Number.isFinite(version) || String(version) !== versionStr) {
      return { ok: false, reason: "parse_error" };
    }

    const key = await this.getKey(version);
    if (!key) return { ok: false, reason: "unseal_failed" };

    try {
      const provider = await ensureSodium();
      const prefix = this.blobPrefix(version);
      const aad = provider.fromString(prefix);
      const plaintext = await openWithAad(b64, key, aad);
      const token = provider.toString(plaintext);
      return { ok: true, token };
    } catch {
      return { ok: false, reason: "unseal_failed" };
    }
  }
}
