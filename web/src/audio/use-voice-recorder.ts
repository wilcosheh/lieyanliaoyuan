"use client";

import { useCallback, useReducer, useRef } from "react";
import { type RecorderState, WavRecorder } from "./wav-recorder";

type State = { status: RecorderState; error: string | null };
type Action = { type: "status"; status: RecorderState } | {
  type: "error";
  message: string;
};

function reducer(state: State, action: Action): State {
  if (action.type === "error") {
    return { status: "error", error: action.message };
  }
  return { status: action.status, error: null };
}

export function useVoiceRecorder(onComplete: (audio: Blob) => Promise<void>) {
  const [state, dispatch] = useReducer(reducer, {
    status: "idle",
    error: null,
  });
  const recorder = useRef<WavRecorder | null>(null);

  const start = useCallback(async () => {
    if (state.status !== "idle" && state.status !== "error") return;
    dispatch({ type: "status", status: "requesting" });
    try {
      recorder.current = new WavRecorder();
      await recorder.current.start();
      dispatch({ type: "status", status: "recording" });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "无法使用麦克风",
      });
    }
  }, [state.status]);

  const stop = useCallback(async () => {
    if (state.status !== "recording" || !recorder.current) return;
    dispatch({ type: "status", status: "encoding" });
    try {
      const audio = await recorder.current.stop();
      await onComplete(audio);
      dispatch({ type: "status", status: "idle" });
    } catch (error) {
      dispatch({
        type: "error",
        message: error instanceof Error ? error.message : "语音发送失败",
      });
    }
  }, [onComplete, state.status]);

  return { ...state, start, stop };
}
