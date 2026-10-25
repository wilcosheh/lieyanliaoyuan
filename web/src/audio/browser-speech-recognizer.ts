export type BrowserSpeechResult = {
  transcript: string;
  confidence?: number;
  /** 浏览器识别期间同步采集的原始语音，供技能生效后回放。 */
  audio?: Blob;
};

type RecognitionAlternativeLike = {
  transcript: string;
  confidence: number;
};

type RecognitionResultLike = {
  readonly length: number;
  [index: number]: RecognitionAlternativeLike;
};

type RecognitionEventLike = {
  resultIndex: number;
  results: {
    readonly length: number;
    [index: number]: RecognitionResultLike;
  };
};

type RecognitionErrorEventLike = { error: string };

export type BrowserSpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export type BrowserSpeechRecognitionConstructor = new () =>
  BrowserSpeechRecognitionLike;

type SpeechWindow = Window & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

export function getBrowserSpeechRecognitionConstructor():
  | BrowserSpeechRecognitionConstructor
  | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ??
    speechWindow.webkitSpeechRecognition ?? null;
}

export function supportsBrowserSpeechRecognition(): boolean {
  return getBrowserSpeechRecognitionConstructor() !== null;
}

type RecognitionHandlers = {
  onStart(): void;
  onResult(result: BrowserSpeechResult): void;
  onError(error: Error): void;
};

/** 封装浏览器非标准语音识别 API，避免 UI 直接依赖厂商前缀。 */
export class BrowserSpeechRecognizer {
  private recognition: BrowserSpeechRecognitionLike | null = null;

  constructor(
    private readonly create: () => BrowserSpeechRecognitionLike = () => {
      const Constructor = getBrowserSpeechRecognitionConstructor();
      if (!Constructor) throw new Error("BROWSER_SPEECH_NOT_SUPPORTED");
      return new Constructor();
    },
  ) {}

  start(handlers: RecognitionHandlers): void {
    if (this.recognition) throw new Error("BROWSER_SPEECH_ALREADY_STARTED");
    const recognition = this.create();
    let settled = false;
    this.recognition = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = handlers.onStart;
    recognition.onresult = (event) => {
      if (settled) return;
      const result = event.results[event.resultIndex] ?? event.results[0];
      const alternative = result?.[0];
      const transcript = alternative?.transcript.trim() ?? "";
      if (!transcript) {
        settled = true;
        handlers.onError(new Error("BROWSER_SPEECH_EMPTY_TRANSCRIPT"));
        return;
      }
      settled = true;
      const confidence = alternative.confidence;
      handlers.onResult({
        transcript,
        confidence: Number.isFinite(confidence) &&
            confidence >= 0 && confidence <= 1
          ? confidence
          : undefined,
      });
    };
    recognition.onerror = (event) => {
      if (settled) return;
      settled = true;
      const code = event.error.replaceAll("-", "_").toUpperCase();
      handlers.onError(new Error(`BROWSER_SPEECH_${code}`));
    };
    recognition.onend = () => {
      this.recognition = null;
      if (!settled) {
        settled = true;
        handlers.onError(new Error("BROWSER_SPEECH_NO_SPEECH"));
      }
    };
    try {
      recognition.start();
    } catch (error) {
      this.recognition = null;
      throw error;
    }
  }

  stop(): void {
    this.recognition?.stop();
  }

  abort(): void {
    this.recognition?.abort();
    this.recognition = null;
  }
}
