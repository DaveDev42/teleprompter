/**
 * Web Audio API utilities for microphone capture and PCM16 playback.
 * Only works on web platform.
 */

import {
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
} from "./pcm";

const SAMPLE_RATE = 24000; // Realtime API expects 24kHz

/**
 * Capture microphone audio and stream as base64 PCM16 chunks.
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onChunk: ((base64: string) => void) | null = null;

  async start(onChunk: (base64: string) => void): Promise<void> {
    this.onChunk = onChunk;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Retain the source node so it can be disconnected in stop().
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessor for raw PCM access (deprecated but widely supported)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = float32ToPcm16(float32);
      const base64 = bytesToBase64(new Uint8Array(pcm16.buffer));
      this.onChunk?.(base64);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stop(): void {
    // Disconnect both graph nodes to release the audio graph and mic stream.
    this.source?.disconnect();
    this.source = null;
    this.processor?.disconnect();
    this.processor = null;
    this.stream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.stream = null;
    this.audioContext?.close();
    this.audioContext = null;
    this.onChunk = null;
  }
}

/**
 * Play base64-encoded PCM16 24kHz audio chunks.
 */
export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextPlayTime = 0;
  private playing = false;

  start(): void {
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.nextPlayTime = this.audioContext.currentTime;
    this.playing = true;
  }

  /**
   * Queue a base64 PCM16 chunk for playback.
   */
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
    buffer.getChannelData(0).set(float32);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    // Schedule sequential playback
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
