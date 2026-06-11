import { Platform } from "react-native";
import { create } from "zustand";
import { secureDelete, secureGet, secureSet } from "../lib/secure-storage";
import type { VoiceAudioCapture, VoiceAudioPlayer } from "../voice/audio-types";
import { RealtimeClient } from "../voice/realtime-client";
import { formatTerminalContext } from "../voice/terminal-context";

/**
 * Minimal terminal interface exposed to the voice store.
 * Mirrors the TerminalLike shape in terminal-context.ts — kept here as a
 * structural type so voice-store.ts does not import from the voice/ layer's
 * own implementation file, and so tsc enforces the contract rather than
 * relying on an invisible unknown→TerminalLike cast at the call site.
 */
interface TerminalLike {
  buffer?: {
    active?: {
      length: number;
      getLine(
        y: number,
      ): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** Global terminal ref — set by the Terminal screen */
let globalTermRef: TerminalLike | null = null;
export function setGlobalTermRef(ref: TerminalLike | null) {
  globalTermRef = ref;
}
export function getGlobalTermRef(): TerminalLike | null {
  return globalTermRef;
}

/**
 * Voice connection state as a discriminated union.
 * transcript and isSpeaking are folded into the arms where they are
 * semantically meaningful: transcript exists only while listening or
 * processing, isSpeaking only while listening.
 */
export type VoiceConnectionState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "listening"; isSpeaking: boolean; transcript: string }
  | { status: "processing"; transcript: string };

/**
 * API key state as a discriminated union.
 * Replaces the apiKey:string|null + loaded:boolean pair, which could
 * represent four combinations but only three are valid.
 * - loading: initial state, secureGet not yet complete
 * - absent: load finished, no key stored (or key was removed)
 * - present: a non-empty key is available
 */
export type VoiceKeyState =
  | { status: "loading" }
  | { status: "absent" }
  | { status: "present"; key: string };

export interface VoiceStore {
  connection: VoiceConnectionState;
  /** One-shot refined prompt output — not a sentinel, stays plain string */
  refinedPrompt: string;
  /** Whether to include terminal context in system prompt */
  includeTerminal: boolean;
  keyState: VoiceKeyState;

  // Actions
  load: () => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  startVoice: () => Promise<void>;
  stopVoice: () => void;
  toggleTerminalContext: () => void;
  /** Callback when a refined prompt is ready to send */
  _onPromptReady: ((prompt: string) => void) | null;
  setOnPromptReady: (fn: ((prompt: string) => void) | null) => void;
}

const VOICE_STORAGE_KEY = "voice_api_key";

let realtimeClient: RealtimeClient | null = null;
let audioCapture: VoiceAudioCapture | null = null;
let audioPlayer: VoiceAudioPlayer | null = null;
/**
 * Invalidation token for in-flight async work. startVoice suspends twice
 * (native permission dialog, dynamic audio-module import) and the user can
 * tap Stop — or start a new session — during either gap. Every teardown
 * bumps the generation; resumed work compares its captured value and bails
 * instead of opening a socket or mic for a session that no longer exists.
 */
let voiceGeneration = 0;

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  connection: { status: "idle" },
  refinedPrompt: "",
  includeTerminal: false,
  keyState: { status: "loading" },
  _onPromptReady: null,

  load: async () => {
    try {
      const raw = await secureGet(VOICE_STORAGE_KEY);
      if (raw) {
        set({ keyState: { status: "present", key: raw } });
        return;
      }
    } catch {
      // ignore
    }
    set({ keyState: { status: "absent" } });
  },

  setApiKey: async (key) => {
    if (key) {
      set({ keyState: { status: "present", key } });
      await secureSet(VOICE_STORAGE_KEY, key);
    } else {
      set({ keyState: { status: "absent" } });
      await secureDelete(VOICE_STORAGE_KEY);
    }
  },

  startVoice: async () => {
    const { keyState, connection, includeTerminal } = get();
    if (keyState.status !== "present") return;
    // Already connected or connecting — do not overwrite realtimeClient without cleanup.
    if (connection.status !== "idle") return;

    const { key } = keyState;
    // Clean up any lingering client before creating a new one (defensive guard
    // against concurrent calls racing past the status check above).
    cleanup();
    const gen = ++voiceGeneration;
    set({ connection: { status: "connecting" }, refinedPrompt: "" });

    // Native: surface the OS microphone prompt before opening the realtime
    // socket — a denied permission would otherwise burn a connection and
    // leave capture silently dead. The button shows "Connecting" while the
    // OS permission dialog is up.
    if (Platform.OS !== "web") {
      const { ensureRecordingPermission } = await import(
        "../voice/audio-native"
      );
      const granted = await ensureRecordingPermission();
      // stopVoice (or a newer startVoice) ran while the permission dialog
      // was up — don't open a socket for an abandoned session.
      if (gen !== voiceGeneration) return;
      if (!granted) {
        console.error("[Voice] microphone permission denied");
        set({ connection: { status: "idle" } });
        return;
      }
    }

    // Build system prompt with optional terminal context
    let termContext = "";
    if (includeTerminal && globalTermRef) {
      termContext = formatTerminalContext(globalTermRef);
    }
    const systemPrompt = buildSystemPrompt() + termContext;

    realtimeClient = new RealtimeClient(
      { apiKey: key, systemPrompt },
      {
        onConnected: async () => {
          if (gen !== voiceGeneration) return;
          set({
            connection: {
              status: "listening",
              isSpeaking: false,
              transcript: "",
            },
          });

          // Start audio capture — platform-specific implementation behind
          // the shared VoiceAudioCapture / VoiceAudioPlayer contract.
          const audioModule =
            Platform.OS === "web"
              ? await import("../voice/audio-web")
              : await import("../voice/audio-native");
          // stopVoice ran while the import was in flight — starting capture
          // now would orphan a live mic with no UI left to stop it.
          if (gen !== voiceGeneration) return;
          audioCapture = new audioModule.AudioCapture();
          audioPlayer = new audioModule.AudioPlayer();
          audioPlayer.start();
          try {
            await audioCapture.start((chunk: string) => {
              realtimeClient?.sendAudio(chunk);
            });
          } catch (error) {
            // getUserMedia rejection (web) or recorder start failure
            // (native) — without this the user sees "Listening" while the
            // mic is silently dead.
            console.error("[Voice] audio capture failed to start", error);
            if (gen !== voiceGeneration) return;
            cleanup();
            set({ connection: { status: "idle" } });
          }
        },
        onDisconnected: () => {
          set({ connection: { status: "idle" } });
          cleanup();
        },
        onSpeechStart: () => {
          // User started speaking — cancel any playing TTS
          audioPlayer?.stop();
          audioPlayer?.start();
        },
        onSpeechEnd: () => {
          // Carry current transcript into processing state
          const { connection } = get();
          const transcript =
            connection.status === "listening" ? connection.transcript : "";
          set({ connection: { status: "processing", transcript } });
        },
        onTranscript: (text) => {
          // Preserve the current isSpeaking flag — the transcript update may
          // arrive while the TTS audio is still playing (onAudio set isSpeaking:
          // true). Resetting to false here would lose that signal until onAudioDone
          // fires and cause the UI to flicker erroneously.
          const { connection } = get();
          const isSpeaking =
            connection.status === "listening" ? connection.isSpeaking : false;
          set({
            connection: {
              status: "listening",
              isSpeaking,
              transcript: text,
            },
          });
        },
        onAudio: (base64) => {
          const { connection } = get();
          if (connection.status === "listening") {
            set({
              connection: {
                status: "listening",
                isSpeaking: true,
                transcript: connection.transcript,
              },
            });
          }
          audioPlayer?.play(base64);
        },
        onAudioDone: () => {
          const { connection } = get();
          if (connection.status === "listening") {
            set({
              connection: {
                status: "listening",
                isSpeaking: false,
                transcript: connection.transcript,
              },
            });
          }
        },
        onRefinedPrompt: (prompt) => {
          // Only update refinedPrompt — do not write connection back unchanged
          // as that would trigger spurious subscriber notifications. The
          // connection state is unaffected by a refined-prompt event.
          set({ refinedPrompt: prompt });
          // Send the refined prompt to Claude Code
          get()._onPromptReady?.(prompt);
        },
        onError: (error) => {
          console.error("[Voice]", error);
          set({ connection: { status: "idle" } });
          cleanup();
        },
      },
    );

    realtimeClient.connect();
  },

  stopVoice: () => {
    cleanup();
    set({ connection: { status: "idle" } });
  },

  toggleTerminalContext: () => {
    set((s) => ({ includeTerminal: !s.includeTerminal }));
  },

  setOnPromptReady: (fn) => set({ _onPromptReady: fn }),
}));

function cleanup() {
  // Invalidate any suspended startVoice / onConnected continuation —
  // teardown means whatever they were setting up is no longer wanted.
  voiceGeneration++;
  audioCapture?.stop();
  audioCapture = null;
  audioPlayer?.stop();
  audioPlayer = null;
  realtimeClient?.dispose();
  realtimeClient = null;
}

function buildSystemPrompt(): string {
  const prompt = `You are a voice interface for Teleprompter, a remote Claude Code controller.

Your role:
1. Listen to the user's voice input
2. Clean up and refine it into a clear, actionable prompt for Claude Code
3. Respond briefly with a spoken confirmation

Rules:
- Keep spoken responses SHORT (1-2 sentences max)
- Output the refined prompt as text in your response
- The refined prompt will be automatically sent to Claude Code
- If the user's intent is unclear, ask a brief clarifying question

Example:
- User: "um, can you like fix the bug in the login page, the one where it crashes"
- Your response: "Fixing the login crash bug."
- (Refined prompt sent to Claude: "Fix the bug in the login page that causes a crash")`;

  return prompt;
}
