import type {
  MatchTicketView,
  VoiceActionResult,
  WebBattleView,
  WebCharacterView,
} from "@core/adapter/http/dto.ts";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: { transcript?: string },
  ) {
    super(message);
  }
}

const errorMessages: Record<string, string> = {
  SPEECH_NOT_CONFIGURED: "语音服务尚未配置",
  ASR_FAILED: "没有识别到有效招式，请重试",
  INVALID_AUDIO: "录音内容无效，请重新录制",
  ROUND_NOT_WAITING: "本回合已经有人完成行动",
  ROUND_MISMATCH: "当前回合已经变化",
  ACTION_DISABLED: "本回合无法行动",
  INVALID_TRANSCRIPT: "没有识别到有效招式，请重试",
  INVALID_CONFIDENCE: "浏览器返回的语音置信度无效",
  INTERNAL_ERROR: "服务端处理失败，请重试",
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/web/v1${path}`, {
    ...init,
    headers: init?.body instanceof FormData
      ? init.headers
      : { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({
      error: { code: "REQUEST_FAILED" },
    }));
    const code = payload.error?.code ?? "REQUEST_FAILED";
    const details = payload.error?.details;
    const transcript = typeof details?.transcript === "string"
      ? details.transcript
      : undefined;
    const message = code === "ASR_FAILED" && transcript
      ? `识别为“${transcript}”，未匹配当前角色的技能`
      : errorMessages[code] ?? payload.error?.message ?? "请求失败";
    throw new ApiError(
      code,
      message,
      response.status,
      details,
    );
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export const webApi = {
  createSession: () =>
    api<{ session: { playerId: string } }>("/sessions", { method: "POST" }),
  characters: async () =>
    (await api<{ characters: WebCharacterView[] }>("/characters")).characters,
  joinMatch: async (nickname: string) =>
    (await api<{ ticket: MatchTicketView }>("/matchmaking/tickets", {
      method: "POST",
      body: JSON.stringify({ nickname }),
    })).ticket,
  getMatch: async (id: string) =>
    (await api<{ ticket: MatchTicketView }>(`/matchmaking/tickets/${id}`))
      .ticket,
  cancelMatch: (id: string) =>
    api<void>(`/matchmaking/tickets/${id}`, { method: "DELETE" }),
  battle: async (id: string) =>
    (await api<{ battle: WebBattleView }>(`/battles/${id}`)).battle,
  selectCharacter: async (id: string, characterId: string) =>
    (await api<{ battle: WebBattleView }>(`/battles/${id}/character`, {
      method: "POST",
      body: JSON.stringify({ characterId }),
    })).battle,
  ready: async (id: string, ready: boolean) =>
    (await api<{ battle: WebBattleView }>(`/battles/${id}/ready`, {
      method: "POST",
      body: JSON.stringify({ ready }),
    })).battle,
  voice: async (
    id: string,
    commandId: string,
    roundNo: number,
    audio: Blob,
  ) => {
    const form = new FormData();
    form.set("commandId", commandId);
    form.set("roundNo", String(roundNo));
    form.set("audio", audio, "command.wav");
    return (await api<{ action: VoiceActionResult }>(
      `/battles/${id}/actions/voice`,
      { method: "POST", body: form },
    )).action;
  },
  recognized: async (
    id: string,
    commandId: string,
    roundNo: number,
    transcript: string,
    confidence?: number,
  ) =>
    (await api<{ action: VoiceActionResult }>(
      `/battles/${id}/actions/recognized`,
      {
        method: "POST",
        body: JSON.stringify({ commandId, roundNo, transcript, confidence }),
      },
    )).action,
};
