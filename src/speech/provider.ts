export type SpeechRecognitionResult = {
  transcript: string;
  perfection: number;
  providerRequestId?: string;
  confidenceSource: "provider" | "fallback";
};

export type SynthesizedSpeech = {
  audio: Uint8Array;
  contentType: string;
};

export interface SpeechProvider {
  recognize(input: {
    audio: Uint8Array;
    contentType: string;
  }): Promise<SpeechRecognitionResult>;

  synthesize(input: {
    text: string;
    voice?: string;
  }): Promise<SynthesizedSpeech>;
}

/**
 * 清理语音识别服务可能自动插入的空白和首尾标点。
 * 此处不做同音字、近似文本或别名匹配，清理后仍由战斗核心精确匹配技能名。
 */
export function normalizeSkillTranscript(transcript: string): string {
  return transcript.trim().replace(/\s+/gu, "").replace(
    /^\p{P}+|\p{P}+$/gu,
    "",
  );
}

/** 测试与本地演示使用，生产环境不应使用客户端提供的转写结果。 */
export class FakeSpeechProvider implements SpeechProvider {
  readonly recognitionCalls: Uint8Array[] = [];

  constructor(
    private readonly result: SpeechRecognitionResult = {
      transcript: "疾风剑",
      perfection: 100,
      confidenceSource: "fallback",
    },
  ) {}

  recognize(input: { audio: Uint8Array }): Promise<SpeechRecognitionResult> {
    this.recognitionCalls.push(input.audio.slice());
    return Promise.resolve(structuredClone(this.result));
  }

  synthesize(input: { text: string }): Promise<SynthesizedSpeech> {
    return Promise.resolve({
      audio: new TextEncoder().encode(input.text),
      contentType: "audio/mpeg",
    });
  }
}
