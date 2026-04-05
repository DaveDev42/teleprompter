import { Platform } from "react-native";
import { create } from "zustand";
import { secureDelete, secureGet, secureSet } from "../lib/secure-storage";
import type { AudioCapture, AudioPlayer } from "../voice/audio-web";
import { RealtimeClient } from "../voice/realtime-client";
import { formatTerminalContext } from "../voice/terminal-context";

/** Global terminal ref — set by the Terminal screen */
let globalTermRef: any = null;
export function setGlobalTermRef(ref: any) {
  globalTermRef = ref;
}
export function getGlobalTermRef(): any {
  return globalTermRef;
}

export type VoiceState = "idle" | "connecting" | "listening" | "processing";

export interface VoiceStore {
  state: VoiceState;
  transcript: string;
  refinedPrompt: string;
  isSpeaking: boolean;
  /** Whether to include terminal context in system prompt */
  includeTerminal: boolean;
  /** OpenAI API key */
  apiKey: string | null;
  loaded: boolean;

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
  state: "idle",
  transcript: "",
  refinedPrompt: "",
  isSpeaking: false,
  includeTerminal: false,
  apiKey: null,
  loaded: false,
  _onPromptReady: null,

  load: async () => {
    try {
      const raw = await secureGet(VOICE_STORAGE_KEY);
      if (raw) {
        set({ apiKey: raw, loaded: true });
        return;
      }
    } catch {
      // ignore
    }
    set({ loaded: true });
  },

  setApiKey: async (key) => {
    if (key) {
      set({ apiKey: key });
      await secureSet(VOICE_STORAGE_KEY, key);
    } else {
      set({ apiKey: null });
      await secureDelete(VOICE_STORAGE_KEY);
    }
  },

  startVoice: async () => {
    const { apiKey, includeTerminal } = get();
    if (!apiKey) return;
    if (Platform.OS !== "web") return; // Web only for now

    set({ state: "connecting", transcript: "", refinedPrompt: "" });

    // Build system prompt with optional terminal context
    let termContext = "";
    if (includeTerminal && globalTermRef) {
      termContext = formatTerminalContext(globalTermRef);
    }
    const systemPrompt = buildSystemPrompt(includeTerminal) + termContext;

    realtimeClient = new RealtimeClient(
      { apiKey, systemPrompt },
      {
        onConnected: async () => {
          set({ state: "listening" });

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
          set({ state: "idle" });
          cleanup();
        },
        onSpeechStart: () => {
          // User started speaking — cancel any playing TTS
          audioPlayer?.stop();
          audioPlayer?.start();
        },
        onSpeechEnd: () => {
          set({ state: "processing" });
        },
        onTranscript: (text) => {
          set({ transcript: text, state: "listening" });
        },
        onAudio: (base64) => {
          set({ isSpeaking: true });
          audioPlayer?.play(base64);
        },
        onAudioDone: () => {
          set({ isSpeaking: false });
        },
        onRefinedPrompt: (prompt) => {
          set({ refinedPrompt: prompt, state: "listening" });
          // Send the refined prompt to Claude Code
          get()._onPromptReady?.(prompt);
        },
        onError: (error) => {
          console.error("[Voice]", error);
          set({ state: "idle" });
          cleanup();
        },
      },
    );

    realtimeClient.connect();
  },

  stopVoice: () => {
    cleanup();
    set({ state: "idle", isSpeaking: false });
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

function buildSystemPrompt(includeTerminal: boolean): string {
  let prompt = `You are a voice interface for Teleprompter, a remote Claude Code controller.

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

  if (includeTerminal) {
    // In production, this would inject actual terminal state
    prompt += `\n\nTerminal context is enabled. The user may reference what's on their terminal screen.`;
  }

  return prompt;
}
