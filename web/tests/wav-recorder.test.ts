import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePcm16Wav, WavRecorder } from "../src/audio/wav-recorder";

const originalAudioContext = globalThis.AudioContext;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;

afterEach(() => {
  globalThis.AudioContext = originalAudioContext;
  globalThis.AudioWorkletNode = originalAudioWorkletNode;
  vi.restoreAllMocks();
});

describe("WavRecorder", () => {
  it("未开始录音时拒绝结束", async () => {
    await expect(new WavRecorder().stop()).rejects.toThrow(
      "RECORDER_NOT_STARTED",
    );
  });

  it("编码标准 PCM16 单声道 WAV 并限制采样幅度", async () => {
    const blob = encodePcm16Wav([
      new Float32Array([-2, -0.5]),
      new Float32Array([0.5, 2]),
    ], 16_000);
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const view = new DataView(buffer);
    const text = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(36, 4)).toBe("data");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
  });

  it("采集 AudioWorklet 数据并在结束时释放设备", async () => {
    const stop = vi.fn();
    const disconnectSource = vi.fn();
    const disconnectNode = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    let workletMessage: ((event: MessageEvent<Float32Array>) => void) | null =
      null;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop }],
        }),
      },
    });
    class MockAudioContext {
      sampleRate = 16_000;
      destination = {} as AudioDestinationNode;
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: disconnectSource,
        } as unknown as MediaStreamAudioSourceNode;
      }
      close = close;
    }
    class MockWorkletNode {
      port = {
        set onmessage(
          handler: ((event: MessageEvent<Float32Array>) => void) | null,
        ) {
          workletMessage = handler;
        },
      };
      connect = vi.fn();
      disconnect = disconnectNode;
    }
    globalThis.AudioContext =
      MockAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode =
      MockWorkletNode as unknown as typeof AudioWorkletNode;

    const recorder = new WavRecorder();
    await recorder.start();
    expect(workletMessage).not.toBeNull();
    const emitChunk = workletMessage as unknown as (
      event: MessageEvent<Float32Array>,
    ) => void;
    emitChunk({ data: new Float32Array([0.25]) } as MessageEvent<Float32Array>);
    const result = await recorder.stop();
    expect(result.type).toBe("audio/wav");
    expect(result.size).toBe(46);
    expect(stop).toHaveBeenCalledOnce();
    expect(disconnectSource).toHaveBeenCalledOnce();
    expect(disconnectNode).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
