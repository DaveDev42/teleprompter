/**
 * Client-safe exports for React Native / Expo environments.
 * No Node.js-specific imports (fs, path, net).
 */

export {
  checkClaudeVersion,
  MIN_CLAUDE_VERSION,
  PROTOCOL_VERSION,
  parseVersion,
} from "./compat";
export type { KeyPair, SessionKeys } from "./crypto";
export {
  decrypt,
  deriveKxKey,
  deriveRegistrationProof,
  deriveRelayToken,
  deriveSessionKeys,
  encrypt,
  ensureSodium,
  fromBase64,
  generateKeyPair,
  generatePairingSecret,
  ratchetSessionKeys,
  toBase64,
  toHex,
} from "./crypto";
export type { LogLevel } from "./logger";
export { createLogger, setLogLevel } from "./logger";
export type { PairingBundle, PairingData } from "./pairing";
export {
  createPairingBundle,
  decodePairingData,
  encodePairingData,
  parsePairingForFrontend,
} from "./pairing";
export * from "./types";
