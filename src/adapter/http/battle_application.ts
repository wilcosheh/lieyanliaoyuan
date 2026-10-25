import type { BattleSessionResponse } from "../../engine/service/session.ts";
import { BattleSessionService } from "../../engine/service/session.ts";
import type { VoiceActionResult, WebBattleView } from "./dto.ts";
import { toWebBattleView } from "./battle_view.ts";
import type {
  SpeechProvider,
  SpeechRecognitionResult,
} from "../../speech/provider.ts";
import { normalizeSkillTranscript } from "../../speech/provider.ts";
import type {
  VoiceCommandRecord,
  WebLobbyRepository,
} from "./lobby/repository.ts";

export class WebApplicationError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly status = 400,
    readonly details?: { transcript?: string },
  ) {
    super(message);
    this.name = "WebApplicationError";
  }
}

type ActionIdentity = {
  battleId: string;
  playerId: string;
  commandId: string;
  roundNo: number;
};

type ClaimedAction = {
  initial: Extract<BattleSessionResponse, { ok: true }>;
  record: VoiceCommandRecord;
};

export class WebBattleApplication {
  constructor(
    private readonly battles: BattleSessionService,
    private readonly lobby: WebLobbyRepository,
    private readonly speech: SpeechProvider,
  ) {}

  async joinMatch(playerId: string, nickname: string) {
    const result = await this.lobby.joinMatch(playerId, nickname);
    if (result.ticket.battleId && result.matchedPlayerIds) {
      const created = await this.battles.createBattle({
        battleId: result.ticket.battleId,
        playerIds: result.matchedPlayerIds,
      });
      if (!created.ok && created.error.code !== "BATTLE_ALREADY_EXISTS") {
        this.throwBattleError(created);
      }
    }
    return result.ticket;
  }

  async getMatch(ticketId: string, playerId: string) {
    const ticket = await this.lobby.getTicket(ticketId, playerId);
    if (!ticket) {
      throw new WebApplicationError("MATCH_TICKET_NOT_FOUND", undefined, 404);
    }
    return ticket;
  }

  async cancelMatch(ticketId: string, playerId: string): Promise<void> {
    if (!await this.lobby.cancelTicket(ticketId, playerId)) {
      throw new WebApplicationError("MATCH_CANNOT_CANCEL", undefined, 409);
    }
  }

  async getBattle(
    battleId: string,
    playerId: string,
    afterSequence = 0,
  ): Promise<WebBattleView> {
    await this.assertMember(battleId, playerId);
    const response = await this.battles.getBattle(battleId);
    if (!response.ok) this.throwBattleError(response);
    return await this.view(response, playerId, afterSequence);
  }

  async selectCharacter(
    battleId: string,
    playerId: string,
    characterId: string,
  ): Promise<WebBattleView> {
    await this.assertMember(battleId, playerId);
    const response = await this.battles.preparePlayer(
      battleId,
      playerId,
      characterId,
    );
    if (!response.ok) this.throwBattleError(response);
    return await this.view(response, playerId);
  }

  async setReady(
    battleId: string,
    playerId: string,
    ready: boolean,
  ): Promise<WebBattleView> {
    await this.assertMember(battleId, playerId);
    let response = await this.battles.setReady(battleId, playerId, ready);
    if (!response.ok) this.throwBattleError(response);
    if (ready && response.state.players.every((player) => player.ready)) {
      const started = await this.battles.startBattle(battleId);
      if (started.ok) response = started;
      else if (started.error.code !== "BATTLE_NOT_PREPARING") {
        this.throwBattleError(started);
      } else {
        const current = await this.battles.getBattle(battleId);
        if (!current.ok) this.throwBattleError(current);
        response = current;
      }
    }
    return await this.view(response, playerId);
  }

  async submitVoiceAction(input: {
    battleId: string;
    playerId: string;
    commandId: string;
    roundNo: number;
    audio: Uint8Array;
    contentType: string;
  }): Promise<VoiceActionResult> {
    const claimed = await this.claimAction(input);
    if ("replay" in claimed) return claimed.replay;
    let recognition: SpeechRecognitionResult;
    try {
      recognition = await this.speech.recognize({
        audio: input.audio,
        contentType: input.contentType,
      });
    } catch (error) {
      const providerMessage = error instanceof Error ? error.message : "";
      const errorCode = providerMessage === "QINIU_SPEECH_NOT_CONFIGURED"
        ? "SPEECH_NOT_CONFIGURED"
        : "ASR_FAILED";
      await this.failCommand(claimed.record, errorCode);
      throw new WebApplicationError(
        errorCode,
        providerMessage || errorCode,
        errorCode === "SPEECH_NOT_CONFIGURED" ? 503 : 502,
      );
    }
    return await this.submitRecognition(input, claimed, recognition);
  }

  async submitRecognizedAction(
    input: ActionIdentity & {
      transcript: string;
      confidence?: number;
    },
  ): Promise<VoiceActionResult> {
    await this.assertMember(input.battleId, input.playerId);
    const transcript = input.transcript.trim();
    if (!transcript || transcript.length > 100) {
      throw new WebApplicationError("INVALID_TRANSCRIPT");
    }
    if (
      input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 ||
        input.confidence > 1)
    ) {
      throw new WebApplicationError("INVALID_CONFIDENCE");
    }
    const claimed = await this.claimAction(input, true);
    if ("replay" in claimed) return claimed.replay;
    return await this.submitRecognition(input, claimed, {
      transcript,
      perfection: input.confidence === undefined
        ? 100
        : Math.round(input.confidence * 100),
      confidenceSource: input.confidence === undefined
        ? "fallback"
        : "provider",
    });
  }

  private async claimAction(
    input: ActionIdentity,
    memberChecked = false,
  ): Promise<ClaimedAction | { replay: VoiceActionResult }> {
    if (!memberChecked) {
      await this.assertMember(input.battleId, input.playerId);
    }
    const existing = await this.lobby.getVoiceCommand(
      input.battleId,
      input.commandId,
    );
    if (existing) {
      return {
        replay: await this.replayVoiceCommand(existing, input.playerId),
      };
    }
    const initial = await this.battles.getBattle(input.battleId);
    if (!initial.ok) this.throwBattleError(initial);
    const actor = initial.state.players.find((player) =>
      player.playerId === input.playerId
    );
    if (
      initial.state.status !== "RUNNING" ||
      initial.state.currentRound?.status !== "WAITING_COMMAND"
    ) {
      throw new WebApplicationError("ROUND_NOT_WAITING", undefined, 409);
    }
    if (initial.state.currentRound.roundNo !== input.roundNo) {
      throw new WebApplicationError("ROUND_MISMATCH", undefined, 409);
    }
    if (!actor || actor.actionState !== "READY") {
      throw new WebApplicationError("ACTION_DISABLED", undefined, 409);
    }

    const claimed = await this.lobby.claimVoiceCommand({
      battleId: input.battleId,
      commandId: input.commandId,
      playerId: input.playerId,
      roundNo: input.roundNo,
    });
    if (!claimed.claimed) {
      return {
        replay: await this.replayVoiceCommand(claimed.record, input.playerId),
      };
    }
    return { initial, record: claimed.record };
  }

  private async submitRecognition(
    input: ActionIdentity,
    claimed: ClaimedAction,
    recognition: SpeechRecognitionResult,
  ): Promise<VoiceActionResult> {
    const skillText = normalizeSkillTranscript(recognition.transcript);
    let record: VoiceCommandRecord = {
      ...claimed.record,
      status: "RECOGNIZED",
      transcript: recognition.transcript,
      perfection: recognition.perfection,
      confidenceSource: recognition.confidenceSource,
    };
    await this.lobby.updateVoiceCommand(record);
    let response = await this.battles.submitAction(input.battleId, {
      playerId: input.playerId,
      commandId: input.commandId,
      roundNo: input.roundNo,
      skillText,
      perfection: recognition.perfection,
    });
    if (!response.ok) {
      await this.failCommand(record, response.error.code);
      this.throwBattleError(
        response,
        response.error.code === "ASR_FAILED"
          ? { transcript: recognition.transcript }
          : undefined,
      );
    }
    const eventCursor = claimed.initial.state.events.at(-1)?.sequence ?? 0;
    response = await this.advanceToInput(response);
    record = { ...record, status: "SUBMITTED" };
    await this.lobby.updateVoiceCommand(record);
    return {
      transcript: recognition.transcript,
      perfection: recognition.perfection,
      confidenceSource: recognition.confidenceSource,
      battle: await this.view(response, input.playerId, eventCursor),
    };
  }

  private async advanceToInput(
    response: Extract<BattleSessionResponse, { ok: true }>,
  ) {
    let current = response;
    for (let step = 0; step < 4; step += 1) {
      const status = current.state.currentRound?.status;
      if (current.state.status !== "RUNNING" || status === "WAITING_COMMAND") {
        return current;
      }
      if (status !== "SETTLING" && status !== "ENDING") return current;
      const advanced = await this.battles.advance(current.state.battleId, {
        expectedVersion: current.version,
      });
      if (!advanced.ok) {
        if (advanced.error.code === "VERSION_CONFLICT") {
          const latest = await this.battles.getBattle(current.state.battleId);
          if (!latest.ok) this.throwBattleError(latest);
          current = latest;
          continue;
        }
        this.throwBattleError(advanced);
      }
      current = advanced;
    }
    return current;
  }

  private async replayVoiceCommand(
    record: VoiceCommandRecord,
    playerId: string,
  ): Promise<VoiceActionResult> {
    if (record.playerId !== playerId) {
      throw new WebApplicationError(
        "COMMAND_ALREADY_PROCESSED",
        undefined,
        409,
      );
    }
    if (
      record.status !== "SUBMITTED" || !record.transcript ||
      record.perfection === null || !record.confidenceSource
    ) {
      throw new WebApplicationError(
        record.errorCode ?? "COMMAND_IN_PROGRESS",
        undefined,
        record.errorCode === "SPEECH_NOT_CONFIGURED" ? 503 : 409,
        record.errorCode === "ASR_FAILED"
          ? { transcript: record.transcript ?? undefined }
          : undefined,
      );
    }
    return {
      transcript: record.transcript,
      perfection: record.perfection,
      confidenceSource: record.confidenceSource,
      battle: await this.getBattle(record.battleId, playerId),
    };
  }

  private async failCommand(
    record: VoiceCommandRecord,
    errorCode: string,
  ): Promise<void> {
    await this.lobby.updateVoiceCommand({
      ...record,
      status: "FAILED",
      errorCode,
    });
  }

  private async assertMember(
    battleId: string,
    playerId: string,
  ): Promise<void> {
    if (!await this.lobby.isBattleMember(battleId, playerId)) {
      throw new WebApplicationError("BATTLE_NOT_FOUND", undefined, 404);
    }
  }

  private async view(
    response: Extract<BattleSessionResponse, { ok: true }>,
    playerId: string,
    afterSequence = 0,
  ) {
    return toWebBattleView({
      state: response.state,
      version: response.version,
      playerId,
      nicknames: await this.lobby.getBattleNicknames(response.state.battleId),
      afterSequence,
    });
  }

  private throwBattleError(
    response: Extract<BattleSessionResponse, { ok: false }>,
    details?: { transcript?: string },
  ): never {
    const status = response.error.code === "BATTLE_NOT_FOUND" ? 404 : 409;
    throw new WebApplicationError(
      response.error.code,
      response.error.message,
      status,
      details,
    );
  }
}
