import { describe, expect, it, vi } from "vitest";
import {
  BrowserSpeechRecognizer,
  type BrowserSpeechRecognitionLike,
} from "../src/audio/browser-speech-recognizer";
import { browserSpeechErrorMessage } from "../src/audio/use-browser-speech-recognition";

function fakeRecognition(): BrowserSpeechRecognitionLike {
  return {
    lang: "",
    continuous: true,
    interimResults: true,
    maxAlternatives: 0,
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
  };
}

describe("BrowserSpeechRecognizer", () => {
  it("保留服务端错误信息，同时隐藏未知浏览器错误码", () => {
    expect(browserSpeechErrorMessage(new Error("当前回合已经变化"))).toBe(
      "当前回合已经变化",
    );
    expect(
      browserSpeechErrorMessage(new Error("BROWSER_SPEECH_UNKNOWN_VENDOR_ERROR")),
    ).toBe("浏览器语音识别失败");
  });

  it("以中文单次模式识别并返回整理后的文本与置信度", () => {
    const recognition = fakeRecognition();
    const onStart = vi.fn();
    const onResult = vi.fn();
    const onError = vi.fn();
    const recognizer = new BrowserSpeechRecognizer(() => recognition);
    recognizer.start({ onStart, onResult, onError });

    expect(recognition.lang).toBe("zh-CN");
    expect(recognition.continuous).toBe(false);
    expect(recognition.interimResults).toBe(false);
    expect(recognition.maxAlternatives).toBe(1);
    expect(recognition.start).toHaveBeenCalledOnce();

    recognition.onstart?.();
    recognition.onresult?.({
      resultIndex: 0,
      results: {
        0: { 0: { transcript: " 疾风剑 ", confidence: 0.91 }, length: 1 },
        length: 1,
      },
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith({
      transcript: "疾风剑",
      confidence: 0.91,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("没有识别结果或浏览器报错时返回稳定错误码", () => {
    const ended = fakeRecognition();
    const onEndedError = vi.fn();
    new BrowserSpeechRecognizer(() => ended).start({
      onStart: vi.fn(),
      onResult: vi.fn(),
      onError: onEndedError,
    });
    ended.onend?.();
    expect(onEndedError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "BROWSER_SPEECH_NO_SPEECH" }),
    );

    const denied = fakeRecognition();
    const onDenied = vi.fn();
    new BrowserSpeechRecognizer(() => denied).start({
      onStart: vi.fn(),
      onResult: vi.fn(),
      onError: onDenied,
    });
    denied.onerror?.({ error: "not-allowed" });
    expect(onDenied).toHaveBeenCalledWith(
      expect.objectContaining({ message: "BROWSER_SPEECH_NOT_ALLOWED" }),
    );
  });

  it("停止和取消会传递给浏览器识别实例", () => {
    const recognition = fakeRecognition();
    const recognizer = new BrowserSpeechRecognizer(() => recognition);
    recognizer.start({
      onStart: vi.fn(),
      onResult: vi.fn(),
      onError: vi.fn(),
    });
    recognizer.stop();
    recognizer.abort();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(recognition.abort).toHaveBeenCalledOnce();
  });
});
