"use client";

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  BrowserSpeechRecognizer,
  type BrowserSpeechResult,
  supportsBrowserSpeechRecognition,
} from "./browser-speech-recognizer";
import { WavRecorder, type RecorderState } from "./wav-recorder";

type State = { status: RecorderState; error: string | null };
type Action = { type: "status"; status: RecorderState } | {
  type: "error";
  message: string;
};

const errorMessages: Record<string, string> = {
  BROWSER_SPEECH_NOT_SUPPORTED: "当前浏览器不支持语音识别",
  BROWSER_SPEECH_NOT_ALLOWED: "请允许浏览器使用麦克风",
  BROWSER_SPEECH_SERVICE_NOT_ALLOWED: "浏览器语音识别服务不可用",
  BROWSER_SPEECH_AUDIO_CAPTURE: "没有检测到可用麦克风",
  BROWSER_SPEECH_NETWORK: "浏览器语音识别网络异常",
  BROWSER_SPEECH_NO_SPEECH: "没有识别到语音，请重试",
  BROWSER_SPEECH_EMPTY_TRANSCRIPT: "没有识别到有效招式，请重试",
};

function reducer(state: State, action: Action): State {
  if (action.type === "error") {
    return { status: "error", error: action.message };
  }
  return { status: action.status, error: null };
}

export function browserSpeechErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (errorMessages[code]) return errorMessages[code];
  if (code.startsWith("BROWSER_SPEECH_")) return "浏览器语音识别失败";
  return code || "浏览器语音识别失败";
}

const subscribeToBrowserSupport = () => () => {};
const browserSupportServerSnapshot = () => null;

export function useBrowserSpeechRecognition(
  onComplete: (result: BrowserSpeechResult) => Promise<void>,
) {
  const [state, dispatch] = useReducer(reducer, {
    status: "idle",
    error: null,
  });
  const supported = useSyncExternalStore(
    subscribeToBrowserSupport,
    supportsBrowserSpeechRecognition,
    browserSupportServerSnapshot,
  );
  const recognizer = useRef<BrowserSpeechRecognizer | null>(null);
  const audioRecorder = useRef<WavRecorder | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recognizer.current?.abort();
      recognizer.current = null;
      void audioRecorder.current?.stop().catch(() => undefined);
      audioRecorder.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (state.status !== "idle" && state.status !== "error") return;
    if (!supportsBrowserSpeechRecognition()) {
      dispatch({ type: "error", message: errorMessages.BROWSER_SPEECH_NOT_SUPPORTED });
      return;
    }
    dispatch({ type: "status", status: "requesting" });
    try {
      // Web Speech API 不提供原始音频，因此并行采集一份 WAV 用于成功后的回放。
      const recorder = new WavRecorder();
      try {
        await recorder.start();
        audioRecorder.current = recorder;
      } catch {
        // 录音采集失败不阻断浏览器识别，仍允许完成行动提交。
        audioRecorder.current = null;
      }
      const controller = new BrowserSpeechRecognizer();
      recognizer.current = controller;
      controller.start({
        onStart: () => {
          if (mounted.current) {
            dispatch({ type: "status", status: "recording" });
          }
        },
        onResult: (result) => {
          if (mounted.current) {
            dispatch({ type: "status", status: "encoding" });
          }
          void (async () => {
            let audio: Blob | undefined;
            const recorder = audioRecorder.current;
            audioRecorder.current = null;
            if (recorder) {
              try {
                audio = await recorder.stop();
              } catch {
                audio = undefined;
              }
            }
            return await onComplete({ ...result, audio });
          })().then(
            () => {
              recognizer.current = null;
              if (mounted.current) dispatch({ type: "status", status: "idle" });
            },
            (error) => {
              recognizer.current = null;
              if (mounted.current) {
                dispatch({
                  type: "error",
                  message: browserSpeechErrorMessage(error),
                });
              }
            },
          );
        },
        onError: (error) => {
          const recorder = audioRecorder.current;
          audioRecorder.current = null;
          void recorder?.stop().catch(() => undefined);
          recognizer.current = null;
          if (mounted.current) {
            dispatch({
              type: "error",
              message: browserSpeechErrorMessage(error),
            });
          }
        },
      });
    } catch (error) {
      const recorder = audioRecorder.current;
      audioRecorder.current = null;
      void recorder?.stop().catch(() => undefined);
      recognizer.current = null;
      dispatch({
        type: "error",
        message: browserSpeechErrorMessage(error),
      });
    }
  }, [onComplete, state.status]);

  const stop = useCallback(() => {
    if (state.status !== "requesting" && state.status !== "recording") return;
    dispatch({ type: "status", status: "encoding" });
    recognizer.current?.stop();
  }, [state.status]);

  return { ...state, supported, start, stop };
}
