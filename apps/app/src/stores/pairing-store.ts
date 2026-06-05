import {
  type ControlUnpair,
  decodePairingData,
  decodeWireLabel,
  fromBase64,
  generateKeyPair,
  type KeyPair,
  type Label,
  labelToNullable,
  makeLabel,
  parsePairingForFrontend,
  toBase64,
} from "@teleprompter/protocol/client";
import * as Device from "expo-device";
import { create } from "zustand";
import { clearResumeToken } from "../lib/relay-client";
import { secureGet, secureSet } from "../lib/secure-storage";

export type PairingState = "unpaired" | "pairing" | "paired";

/**
 * Origin of the current `label` value. Used by `handleDaemonHello` to skip
 * overwriting a label the user explicitly set in the app — otherwise an
 * unrelated daemon-side broadcast would silently clobber the rename.
 *
 * - `qr` : seeded from the device name at scan time (no real source yet)
 * - `daemon` : adopted from the daemon's relay.kx broadcast or peer rename
 * - `user` : the user renamed it locally via `renamePairing`
 */
export type LabelSource = "qr" | "daemon" | "user";

/**
 * Which daemon the UI is currently focused on. Modelled as a tagged union so
 * "no daemon selected" is a first-class state (`{ active: false }`) rather than
 * a `null` sentinel that consumers must remember to special-case. `daemonId`
 * only exists in the `active: true` arm, so it can never be read while unset.
 */
export type ActiveDaemon =
  | { active: true; daemonId: string }
  | { active: false };

/** The canonical "no active daemon" value. Reuse instead of re-allocating. */
const NO_ACTIVE_DAEMON: ActiveDaemon = { active: false };

/**
 * Derive the `ActiveDaemon` union from the pairing map: the first pairing if
 * any exist, otherwise `{ active: false }`. Mirrors the "first id or null"
 * sentinel logic that `load`/`removePairing`/`handlePeerUnpair` used to inline.
 */
function firstActiveDaemon(pairings: Map<string, PairingInfo>): ActiveDaemon {
  const first = pairings.keys().next().value;
  return first === undefined
    ? NO_ACTIVE_DAEMON
    : { active: true, daemonId: first };
}

/** True iff `daemon` is the active selection and points at `daemonId`. */
function isActiveDaemon(daemon: ActiveDaemon, daemonId: string): boolean {
  return daemon.active && daemon.daemonId === daemonId;
}

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
  /**
   * Human-readable label for this pairing, as a tagged union. `{ set: false }`
   * is "no label" (fall back to the daemon-id prefix in the UI); the legacy
   * `string | null` representation only survives on the SecureStorage wire
   * (`SerializedPairingInfo.label`), decoded via `decodeWireLabel` on load.
   */
  label: Label;
  /** Provenance of `label`. Defaults to `qr` for legacy stored entries. */
  labelSource?: LabelSource;
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
  labelSource?: LabelSource;
}

const STORAGE_KEY = "pairings_v3";

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
  /** Currently active daemon (tagged union — `{ active: false }` when none). */
  activeDaemon: ActiveDaemon;
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
  /** Clear the most recent processScan error (e.g. when the user edits input). */
  clearError: () => void;
  /** Remove a pairing */
  removePairing: (daemonId: string) => Promise<void>;
  /** Set the active daemon (pass `{ active: false }` to clear). */
  setActiveDaemon: (daemon: ActiveDaemon) => void;
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
  /**
   * Handle an inbound control.rename from the daemon — receive-only, no echo.
   * `label` is the `Label` tagged union: `{ set: false }` is an authoritative
   * clear, `{ set: true, value }` is the new label.
   */
  handlePeerRename: (daemonId: string, label: Label) => Promise<void>;
  /**
   * Handle the daemon's relay.kx hello — adopts the daemon's label.
   * `label` is always a concrete `{ set: true, value }` here: the relay client
   * decodes the keep-current kx/meta surfaces with `decodeKxLabelOrKeep` and
   * only fires this callback when the daemon advertises a real label.
   */
  handleDaemonHello: (daemonId: string, label: Label) => Promise<void>;
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
      // Collapse the union back to the legacy nullable-string wire shape so
      // pre-migration app versions can still read it.
      label: labelToNullable(info.label),
      labelSource: info.labelSource ?? "qr",
    });
  }
  return JSON.stringify(entries);
}

async function deserializePairings(
  raw: string,
): Promise<Map<string, PairingInfo>> {
  const map = new Map<string, PairingInfo>();
  let entries: SerializedPairingInfo[];
  try {
    entries = JSON.parse(raw);
  } catch {
    // Top-level JSON is malformed — start fresh.
    return map;
  }
  for (const e of entries) {
    try {
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
        // `decodeWireLabel` normalizes the legacy nullable-string (and a stray
        // `""`) into the `Label` union, so pre-migration stored entries load
        // cleanly as `{ set: false }` / `{ set: true, value }`.
        label: decodeWireLabel(e.label),
        // Defaults to `qr` for legacy entries persisted before `labelSource`
        // existed. Caveat: a user-renamed label from a pre-`labelSource` build
        // is indistinguishable from a daemon/QR label here, so the next
        // `handleDaemonHello` may overwrite it. The user can re-rename in the
        // app to re-tag as `user` and lock the label against further drift.
        labelSource: e.labelSource ?? "qr",
      });
    } catch {
      // One corrupted entry — skip it and continue loading the rest.
      console.warn("[pairing] skipping corrupted entry for", e.daemonId);
    }
  }
  return map;
}

export const usePairingStore = create<PairingStore>((set, get) => ({
  state: "unpaired",
  pairings: new Map(),
  activeDaemon: NO_ACTIVE_DAEMON,
  error: null,
  loaded: false,
  lastPeerUnpair: null,

  load: async () => {
    try {
      const raw = await secureGet(STORAGE_KEY);
      if (raw) {
        const pairings = await deserializePairings(raw);
        set({
          pairings,
          activeDaemon: firstActiveDaemon(pairings),
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

  clearError: () => {
    if (get().error !== null) set({ error: null });
  },

  processScan: async (qrData: string) => {
    set({ state: "pairing", error: null });
    try {
      const data = decodePairingData(qrData);
      const parsed = await parsePairingForFrontend(data);
      const frontendKeyPair = await generateKeyPair();
      const frontendId = generateFrontendId();

      // QR no longer carries a label — daemon broadcasts it via relay.kx.
      // Until that frame arrives we display the device name; handleDaemonHello
      // upgrades the label as soon as the relay session opens.
      const seedLabel = Device.deviceName ?? "Daemon";

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
        label: makeLabel(seedLabel),
        labelSource: "qr",
      };

      // Re-pairing with the same daemonId would otherwise re-use the prior
      // resume token; the relay would accept it and the daemon would skip
      // re-broadcasting its pubkey, so the freshly-generated frontendKeyPair
      // never completes ECDH and Sessions stays empty.
      await clearResumeToken(info.daemonId);

      // Re-read pairings via functional set() after all awaits — another
      // concurrent scan may have modified the map while clearResumeToken was
      // in flight, so we must not use a snapshot captured before the awaits.
      let mergedPairings: Map<string, PairingInfo> | undefined;
      set((s) => {
        const pairings = new Map(s.pairings);
        pairings.set(info.daemonId, info);
        mergedPairings = pairings;
        return {
          state: "paired",
          pairings,
          activeDaemon: { active: true, daemonId: info.daemonId },
          error: null,
        };
      });

      // Persist after the state update so the serialized map is consistent
      // with what is now in the store.
      await secureSet(
        STORAGE_KEY,
        await serializePairings(mergedPairings ?? get().pairings),
      );
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

    // Re-read pairings and activeDaemon via functional set() after all awaits
    // (unpairSender is async) — both values may have changed while we awaited,
    // so reading them from a pre-await snapshot would be a TOCTOU race.
    let finalPairings: Map<string, PairingInfo> | undefined;
    set((s) => {
      const pairings = new Map(s.pairings);
      pairings.delete(daemonId);
      finalPairings = pairings;
      return {
        pairings,
        // Only re-pick when the removed daemon was the active one; otherwise the
        // user's current selection is preserved.
        activeDaemon: isActiveDaemon(s.activeDaemon, daemonId)
          ? firstActiveDaemon(pairings)
          : s.activeDaemon,
        state: pairings.size > 0 ? "paired" : "unpaired",
      };
    });

    await secureSet(
      STORAGE_KEY,
      await serializePairings(finalPairings ?? get().pairings),
    );
  },

  setActiveDaemon: (daemon) => set({ activeDaemon: daemon }),

  reset: async () => {
    await secureSet(STORAGE_KEY, "");
    set({
      state: "unpaired",
      pairings: new Map(),
      activeDaemon: NO_ACTIVE_DAEMON,
      error: null,
      lastPeerUnpair: null,
    });
  },

  clearLastPeerUnpair: () => set({ lastPeerUnpair: null }),

  handlePeerUnpair: async (
    daemonId: string,
    reason: ControlUnpair["reason"],
  ) => {
    // Persist first (snapshot current pairings minus the removed entry).
    // Then apply the state update via functional set() so activeDaemon is read
    // from the latest store state rather than a pre-await snapshot (TOCTOU).
    const snapshotPairings = new Map(get().pairings);
    snapshotPairings.delete(daemonId);
    await secureSet(STORAGE_KEY, await serializePairings(snapshotPairings));

    set((s) => {
      const pairings = new Map(s.pairings);
      pairings.delete(daemonId);
      return {
        pairings,
        activeDaemon: isActiveDaemon(s.activeDaemon, daemonId)
          ? firstActiveDaemon(pairings)
          : s.activeDaemon,
        state: pairings.size > 0 ? "paired" : "unpaired",
        lastPeerUnpair: { daemonId, reason, ts: Date.now() },
      };
    });
  },

  renamePairing: async (daemonId: string, newLabel: string) => {
    const trimmed = newLabel.trim();
    const pairings = new Map(get().pairings);
    const existing = pairings.get(daemonId);
    if (!existing) return;
    // Protocol: an empty/whitespace name clears the label. `makeLabel` maps
    // that to `{ set: false }` and any real name to `{ set: true, value }`.
    pairings.set(daemonId, {
      ...existing,
      label: makeLabel(trimmed),
      labelSource: "user",
    });

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

  handlePeerRename: async (daemonId: string, label: Label) => {
    const pairings = new Map(get().pairings);
    const existing = pairings.get(daemonId);
    if (!existing) {
      console.warn("[pairing] handlePeerRename: unknown daemonId", daemonId);
      return;
    }
    // `label` is already the decoded `Label` union — `{ set: false }` is an
    // authoritative clear, `{ set: true, value }` the new name. Re-normalize
    // through `decodeWireLabel` so a legacy string carrying surrounding
    // whitespace is trimmed defensively before it lands in the store.
    // `control.rename` is an explicit user action on the daemon side and
    // expresses authoritative intent — adopt it even if the local label
    // was previously user-edited.
    pairings.set(daemonId, {
      ...existing,
      label: decodeWireLabel(label),
      labelSource: "daemon",
    });

    set({ pairings });
    await secureSet(STORAGE_KEY, await serializePairings(pairings));
  },

  handleDaemonHello: async (daemonId: string, label: Label) => {
    // Daemon's relay.kx broadcast carries its label. We adopt it so that an
    // unrelated rename via the daemon CLI converges here even if a
    // `control.rename` was missed (peer offline at the time). However we
    // must not clobber a label the user explicitly edited in the app —
    // that's a separate authority. Skip when `labelSource === "user"`.
    //
    // `{ set: false }` means the daemon advertises no label — keep whatever
    // the frontend already has (typically the device-name seed from the
    // initial scan, or the last-known label from a previous session). The
    // relay client normally short-circuits this case via `decodeKxLabelOrKeep`
    // and never fires the callback, but we guard here too for safety.
    if (!label.set) return;
    const pairings = new Map(get().pairings);
    const existing = pairings.get(daemonId);
    if (!existing) return;
    if (existing.labelSource === "user") return;
    const next = makeLabel(label.value);
    // Daemon advertised no usable label after trimming — keep what we have.
    if (!next.set) return;
    // Already converged on this value — no write needed.
    if (existing.label.set && existing.label.value === next.value) return;
    pairings.set(daemonId, {
      ...existing,
      label: next,
      labelSource: "daemon",
    });
    set({ pairings });
    await secureSet(STORAGE_KEY, await serializePairings(pairings));
  },
}));
