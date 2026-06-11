/**
 * Unit tests for audio-native.ts — the react-native-audio-api-backed
 * AudioCapture / AudioPlayer used by voice-store on iOS/Android.
 *
 * react-native-audio-api is a native (JSI) module that cannot load under
 * Bun, so the whole package is mocked with an in-process fake that records
 * calls. The SUT is loaded via dynamic import after mock registration.
 * No other test file imports react-native-audio-api, so the process-wide
 * persistence of bun:test module mocks cannot leak into sibling suites.
 *
 * Run with:
 *   bun test apps/app/src/voice/audio-native.test.ts
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { bytesToBase64, float32ToPcm16 } from "./pcm";

// ---------------------------------------------------------------------------
// Fake react-native-audio-api
// ---------------------------------------------------------------------------

type AudioReadyCallback = (event: {
  buffer: FakeAudioBuffer;
  numFrames: number;
  when: number;
}) => void;

class FakeAudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels = 1;
  private readonly data: Float32Array;

  constructor(data: Float32Array, sampleRate: number) {
    this.data = data;
    this.sampleRate = sampleRate;
    this.length = data.length;
  }

  getChannelData(_channel: number): Float32Array {
    return this.data;
  }

  copyToChannel(source: Float32Array, _channel: number): void {
    this.data.set(source);
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }
}

const recorderLog: string[] = [];
let registeredCallback: AudioReadyCallback | null = null;
let registeredOptions: Record<string, unknown> | null = null;

class FakeAudioRecorder {
  onAudioReady(options: Record<string, unknown>, cb: AudioReadyCallback) {
    registeredOptions = options;
    registeredCallback = cb;
    recorderLog.push("onAudioReady");
  }

  clearOnAudioReady() {
    registeredCallback = null;
    recorderLog.push("clearOnAudioReady");
  }

  start() {
    recorderLog.push("start");
  }

  stop() {
    recorderLog.push("stop");
  }
}

interface ScheduledSource {
  buffer: FakeAudioBuffer | null;
  startedAt: number;
  connected: boolean;
}

const playerLog: string[] = [];
const scheduledSources: ScheduledSource[] = [];
let lastContext: FakeAudioContext | null = null;

class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  readonly destination = { fake: "destination" };
  closed = false;

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48000;
    lastContext = this;
    playerLog.push(`context(${this.sampleRate})`);
  }

  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(new Float32Array(length * channels), sampleRate);
  }

  createBufferSource() {
    const source: ScheduledSource & {
      connect: (dest: unknown) => void;
      start: (when: number) => void;
    } = {
      buffer: null,
      startedAt: -1,
      connected: false,
      connect() {
        source.connected = true;
      },
      start(when: number) {
        source.startedAt = when;
        scheduledSources.push(source);
      },
    };
    return source;
  }

  async close() {
    this.closed = true;
    playerLog.push("close");
  }
}

const permissionCalls: string[] = [];
let checkResult = "Granted";
let requestResult = "Granted";
const sessionOptionsLog: Record<string, unknown>[] = [];

const FakeAudioManager = {
  async checkRecordingPermissions() {
    permissionCalls.push("check");
    return checkResult;
  },
  async requestRecordingPermissions() {
    permissionCalls.push("request");
    return requestResult;
  },
  setAudioSessionOptions(options: Record<string, unknown>) {
    sessionOptionsLog.push(options);
  },
};

mock.module("react-native-audio-api", () => ({
  AudioContext: FakeAudioContext,
  AudioRecorder: FakeAudioRecorder,
  AudioManager: FakeAudioManager,
}));

const { AudioCapture, AudioPlayer, ensureRecordingPermission } = await import(
  "./audio-native"
);

beforeEach(() => {
  recorderLog.length = 0;
  playerLog.length = 0;
  scheduledSources.length = 0;
  permissionCalls.length = 0;
  sessionOptionsLog.length = 0;
  registeredCallback = null;
  registeredOptions = null;
  lastContext = null;
  checkResult = "Granted";
  requestResult = "Granted";
});

// ---------------------------------------------------------------------------
// ensureRecordingPermission
// ---------------------------------------------------------------------------

describe("ensureRecordingPermission", () => {
  test("short-circuits when already granted", async () => {
    checkResult = "Granted";
    expect(await ensureRecordingPermission()).toBe(true);
    expect(permissionCalls).toEqual(["check"]);
  });

  test("requests when undetermined and reports grant", async () => {
    checkResult = "Undetermined";
    requestResult = "Granted";
    expect(await ensureRecordingPermission()).toBe(true);
    expect(permissionCalls).toEqual(["check", "request"]);
  });

  test("reports denial", async () => {
    checkResult = "Denied";
    requestResult = "Denied";
    expect(await ensureRecordingPermission()).toBe(false);
    expect(permissionCalls).toEqual(["check", "request"]);
  });
});

// ---------------------------------------------------------------------------
// AudioCapture
// ---------------------------------------------------------------------------

describe("AudioCapture", () => {
  test("start registers a 24kHz mono callback and starts the recorder", async () => {
    const capture = new AudioCapture();
    await capture.start(() => {});
    expect(recorderLog).toEqual(["onAudioReady", "start"]);
    expect(registeredOptions).toEqual({
      sampleRate: 24000,
      bufferLength: 2048,
      channelCount: 1,
    });
  });

  test("start configures the audio session for voice chat", async () => {
    const capture = new AudioCapture();
    await capture.start(() => {});
    expect(sessionOptionsLog.length).toBe(1);
    expect(sessionOptionsLog[0]).toMatchObject({
      iosCategory: "playAndRecord",
      iosMode: "voiceChat",
    });
  });

  test("emits base64 PCM16 chunks from 24kHz buffers verbatim", async () => {
    const chunks: string[] = [];
    const capture = new AudioCapture();
    await capture.start((b64) => chunks.push(b64));

    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    registeredCallback?.({
      buffer: new FakeAudioBuffer(samples, 24000),
      numFrames: samples.length,
      when: 0,
    });

    expect(chunks.length).toBe(1);
    const expected = bytesToBase64(
      new Uint8Array(float32ToPcm16(samples).buffer),
    );
    expect(chunks[0]).toBe(expected);
  });

  test("resamples off-rate buffers down to 24kHz", async () => {
    const chunks: string[] = [];
    const capture = new AudioCapture();
    await capture.start((b64) => chunks.push(b64));

    // 480 samples at 48kHz = 10ms → 240 samples at 24kHz = 480 bytes PCM16
    registeredCallback?.({
      buffer: new FakeAudioBuffer(new Float32Array(480).fill(0.25), 48000),
      numFrames: 480,
      when: 0,
    });

    expect(chunks.length).toBe(1);
    // 240 samples * 2 bytes = 480 bytes → base64 length 640 (480/3*4)
    expect(chunks[0]!.length).toBe(640);
  });

  test("stop clears the callback and stops the recorder", async () => {
    const capture = new AudioCapture();
    await capture.start(() => {});
    capture.stop();
    expect(recorderLog).toEqual([
      "onAudioReady",
      "start",
      "clearOnAudioReady",
      "stop",
    ]);
    expect(registeredCallback).toBeNull();
  });

  test("stop is safe to call before start", () => {
    const capture = new AudioCapture();
    expect(() => capture.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AudioPlayer
// ---------------------------------------------------------------------------

describe("AudioPlayer", () => {
  function makeChunk(samples: number[]): string {
    return bytesToBase64(
      new Uint8Array(float32ToPcm16(new Float32Array(samples)).buffer),
    );
  }

  test("start opens a 24kHz context", () => {
    const player = new AudioPlayer();
    player.start();
    expect(playerLog).toEqual(["context(24000)"]);
  });

  test("play before start is a no-op", () => {
    const player = new AudioPlayer();
    player.play(makeChunk([0.1, 0.2]));
    expect(scheduledSources.length).toBe(0);
  });

  test("schedules sequential chunks back to back", () => {
    const player = new AudioPlayer();
    player.start();

    // 2400 samples = 100ms at 24kHz
    const chunk = makeChunk(Array.from({ length: 2400 }, () => 0.1));
    player.play(chunk);
    player.play(chunk);

    expect(scheduledSources.length).toBe(2);
    expect(scheduledSources[0]!.connected).toBe(true);
    expect(scheduledSources[0]!.startedAt).toBe(0);
    expect(scheduledSources[1]!.startedAt).toBeCloseTo(0.1, 5);
  });

  test("stop closes the context and silences subsequent play calls", () => {
    const player = new AudioPlayer();
    player.start();
    player.stop();
    expect(lastContext?.closed).toBe(true);
    player.play(makeChunk([0.1]));
    expect(scheduledSources.length).toBe(0);
  });

  test("pause suppresses playback, resume restores it", () => {
    const player = new AudioPlayer();
    player.start();
    player.pause();
    player.play(makeChunk([0.1, 0.2]));
    expect(scheduledSources.length).toBe(0);
    player.resume();
    player.play(makeChunk([0.1, 0.2]));
    expect(scheduledSources.length).toBe(1);
  });
});
