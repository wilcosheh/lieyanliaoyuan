import { describe, expect, it } from "vitest";
import { WebBattleApplication } from "../../src/adapter/http/battle_application.ts";
import { InMemoryWebLobbyRepository } from "../../src/adapter/http/lobby/repository.ts";
import { BattleSessionService } from "../../src/engine/service/session.ts";
import { InMemoryBattleRepository } from "../../src/engine/store/repository.ts";
import type {
  SpeechProvider,
  SpeechRecognitionResult,
} from "../../src/speech/provider.ts";

class QueueSpeechProvider implements SpeechProvider {
  calls = 0;
  constructor(
    private readonly results: Array<SpeechRecognitionResult | Error>,
  ) {}
  recognize(): Promise<SpeechRecognitionResult> {
    const value = this
      .results[Math.min(this.calls++, this.results.length - 1)]!;
    return value instanceof Error
      ? Promise.reject(value)
      : Promise.resolve(value);
  }
  synthesize() {
    return Promise.resolve({
      audio: new Uint8Array([1]),
      contentType: "audio/mpeg",
    });
  }
}

class OneHpBattleSessionService extends BattleSessionService {
  override createBattle(
    input: Parameters<BattleSessionService["createBattle"]>[0],
  ) {
    return super.createBattle({
      ...input,
      options: { ...input.options, maxHp: 1 },
    });
  }
}

async function setup(provider: SpeechProvider, bothCharacter = "swordsman") {
  const repository = new InMemoryBattleRepository();
  const battles = new BattleSessionService(repository);
  const lobby = new InMemoryWebLobbyRepository();
  const app = new WebBattleApplication(battles, lobby, provider);
  const first = await app.joinMatch("player-a", "甲");
  const second = await app.joinMatch("player-b", "乙");
  const firstMatched = await app.getMatch(first.id, "player-a");
  const battleId = second.battleId!;
  expect(firstMatched.battleId).toBe(battleId);
  await app.selectCharacter(battleId, "player-a", bothCharacter);
  await app.selectCharacter(battleId, "player-b", bothCharacter);
  await app.setReady(battleId, "player-a", true);
  const started = await app.setReady(battleId, "player-b", true);
  expect(started.status).toBe("RUNNING");
  return { app, battles, lobby, battleId };
}

const perfect = (transcript = "疾风剑"): SpeechRecognitionResult => ({
  transcript,
  perfection: 90,
  confidenceSource: "provider",
});

describe("WebBattleApplication", () => {
  it("由 ASR 结果发动技能并自动推进到下一回合", async () => {
    const speech = new QueueSpeechProvider([perfect()]);
    const { app, battleId } = await setup(speech);
    const result = await app.submitVoiceAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      audio: new Uint8Array([1, 2]),
      contentType: "audio/wav",
    });
    expect(result.transcript).toBe("疾风剑");
    expect(result.perfection).toBe(90);
    expect(result.battle.roundNo).toBe(2);
    expect(result.battle.roundStatus).toBe("WAITING_COMMAND");
    expect(result.battle.opponent.hp).toBe(941);
    expect(
      result.battle.events.some((event) => event.type === "DAMAGE_APPLIED"),
    ).toBe(true);
  });

  it("清理浏览器识别的空格和句末标点并在服务端换算完美度", async () => {
    const speech = new QueueSpeechProvider([perfect()]);
    const { app, battleId } = await setup(speech);
    const result = await app.submitRecognizedAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      transcript: " 疾 风 剑。 ",
      confidence: 0.9,
    });
    expect(result.transcript).toBe("疾 风 剑。");
    expect(result.perfection).toBe(90);
    expect(result.confidenceSource).toBe("provider");
    expect(result.battle.roundNo).toBe(2);
    expect(result.battle.opponent.hp).toBe(941);
    expect(speech.calls).toBe(0);
  });

  it("同音错字仍拒绝并返回实际识别文本", async () => {
    const speech = new QueueSpeechProvider([perfect()]);
    const { app, battleId } = await setup(speech);
    await expect(app.submitRecognizedAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      transcript: "疾风箭。",
      confidence: 0.9,
    })).rejects.toMatchObject({
      code: "ASR_FAILED",
      details: { transcript: "疾风箭。" },
    });
    expect((await app.getBattle(battleId, "player-a")).roundNo).toBe(1);
  });

  it("浏览器未提供置信度时回退到百分百且拒绝越界值", async () => {
    const speech = new QueueSpeechProvider([perfect()]);
    const { app, battleId } = await setup(speech);
    await expect(app.submitRecognizedAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      transcript: "疾风剑",
      confidence: 1.01,
    })).rejects.toMatchObject({ code: "INVALID_CONFIDENCE" });
    const result = await app.submitRecognizedAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      transcript: "疾风剑",
    });
    expect(result.perfection).toBe(100);
    expect(result.confidenceSource).toBe("fallback");
    expect(result.battle.opponent.hp).toBe(935);
    expect(speech.calls).toBe(0);
  });

  it("相同 commandId 重试不重复调用 ASR 或结算", async () => {
    const speech = new QueueSpeechProvider([perfect()]);
    const { app, battleId } = await setup(speech);
    const commandId = crypto.randomUUID();
    const input = {
      battleId,
      playerId: "player-a",
      commandId,
      roundNo: 1,
      audio: new Uint8Array([1]),
      contentType: "audio/wav",
    };
    const first = await app.submitVoiceAction(input);
    const replay = await app.submitVoiceAction(input);
    expect(replay.transcript).toBe(first.transcript);
    expect(replay.battle.opponent.hp).toBe(first.battle.opponent.hp);
    expect(speech.calls).toBe(1);
  });

  it("ASR 失败不消耗回合，重复命令也不重复收费", async () => {
    const speech = new QueueSpeechProvider([new Error("provider timeout")]);
    const { app, battleId } = await setup(speech);
    const input = {
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      audio: new Uint8Array([1]),
      contentType: "audio/wav",
    };
    await expect(app.submitVoiceAction(input)).rejects.toMatchObject({
      code: "ASR_FAILED",
    });
    await expect(app.submitVoiceAction(input)).rejects.toMatchObject({
      code: "ASR_FAILED",
    });
    expect(speech.calls).toBe(1);
    expect((await app.getBattle(battleId, "player-a")).roundNo).toBe(1);
  });

  it("语音服务未配置时返回可识别的 503 错误", async () => {
    const speech = new QueueSpeechProvider([
      new Error("QINIU_SPEECH_NOT_CONFIGURED"),
    ]);
    const { app, battleId } = await setup(speech);
    const input = {
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      audio: new Uint8Array([1]),
      contentType: "audio/wav",
    };
    await expect(app.submitVoiceAction(input)).rejects.toMatchObject({
      code: "SPEECH_NOT_CONFIGURED",
      status: 503,
    });
    await expect(app.submitVoiceAction(input)).rejects.toMatchObject({
      code: "SPEECH_NOT_CONFIGURED",
      status: 503,
    });
    expect(speech.calls).toBe(1);
    expect((await app.getBattle(battleId, "player-a")).roundNo).toBe(1);
  });

  it("两名玩家并发出招时只有一个请求成功", async () => {
    const speech = new QueueSpeechProvider([perfect(), perfect()]);
    const { app, battleId } = await setup(speech);
    const action = (playerId: string) =>
      app.submitVoiceAction({
        battleId,
        playerId,
        commandId: crypto.randomUUID(),
        roundNo: 1,
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      });
    const outcomes = await Promise.allSettled([
      action("player-a"),
      action("player-b"),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected"))
      .toHaveLength(1);
    expect((await app.getBattle(battleId, "player-a")).roundNo).toBe(2);
  });

  it("拒绝非成员读取或修改其他对局", async () => {
    const { app, battleId } = await setup(new QueueSpeechProvider([perfect()]));
    await expect(app.getBattle(battleId, "intruder")).rejects.toEqual(
      expect.objectContaining({ code: "BATTLE_NOT_FOUND", status: 404 }),
    );
  });

  it("只在双方准备后启动，并支持取消等待中的匹配", async () => {
    const app = new WebBattleApplication(
      new BattleSessionService(new InMemoryBattleRepository()),
      new InMemoryWebLobbyRepository(),
      new QueueSpeechProvider([perfect()]),
    );
    const ticket = await app.joinMatch("single", "独行者");
    expect((await app.getMatch(ticket.id, "single")).status).toBe("WAITING");
    await app.cancelMatch(ticket.id, "single");
    expect((await app.getMatch(ticket.id, "single")).status).toBe("CANCELLED");
    await expect(app.cancelMatch(ticket.id, "single")).rejects.toMatchObject({
      code: "MATCH_CANNOT_CANCEL",
    });
  });

  it("结束对局后再次匹配不会复用旧对局", async () => {
    const battles = new OneHpBattleSessionService(
      new InMemoryBattleRepository(),
    );
    const lobby = new InMemoryWebLobbyRepository();
    const app = new WebBattleApplication(
      battles,
      lobby,
      new QueueSpeechProvider([perfect()]),
    );
    await app.joinMatch("player-a", "甲");
    const second = await app.joinMatch("player-b", "乙");
    const battleId = second.battleId!;
    await app.selectCharacter(battleId, "player-a", "swordsman");
    await app.selectCharacter(battleId, "player-b", "swordsman");
    await app.setReady(battleId, "player-a", true);
    await app.setReady(battleId, "player-b", true);
    const finished = await app.submitRecognizedAction({
      battleId,
      playerId: "player-a",
      commandId: crypto.randomUUID(),
      roundNo: 1,
      transcript: "疾风剑",
    });
    expect(finished.battle.status).toBe("FINISHED");

    const waiting = await app.joinMatch("player-a", "甲-新局");
    expect(waiting.status).toBe("WAITING");
    const rematch = await app.joinMatch("player-b", "乙-新局");
    expect(rematch.status).toBe("MATCHED");
    expect(rematch.battleId).not.toBe(battleId);
  });
});
