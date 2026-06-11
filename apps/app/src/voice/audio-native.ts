/**
 * Native (iOS/Android) microphone capture and PCM16 playback built on
 * react-native-audio-api. Mirrors the AudioCapture / AudioPlayer contract in
 * audio-types.ts so voice-store can swap this module in for audio-web.ts on
 * non-web platforms.
 *
 * This module must only be imported on native — voice-store dynamically
 * imports it behind a Platform.OS check, so the web bundle never evaluates
 * react-native-audio-api's native bindings.
 */

import {
  AudioManager,
  AudioRecorder,
  AudioContext as NativeAudioContext,
} from "react-native-audio-api";
import {
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleLinear,
} from "./pcm";

const SAMPLE_RATE = 24000; // Realtime API expects 24kHz

/**
 * Check (and if needed prompt for) microphone permission.
 * Returns true when recording is permitted.
 */
export async function ensureRecordingPermission(): Promise<boolean> {
  const current = await AudioManager.checkRecordingPermissions();
  if (current === "Granted") return true;
  const requested = await AudioManager.requestRecordingPermissions();
  return requested === "Granted";
}

/**
 * Configure the audio session for simultaneous capture + playback.
 * voiceChat mode enables the platform echo canceller on iOS so the model's
 * TTS coming out of the speaker is not re-captured as user speech (the web
 * path gets this from getUserMedia's echoCancellation constraint).
 */
function configureVoiceSession(): void {
  AudioManager.setAudioSessionOptions({
    iosCategory: "playAndRecord",
    iosMode: "voiceChat",
    iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
  });
}

/**
 * Capture microphone audio and stream as base64 PCM16 24 kHz chunks.
 */
export class AudioCapture {
  private recorder: AudioRecorder | null = null;
  private onChunk: ((base64: string) => void) | null = null;

  async start(onChunk: (base64: string) => void): Promise<void> {
    this.onChunk = onChunk;
    configureVoiceSession();

    this.recorder = new AudioRecorder();
    this.recorder.onAudioReady(
      // ~85ms per chunk at 24 kHz — close to the web path's 4096-sample
      // ScriptProcessor cadence while keeping VAD latency low.
      { sampleRate: SAMPLE_RATE, bufferLength: 2048, channelCount: 1 },
      (event) => {
        const { buffer } = event;
        let float32 = buffer.getChannelData(0);
        if (buffer.sampleRate !== SAMPLE_RATE) {
          // Hardware may ignore the requested rate (44.1/48 kHz is common).
          float32 = resampleLinear(float32, buffer.sampleRate, SAMPLE_RATE);
        }
        const pcm16 = float32ToPcm16(float32);
        this.onChunk?.(bytesToBase64(new Uint8Array(pcm16.buffer)));
      },
    );
    this.recorder.start();
  }

  stop(): void {
    this.recorder?.clearOnAudioReady();
    try {
      this.recorder?.stop();
    } catch {
      // stop() throws if the recorder never started (e.g. permission revoked
      // between start() and the first buffer) — nothing to release then.
    }
    this.recorder = null;
    this.onChunk = null;
  }
}

/**
 * Play base64-encoded PCM16 24 kHz audio chunks.
 * Scheduling logic mirrors audio-web.ts's AudioPlayer — sequential buffers
 * queued against nextPlayTime on a dedicated AudioContext.
 */
export class AudioPlayer {
  private audioContext: NativeAudioContext | null = null;
  private nextPlayTime = 0;
  private playing = false;

  start(): void {
    this.audioContext = new NativeAudioContext({ sampleRate: SAMPLE_RATE });
    this.nextPlayTime = this.audioContext.currentTime;
    this.playing = true;
  }

  play(base64: string): void {
    if (!this.audioContext || !this.playing) return;

    const bytes = base64ToBytes(base64);
    const float32 = pcm16ToFloat32(
      new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    );

    const buffer = this.audioContext.createBuffer(
      1,
      float32.length,
      SAMPLE_RATE,
    );
    buffer.copyToChannel(float32, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now;
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
  }

  stop(): void {
    this.playing = false;
    this.audioContext?.close();
    this.audioContext = null;
  }

  pause(): void {
    this.playing = false;
  }

  resume(): void {
    this.playing = true;
  }
}
