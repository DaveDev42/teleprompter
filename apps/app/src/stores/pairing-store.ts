import { create } from "zustand";
import {
  decodePairingData,
  parsePairingForFrontend,
  generateKeyPair,
  toBase64,
  fromBase64,
  type KeyPair,
} from "@teleprompter/protocol/client";
import { secureGet, secureSet } from "../lib/secure-storage";

export type PairingState = "unpaired" | "pairing" | "paired";

export interface PairingInfo {
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  registrationProof: string;
  daemonPublicKey: Uint8Array;
  frontendKeyPair: KeyPair;
  frontendId: string;
  pairingSecret: Uint8Array;
  pairedAt: number;
}

/** Serializable format for secure storage */
interface SerializedPairingInfo {
  daemonId: string;
  relayUrl: string;
  relayToken: string;
  registrationProof: string;
  daemonPublicKey: string; // base64
  frontendPublicKey: string; // base64
  frontendSecretKey: string; // base64
  frontendId: string;
  pairingSecret: string; // base64
  pairedAt: number;
}

const STORAGE_KEY = "pairings_v2";

function generateFrontendId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PairingStore {
  state: PairingState;
  /** Map of daemonId → PairingInfo */
  pairings: Map<string, PairingInfo>;
  /** Currently active daemon ID */
  activeDaemonId: string | null;
  error: string | null;
  loaded: boolean;

  /** Load pairings from secure storage */
  load: () => Promise<void>;
  /** Process a scanned QR code string (adds to pairings) */
  processScan: (qrData: string) => Promise<void>;
  /** Remove a pairing */
  removePairing: (daemonId: string) => Promise<void>;
  /** Set the active daemon */
  setActiveDaemon: (daemonId: string | null) => void;
  /** Reset all pairings */
  reset: () => Promise<void>;

  // Legacy compat getters
  /** @deprecated Use pairings map instead */
  info: PairingInfo | null;
}

async function serializePairings(
  pairings: Map<string, PairingInfo>,
): Promise<string> {
  const entries: SerializedPairingInfo[] = [];
  for (const info of pairings.values()) {
    entries.push({
      daemonId: info.daemonId,
      relayUrl: info.relayUrl,
      relayToken: info.relayToken,
      registrationProof: info.registrationProof,
      daemonPublicKey: await toBase64(info.daemonPublicKey),
      frontendPublicKey: await toBase64(info.frontendKeyPair.publicKey),
      frontendSecretKey: await toBase64(info.frontendKeyPair.secretKey),
      frontendId: info.frontendId,
      pairingSecret: await toBase64(info.pairingSecret),
      pairedAt: info.pairedAt,
    });
  }
  return JSON.stringify(entries);
}

async function deserializePairings(
  raw: string,
): Promise<Map<string, PairingInfo>> {
  const map = new Map<string, PairingInfo>();
  try {
    const entries: SerializedPairingInfo[] = JSON.parse(raw);
    for (const e of entries) {
      map.set(e.daemonId, {
        daemonId: e.daemonId,
        relayUrl: e.relayUrl,
        relayToken: e.relayToken,
        registrationProof: e.registrationProof,
        daemonPublicKey: await fromBase64(e.daemonPublicKey),
        frontendKeyPair: {
          publicKey: await fromBase64(e.frontendPublicKey),
          secretKey: await fromBase64(e.frontendSecretKey),
        },
        frontendId: e.frontendId,
        pairingSecret: await fromBase64(e.pairingSecret),
        pairedAt: e.pairedAt,
      });
    }
  } catch {
    // Corrupted data — start fresh
  }
  return map;
}

export const usePairingStore = create<PairingStore>((set, get) => ({
  state: "unpaired",
  pairings: new Map(),
  activeDaemonId: null,
  error: null,
  loaded: false,

  // Legacy compat
  get info() {
    const { activeDaemonId, pairings } = get();
    if (activeDaemonId) return pairings.get(activeDaemonId) ?? null;
    // Fallback: return first pairing
    const first = pairings.values().next();
    return first.done ? null : first.value;
  },

  load: async () => {
    try {
      const raw = await secureGet(STORAGE_KEY);
      if (raw) {
        const pairings = await deserializePairings(raw);
        const firstId = pairings.size > 0
          ? pairings.keys().next().value ?? null
          : null;
        set({
          pairings,
          activeDaemonId: firstId,
          state: pairings.size > 0 ? "paired" : "unpaired",
          loaded: true,
        });
        return;
      }
    } catch {
      // ignore
    }
    set({ loaded: true });
  },

  processScan: async (qrData: string) => {
    set({ state: "pairing", error: null });
    try {
      const data = decodePairingData(qrData);
      const parsed = await parsePairingForFrontend(data);
      const frontendKeyPair = await generateKeyPair();
      const frontendId = generateFrontendId();

      const info: PairingInfo = {
        daemonId: parsed.daemonId,
        relayUrl: parsed.relayUrl,
        relayToken: parsed.relayToken,
        registrationProof: parsed.registrationProof,
        daemonPublicKey: parsed.daemonPublicKey,
        frontendKeyPair,
        frontendId,
        pairingSecret: parsed.pairingSecret,
        pairedAt: Date.now(),
      };

      const pairings = new Map(get().pairings);
      pairings.set(info.daemonId, info);

      // Persist
      await secureSet(STORAGE_KEY, await serializePairings(pairings));

      set({
        state: "paired",
        pairings,
        activeDaemonId: info.daemonId,
        error: null,
      });
    } catch (err) {
      set({
        state: get().pairings.size > 0 ? "paired" : "unpaired",
        error: err instanceof Error ? err.message : "Failed to process QR code",
      });
    }
  },

  removePairing: async (daemonId: string) => {
    const pairings = new Map(get().pairings);
    pairings.delete(daemonId);

    await secureSet(STORAGE_KEY, await serializePairings(pairings));

    const newActive = pairings.size > 0
      ? pairings.keys().next().value ?? null
      : null;

    set({
      pairings,
      activeDaemonId: get().activeDaemonId === daemonId ? newActive : get().activeDaemonId,
      state: pairings.size > 0 ? "paired" : "unpaired",
    });
  },

  setActiveDaemon: (daemonId) => set({ activeDaemonId: daemonId }),

  reset: async () => {
    await secureSet(STORAGE_KEY, "");
    set({
      state: "unpaired",
      pairings: new Map(),
      activeDaemonId: null,
      error: null,
    });
  },
}));
