import { afterEach, describe, expect, it, vi } from "vitest";
import { playRecordedAudio } from "../src/audio/play-recording";

const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(globalThis, "Audio", {
    configurable: true,
    writable: true,
    value: originalAudio,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  });
  vi.restoreAllMocks();
});

describe("playRecordedAudio", () => {
  it("播放技能成功后使用的原始录音并在结束时释放对象地址", async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    class MockAudio {
      static latest: MockAudio | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        MockAudio.latest = this;
      }
      play = play;
    }
    Object.defineProperty(globalThis, "Audio", {
      configurable: true,
      value: MockAudio,
    });
    const createObjectURL = vi.fn().mockReturnValue("blob:skill");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectURL,
    });

    playRecordedAudio(new Blob(["voice"], { type: "audio/wav" }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(play).toHaveBeenCalledOnce();
    // 触发标准 onended 属性，验证临时 Blob 地址不会泄漏。
    MockAudio.latest?.onended?.();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:skill");
  });
});
