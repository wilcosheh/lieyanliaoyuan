import { describe, expect, it, vi } from "vitest";
import { QiniuSpeechProvider } from "../../src/speech/qiniu_provider.ts";

function provider(
  request: typeof fetch,
  options: ConstructorParameters<typeof QiniuSpeechProvider>[0] = {
    accessKey: "access",
    secretKey: "secret",
  },
) {
  return new QiniuSpeechProvider(options, request);
}

describe("QiniuSpeechProvider", () => {
  it("使用 QiniuToken 签名向 Dora 提交 Base64 音频", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        rtn: 0,
        message: "success",
        requestId: "req",
        resultText: "疾风剑",
      })),
    );
    const result = await provider(request).recognize({
      audio: new Uint8Array([1]),
      contentType: "audio/wav",
    });

    expect(result).toEqual({
      transcript: "疾风剑",
      perfection: 100,
      confidenceSource: "fallback",
      providerRequestId: "req",
    });
    expect(request).toHaveBeenCalledWith(
      "https://yitu-audio.qiniuapi.com/v2/asr",
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0]![1]!;
    expect(init.headers).toEqual({
      Authorization: "Qiniu access:cuwquBgqLjxLRvA3bTPPskTg9Nk=",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      audioBase64: "AQ==",
      lang: "MANDARIN",
      scene: "GENERAL",
    });
  });

  it("拒绝 Dora 业务错误和空转写", async () => {
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ rtn: 4204, message: "bad audio" })),
    );
    await expect(
      provider(rejected).recognize({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      }),
    ).rejects.toThrow("QINIU_ASR_4204: bad audio");

    const empty = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ rtn: 0, resultText: " " })),
    );
    await expect(
      provider(empty).recognize({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      }),
    ).rejects.toThrow("QINIU_ASR_EMPTY_TRANSCRIPT");
  });

  it("将 Dora HTTP 错误转为明确异常", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("denied", { status: 401 }),
    );
    await expect(
      provider(request).recognize({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      }),
    ).rejects.toThrow("QINIU_ASR_HTTP_401");
  });

  it("ASR 可独立配置，TTS 未配置时返回明确异常", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      provider(request).synthesize({ text: "战斗开始" }),
    ).rejects.toThrow("QINIU_TTS_NOT_CONFIGURED");
    expect(request).not.toHaveBeenCalled();
  });

  it("保留可选的服务端 TTS 适配能力", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([4, 5]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
    const speech = await provider(request, {
      accessKey: "access",
      secretKey: "secret",
      tts: {
        baseUrl: "https://tts.example.test/v1/",
        apiKey: "tts-secret",
        model: "tts-model",
        defaultVoice: "voice",
      },
    }).synthesize({ text: "战斗开始" });
    expect([...speech.audio]).toEqual([4, 5]);
    expect(speech.contentType).toBe("audio/mpeg");
    expect(request).toHaveBeenCalledWith(
      "https://tts.example.test/v1/audio/speech",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
