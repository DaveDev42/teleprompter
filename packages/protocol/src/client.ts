/**
 * Client-safe exports for React Native / Expo environments.
 * No Node.js-specific imports (fs, path, net).
 */

export * from "./types";
export {
  ensureSodium,
  generateKeyPair,
  deriveSessionKeys,
  encrypt,
  decrypt,
  generatePairingSecret,
  deriveRelayToken,
  ratchetSessionKeys,
  toBase64,
  fromBase64,
  toHex,
} from "./crypto";
export type { KeyPair, SessionKeys } from "./crypto";
export {
  createPairingBundle,
  encodePairingData,
  decodePairingData,
  parsePairingForFrontend,
} from "./pairing";
export type { PairingData, PairingBundle } from "./pairing";
export { createLogger, setLogLevel } from "./logger";
export type { LogLevel } from "./logger";
export {
  MIN_CLAUDE_VERSION,
  PROTOCOL_VERSION,
  parseVersion,
  checkClaudeVersion,
} from "./compat";
