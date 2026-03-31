/**
 * Web Audio API utilities for microphone capture and PCM16 playback.
 * Only works on web platform.
 */

const SAMPLE_RATE = 24000; // Realtime API expects 24kHz

/**
 * Capture microphone audio and stream as base64 PCM16 chunks.
 */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
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
    const source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessor for raw PCM access (deprecated but widely supported)
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = float32ToPcm16(float32);
      const base64 = uint8ArrayToBase64(new Uint8Array(pcm16.buffer));
      this.onChunk?.(base64);
    };

    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stop(): void {
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

    const pcm16 = base64ToUint8Array(base64);
    const float32 = pcm16ToFloat32(new Int16Array(pcm16.buffer));

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

// ── Helpers ──

function float32ToPcm16(float32: Float32Array): Int16Array {
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm16;
}

function pcm16ToFloat32(pcm16: Int16Array): Float32Array {
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7fff);
  }
  return float32;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
