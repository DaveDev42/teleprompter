import { Platform } from "react-native";
import { create } from "zustand";
import { secureDelete, secureGet, secureSet } from "../lib/secure-storage";
import type { AudioCapture, AudioPlayer } from "../voice/audio-web";
import { RealtimeClient } from "../voice/realtime-client";
import { formatTerminalContext } from "../voice/terminal-context";

/** Global terminal ref — set by the Terminal screen */
let globalTermRef: unknown = null;
export function setGlobalTermRef(ref: unknown) {
  globalTermRef = ref;
}
export function getGlobalTermRef(): unknown {
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
let audioCapture: AudioCapture | null = null;
let audioPlayer: AudioPlayer | null = null;

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
    const { keyState, includeTerminal } = get();
    if (keyState.status !== "present") return;
    if (Platform.OS !== "web") return; // Web only for now

    const { key } = keyState;
    set({ connection: { status: "connecting" }, refinedPrompt: "" });

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
          set({
            connection: {
              status: "listening",
              isSpeaking: false,
              transcript: "",
            },
          });

          // Start audio capture
          if (Platform.OS === "web") {
            const { AudioCapture, AudioPlayer } = await import(
              "../voice/audio-web"
            );
            audioCapture = new AudioCapture();
            audioPlayer = new AudioPlayer();
            audioPlayer.start();
            await audioCapture.start((chunk: string) => {
              realtimeClient?.sendAudio(chunk);
            });
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
          set({
            connection: {
              status: "listening",
              isSpeaking: false,
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
          const { connection } = get();
          if (connection.status === "listening") {
            set({
              connection: {
                status: "listening",
                isSpeaking: connection.isSpeaking,
                transcript: connection.transcript,
              },
            });
          }
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
