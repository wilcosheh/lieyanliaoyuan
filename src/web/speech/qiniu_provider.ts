import type {
  SpeechProvider,
  SpeechRecognitionResult,
  SynthesizedSpeech,
} from "./provider.ts";

const DEFAULT_DORA_ASR_URL = "https://yitu-audio.qiniuapi.com/v2/asr";
const JSON_CONTENT_TYPE = "application/json";

export type QiniuSpeechOptions = {
  accessKey: string;
  secretKey: string;
  asrUrl?: string;
  timeoutMs?: number;
  tts?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    defaultVoice?: string;
    path?: string;
  };
};

type DoraAsrPayload = {
  rtn?: unknown;
  message?: unknown;
  requestId?: unknown;
  resultText?: unknown;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_");
}

async function qiniuAuthorization(input: {
  accessKey: string;
  secretKey: string;
  url: string;
  body: string;
}): Promise<string> {
  const url = new URL(input.url);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const signingData =
    `POST ${pathWithQuery}\nHost: ${url.host}\nContent-Type: ${JSON_CONTENT_TYPE}\n\n${input.body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secretKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingData),
  );
  return `Qiniu ${input.accessKey}:${base64Url(new Uint8Array(signature))}`;
}

/** 七牛 Dora 短语音听写适配器，AK/SK 只允许在服务端构造和使用。 */
export class QiniuSpeechProvider implements SpeechProvider {
  private readonly asrUrl: string;

  constructor(
    private readonly options: QiniuSpeechOptions,
    private readonly request: typeof fetch = fetch,
  ) {
    this.asrUrl = options.asrUrl ?? DEFAULT_DORA_ASR_URL;
  }

  async recognize(
    input: { audio: Uint8Array; contentType: string },
  ): Promise<SpeechRecognitionResult> {
    const body = JSON.stringify({
      audioBase64: bytesToBase64(input.audio),
      lang: "MANDARIN",
      scene: "GENERAL",
    });
    const authorization = await qiniuAuthorization({
      accessKey: this.options.accessKey,
      secretKey: this.options.secretKey,
      url: this.asrUrl,
      body,
    });
    const response = await this.fetchWithTimeout(this.asrUrl, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": JSON_CONTENT_TYPE,
      },
      body,
    });
    const payload = await this.parseJson<DoraAsrPayload>(response, "ASR");
    if (payload.rtn !== 0) {
      const code = typeof payload.rtn === "number" ? payload.rtn : "UNKNOWN";
      const message = typeof payload.message === "string"
        ? `: ${payload.message}`
        : "";
      throw new Error(`QINIU_ASR_${code}${message}`);
    }
    const transcript = typeof payload.resultText === "string"
      ? payload.resultText.trim()
      : "";
    if (!transcript) throw new Error("QINIU_ASR_EMPTY_TRANSCRIPT");
    return {
      transcript,
      // Dora 短语音听写不返回置信度，按游戏规则回退为 100%。
      perfection: 100,
      confidenceSource: "fallback",
      providerRequestId: typeof payload.requestId === "string"
        ? payload.requestId
        : undefined,
    };
  }

  async synthesize(
    input: { text: string; voice?: string },
  ): Promise<SynthesizedSpeech> {
    if (!this.options.tts) {
      throw new Error("QINIU_TTS_NOT_CONFIGURED");
    }
    const tts = this.options.tts;
    const url = `${tts.baseUrl.replace(/\/$/, "")}${tts.path ?? "/audio/speech"}`;
    const response = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tts.apiKey}`,
        "Content-Type": JSON_CONTENT_TYPE,
      },
      body: JSON.stringify({
        model: tts.model,
        input: input.text,
        voice: input.voice ?? tts.defaultVoice,
      }),
    });
    if (!response.ok) throw new Error(`QINIU_TTS_${response.status}`);
    return {
      audio: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 15_000,
    );
    try {
      return await this.request(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseJson<T>(
    response: Response,
    operation: string,
  ): Promise<T> {
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`QINIU_${operation}_HTTP_${response.status}: ${body}`);
    }
    return JSON.parse(body) as T;
  }
}
