export { encodeFrame, FrameDecoder } from "./codec";
export {
  checkClaudeVersion,
  IPC_PROTOCOL_VERSION,
  MIN_CLAUDE_VERSION,
  PROTOCOL_VERSION,
  parseVersion,
  RELAY_PROTOCOL_VERSION,
  WS_PROTOCOL_VERSION,
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
export { QueuedWriter } from "./queued-writer";
export { getSocketPath, getWindowsSocketPath } from "./socket-path";
export * from "./types";
