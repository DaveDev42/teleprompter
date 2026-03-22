import { create } from "zustand";
import {
  decodePairingData,
  parsePairingForFrontend,
  generateKeyPair,
  deriveRelayToken,
  type KeyPair,
  type PairingData,
} from "@teleprompter/protocol";

export type PairingState = "unpaired" | "pairing" | "paired";

export interface PairingInfo {
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  daemonPublicKey: Uint8Array;
  frontendKeyPair: KeyPair;
}

export interface PairingStore {
  state: PairingState;
  info: PairingInfo | null;
  error: string | null;

  /** Process a scanned QR code string */
  processScan: (qrData: string) => Promise<void>;
  /** Reset pairing */
  reset: () => void;
}

export const usePairingStore = create<PairingStore>((set) => ({
  state: "unpaired",
  info: null,
  error: null,

  processScan: async (qrData: string) => {
    set({ state: "pairing", error: null });
    try {
      const data = decodePairingData(qrData);
      const parsed = await parsePairingForFrontend(data);
      const frontendKeyPair = await generateKeyPair();

      const info: PairingInfo = {
        daemonId: parsed.daemonId,
        relayUrl: parsed.relayUrl,
        relayToken: parsed.relayToken,
        daemonPublicKey: parsed.daemonPublicKey,
        frontendKeyPair,
      };

      set({ state: "paired", info, error: null });
    } catch (err) {
      set({
        state: "unpaired",
        error: err instanceof Error ? err.message : "Failed to process QR code",
      });
    }
  },

  reset: () => set({ state: "unpaired", info: null, error: null }),
}));
