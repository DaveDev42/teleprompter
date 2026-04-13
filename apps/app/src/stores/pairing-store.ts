import {
  type ControlUnpair,
  decodePairingData,
  fromBase64,
  generateKeyPair,
  type KeyPair,
  parsePairingForFrontend,
  toBase64,
} from "@teleprompter/protocol/client";
import * as Device from "expo-device";
import { create } from "zustand";
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
  /** Optional human-readable label for this pairing */
  label?: string | null;
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
  label?: string | null;
}

const STORAGE_KEY = "pairings_v3";
const PREVIOUS_STORAGE_KEY = "pairings_v2";

type UnpairSender = (daemonId: string) => Promise<void>;
let unpairSender: UnpairSender | null = null;

/** Register a sender used by `removePairing` to notify the daemon over relay. */
export function registerUnpairSender(fn: UnpairSender | null): void {
  unpairSender = fn;
}

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
  /** Most recent peer-initiated unpair (for UI toast). */
  lastPeerUnpair: {
    daemonId: string;
    reason: ControlUnpair["reason"];
    ts: number;
  } | null;

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
  /** Clear the last-peer-unpair notice (after UI has shown the toast). */
  clearLastPeerUnpair: () => void;
  /** Handle an inbound control.unpair from the daemon — removes local pairing and sets lastPeerUnpair. */
  handlePeerUnpair: (
    daemonId: string,
    reason: ControlUnpair["reason"],
  ) => Promise<void>;
  /** Rename a pairing locally and notify the daemon over relay. */
  renamePairing: (daemonId: string, newLabel: string) => Promise<void>;
  /** Handle an inbound control.rename from the daemon — receive-only, no echo. */
  handlePeerRename: (daemonId: string, label: string) => Promise<void>;
}

type RenameSender = (daemonId: string, label: string) => Promise<void>;
let renameSender: RenameSender | null = null;

/** Register a sender used by `renamePairing` to notify the daemon over relay. */
export function registerRenameSender(fn: RenameSender | null): void {
  renameSender = fn;
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
      label: info.label ?? null,
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
        label: e.label ?? null,
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
  lastPeerUnpair: null,

  load: async () => {
    try {
      let raw = await secureGet(STORAGE_KEY);
      if (!raw) {
        // One-time migration from v2 → v3 (adds nullable `label` field)
        // TODO: delete v2 migration after N releases
        try {
          const prev = await secureGet(PREVIOUS_STORAGE_KEY);
          if (prev) {
            const parsed = JSON.parse(prev) as SerializedPairingInfo[];
            const migrated = parsed.map((p) => ({ ...p, label: p.label ?? null }));
            raw = JSON.stringify(migrated);
            await secureSet(STORAGE_KEY, raw);
            await secureSet(PREVIOUS_STORAGE_KEY, "");
          }
        } catch (err) {
          console.warn(
            "[pairing] v2 migration failed; previous pairings discarded",
            err,
          );
          // Malformed v2 data — start fresh
        }
      }
      if (raw) {
        const pairings = await deserializePairings(raw);
        const firstId =
          pairings.size > 0 ? (pairings.keys().next().value ?? null) : null;
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

      // Seed label from QR bundle, falling back to device name.
      const seedLabel = data.label ?? Device.deviceName ?? "Daemon";

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
        label: seedLabel,
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
    if (unpairSender) {
      try {
        await unpairSender(daemonId);
      } catch (err) {
        console.warn("[pairing] unpair notice failed:", err);
      }
    }

    const pairings = new Map(get().pairings);
    pairings.delete(daemonId);

    await secureSet(STORAGE_KEY, await serializePairings(pairings));

    const newActive =
      pairings.size > 0 ? (pairings.keys().next().value ?? null) : null;

    set({
      pairings,
      activeDaemonId:
        get().activeDaemonId === daemonId ? newActive : get().activeDaemonId,
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
      lastPeerUnpair: null,
    });
  },

  clearLastPeerUnpair: () => set({ lastPeerUnpair: null }),

  handlePeerUnpair: async (
    daemonId: string,
    reason: ControlUnpair["reason"],
  ) => {
    const pairings = new Map(get().pairings);
    pairings.delete(daemonId);

    await secureSet(STORAGE_KEY, await serializePairings(pairings));

    const newActive =
      pairings.size > 0 ? (pairings.keys().next().value ?? null) : null;

    set({
      pairings,
      activeDaemonId:
        get().activeDaemonId === daemonId ? newActive : get().activeDaemonId,
      state: pairings.size > 0 ? "paired" : "unpaired",
      lastPeerUnpair: { daemonId, reason, ts: Date.now() },
    });
  },

  renamePairing: async (daemonId: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    const pairings = new Map(get().pairings);
    const existing = pairings.get(daemonId);
    if (!existing) return;
    // Protocol: empty string clears the label — store as null locally.
    const localLabel = trimmed === "" ? null : trimmed;
    pairings.set(daemonId, { ...existing, label: localLabel });

    set({ pairings });
    await secureSet(STORAGE_KEY, await serializePairings(pairings));

    if (renameSender) {
      try {
        // Send trimmed value over the wire — preserves user intent and
        // empty string signals clear to peer.
        await renameSender(daemonId, trimmed);
      } catch (err) {
        console.warn("[pairing] failed to send rename notice", err);
      }
    }
  },

  handlePeerRename: async (daemonId: string, label: string) => {
    const pairings = new Map(get().pairings);
    const existing = pairings.get(daemonId);
    if (!existing) {
      console.warn("[pairing] handlePeerRename: unknown daemonId", daemonId);
      return;
    }
    // Protocol: empty string clears the label — store as null locally.
    const trimmed = label.trim();
    const localLabel = trimmed === "" ? null : trimmed;
    pairings.set(daemonId, { ...existing, label: localLabel });

    set({ pairings });
    await secureSet(STORAGE_KEY, await serializePairings(pairings));
  },
}));
