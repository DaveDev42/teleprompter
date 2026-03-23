/**
 * OpenAI Realtime API client for voice input/output.
 *
 * Handles:
 * - WebSocket connection to Realtime API
 * - Audio streaming (PCM16 24kHz)
 * - Server VAD for automatic speech detection
 * - Transcript extraction (STT)
 * - TTS audio playback via response.audio events
 * - Session configuration with system prompt
 */

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const MODEL = "gpt-4o-realtime-preview";

export interface RealtimeConfig {
  apiKey: string;
  /** System prompt for context injection */
  systemPrompt?: string;
  /** Voice for TTS output */
  voice?: "alloy" | "echo" | "shimmer" | "ash" | "ballad" | "coral" | "sage" | "verse";
}

export interface RealtimeEvents {
  /** Called when a complete transcript is available */
  onTranscript?: (text: string) => void;
  /** Called with audio data chunks for playback (base64 PCM16 24kHz) */
  onAudio?: (audioBase64: string) => void;
  /** Called when the model finishes speaking */
  onAudioDone?: () => void;
  /** Called when VAD detects speech start */
  onSpeechStart?: () => void;
  /** Called when VAD detects speech end */
  onSpeechEnd?: () => void;
  /** Connection state */
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: string) => void;
  /** Called with the refined prompt text from the model */
  onRefinedPrompt?: (prompt: string) => void;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private events: RealtimeEvents;
  private disposed = false;

  constructor(config: RealtimeConfig, events: RealtimeEvents = {}) {
    this.config = config;
    this.events = events;
  }

  connect(): void {
    if (this.disposed) return;

    const url = `${REALTIME_URL}?model=${MODEL}`;
    const ws = new WebSocket(url, [
      "realtime",
      `openai-insecure-api-key.${this.config.apiKey}`,
    ]);

    this.ws = ws;

    ws.onopen = () => {
      this.events.onConnected?.();
      this.configureSession();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.events.onDisconnected?.();
    };

    ws.onerror = () => {
      this.events.onError?.("Realtime API connection error");
    };
  }

  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this.config.systemPrompt ?? this.defaultSystemPrompt(),
        voice: this.config.voice ?? "alloy",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    });
  }

  private defaultSystemPrompt(): string {
    return `You are a voice interface for Teleprompter, a remote Claude Code controller.

Your role:
1. Listen to the user's voice input
2. Clean up and refine it into a clear, actionable prompt for Claude Code
3. Respond briefly to confirm what you understood

Keep responses short and conversational. The refined prompt will be sent to Claude Code automatically.

When the user gives a coding instruction, output it as a clean prompt. For example:
- User says: "um, can you like, fix the bug in the login page, the one where it crashes"
- You respond: "Got it, fixing the login page crash bug."
- Refined prompt: "Fix the bug in the login page that causes a crash"`;
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case "session.created":
      case "session.updated":
        // Session configured successfully
        break;

      case "input_audio_buffer.speech_started":
        this.events.onSpeechStart?.();
        break;

      case "input_audio_buffer.speech_stopped":
        this.events.onSpeechEnd?.();
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.events.onTranscript?.(msg.transcript ?? "");
        break;

      case "response.audio.delta":
        // Streaming audio chunk
        if (msg.delta) {
          this.events.onAudio?.(msg.delta);
        }
        break;

      case "response.audio.done":
        this.events.onAudioDone?.();
        break;

      case "response.text.done":
        // Model's text response (the refined prompt)
        if (msg.text) {
          this.events.onRefinedPrompt?.(msg.text);
        }
        break;

      case "response.done":
        // Extract text from the response output
        if (msg.response?.output) {
          for (const item of msg.response.output) {
            if (item.type === "message") {
              for (const content of item.content ?? []) {
                if (content.type === "text" && content.text) {
                  this.events.onRefinedPrompt?.(content.text);
                }
              }
            }
          }
        }
        break;

      case "error":
        this.events.onError?.(
          msg.error?.message ?? "Realtime API error",
        );
        break;
    }
  }

  /**
   * Send audio data to the Realtime API.
   * @param audioBase64 - Base64-encoded PCM16 24kHz audio
   */
  sendAudio(audioBase64: string): void {
    this.send({
      type: "input_audio_buffer.append",
      audio: audioBase64,
    });
  }

  /**
   * Commit the current audio buffer (trigger processing).
   * Usually not needed with server VAD, but useful for manual mode.
   */
  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  /**
   * Send a text message (for text-based interaction with the model).
   */
  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({ type: "response.create" });
  }

  /**
   * Update the system prompt (for context injection).
   */
  updateSystemPrompt(prompt: string): void {
    this.send({
      type: "session.update",
      session: {
        instructions: prompt,
      },
    });
  }

  /**
   * Cancel any in-progress response.
   */
  cancelResponse(): void {
    this.send({ type: "response.cancel" });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }
}
