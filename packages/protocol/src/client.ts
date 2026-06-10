/**
 * Client-safe exports for React Native / Expo environments.
 * No Node.js-specific imports (fs, path, net).
 */

export {
  checkClaudeVersion,
  MIN_CLAUDE_VERSION,
  PROTOCOL_VERSION,
  parseVersion,
  WS_PROTOCOL_VERSION,
} from "./compat";
export { parseControlMessage } from "./control-guard";
export type { KeyPair, SessionKeys } from "./crypto";
export {
  __setCryptoProviderFactory,
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
export type { CryptoProvider } from "./crypto-provider";
export type { LogLevel } from "./logger";
export { createLogger, setLogLevel } from "./logger";
export type { PairingBundle, PairingData } from "./pairing";
export {
  createPairingBundle,
  DEFAULT_PAIRING_RELAY_URL,
  decodePairingData,
  encodePairingData,
  parsePairingForFrontend,
} from "./pairing";
export { parseRelayServerMessage } from "./relay-server-guard";
export { parseSessionServerMessage } from "./session-server-guard";
export * from "./types";
