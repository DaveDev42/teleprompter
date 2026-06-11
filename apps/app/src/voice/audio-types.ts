/**
 * Platform-neutral contracts for the voice audio layer.
 *
 * voice-store.ts programs against these interfaces and picks the
 * implementation module at runtime — audio-web.ts (Web Audio API) on web,
 * audio-native.ts (react-native-audio-api) on iOS/Android. Both modules
 * export classes named AudioCapture / AudioPlayer satisfying these shapes,
 * so the store's dynamic-import site stays symmetric.
 */

export interface VoiceAudioCapture {
  /** Start microphone capture, streaming base64 PCM16 24 kHz chunks. */
  start(onChunk: (base64: string) => void): Promise<void>;
  stop(): void;
}

export interface VoiceAudioPlayer {
  start(): void;
  /** Queue a base64 PCM16 24 kHz chunk for sequential playback. */
  play(base64: string): void;
  stop(): void;
  pause(): void;
  resume(): void;
}
