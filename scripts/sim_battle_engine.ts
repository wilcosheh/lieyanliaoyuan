import {
  type BattleEvent,
  type BattleSessionResponse,
  BattleSessionService,
  InMemoryBattleRepository,
} from "../src/battle/index.ts";

function requireSuccess<T>(
  response: BattleSessionResponse<T>,
  operation: string,
): asserts response is Extract<BattleSessionResponse<T>, { ok: true }> {
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.error.code}`);
  }
}

function eventSummary(events: BattleEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "DAMAGE_APPLIED") {
      parts.push(
        `伤害 ${String(event.payload.amount)}（护盾吸收 ${
          String(event.payload.absorbed)
        }）`,
      );
    }
    if (event.type === "STATUS_APPLIED") {
      const status = event.payload.status as { tag?: string } | undefined;
      if (status?.tag) parts.push(`附加 ${status.tag}`);
    }
    if (event.type === "STATUS_TICK") {
      parts.push(
        `${String(event.payload.tag)} 结算 ${String(event.payload.value)}`,
      );
    }
    if (event.type === "STATUS_EXPIRED") {
      parts.push(`${String(event.payload.tag)} 结束`);
    }
    if (event.type === "BATTLE_FINISHED") {
      parts.push(`对局结束：${String(event.payload.reason)}`);
    }
  }
  return parts.length > 0 ? parts.join("，") : "无额外效果";
}

const battleId = "simulation-001";
const repository = new InMemoryBattleRepository();
const deviceA = new BattleSessionService(repository);
const deviceB = new BattleSessionService(repository);

requireSuccess(
  await deviceA.createBattle({
    battleId,
    playerIds: ["player-a", "player-b"],
    options: {
      maxHp: 500,
      maxShield: 300,
    },
  }),
  "创建对局",
);

requireSuccess(
  await deviceA.preparePlayer(battleId, "player-a", "swordsman"),
  "player-a 选择剑士",
);
requireSuccess(
  await deviceB.preparePlayer(battleId, "player-b", "archer"),
  "player-b 选择弓箭手",
);
requireSuccess(await deviceA.setReady(battleId, "player-a"), "player-a 准备");
requireSuccess(await deviceB.setReady(battleId, "player-b"), "player-b 准备");
requireSuccess(await deviceA.startBattle(battleId), "开始对局");

const plannedActions = [
  ["player-a", "战意燃锋诀"],
  ["player-b", "毒雨连射阵"],
  ["player-a", "血刃追魂印"],
  ["player-b", "蚀心削势矢"],
  ["player-a", "焚天裂空万刃归一"],
  ["player-b", "寒星封行九霄长矢"],
  ["player-b", "裂风短矢"],
  ["player-a", "裂甲连环斩"],
  ["player-b", "毒雨连射阵"],
  ["player-a", "破风斩"],
  ["player-b", "疾风箭"],
  ["player-a", "破风斩"],
  ["player-b", "疾风箭"],
  ["player-a", "破风斩"],
] as const;

console.log("对局开始：player-a 烈焰剑士 vs player-b 风行弓手");

for (const [playerId, skillText] of plannedActions) {
  const beforeResponse = await deviceA.getBattle(battleId);
  requireSuccess(beforeResponse, "读取对局");
  const before = beforeResponse.state;
  if (before.status !== "RUNNING" || !before.currentRound) break;
  const roundNo = before.currentRound.roundNo;
  const commandId = `round-${roundNo}-${playerId}`;
  const actingDevice = playerId === "player-a" ? deviceA : deviceB;

  const accepted = await actingDevice.submitAction(battleId, {
    playerId,
    commandId,
    roundNo,
    skillText,
  });
  requireSuccess(accepted, `第 ${roundNo} 回合 ${skillText}`);
  if (accepted.state.currentRound?.status !== "SETTLING") {
    throw new Error(`round ${roundNo} did not enter SETTLING`);
  }

  const battlePhase = await deviceA.advance(battleId, {
    expectedVersion: accepted.version,
  });
  requireSuccess(battlePhase, `第 ${roundNo} 回合战斗阶段`);
  const afterBattle = battlePhase.state;
  const a = afterBattle.players.find((player) =>
    player.playerId === "player-a"
  )!;
  const b = afterBattle.players.find((player) =>
    player.playerId === "player-b"
  )!;
  console.log(
    `回合 ${roundNo}：${playerId} 使用「${skillText}」；${
      eventSummary(battlePhase.events)
    }；A=${a.hp}/${a.shield} B=${b.hp}/${b.shield}`,
  );

  if (afterBattle.status === "FINISHED") break;
  if (afterBattle.currentRound?.status !== "ENDING") {
    throw new Error(`round ${roundNo} did not enter ENDING`);
  }

  const endPhase = await deviceB.advance(battleId, {
    expectedVersion: battlePhase.version,
  });
  requireSuccess(endPhase, `第 ${roundNo} 回合结束阶段`);
  const afterEnd = endPhase.state;
  const endA = afterEnd.players.find((player) =>
    player.playerId === "player-a"
  )!;
  const endB = afterEnd.players.find((player) =>
    player.playerId === "player-b"
  )!;
  console.log(
    `回合 ${roundNo} 结束：${
      eventSummary(endPhase.events)
    }；A=${endA.hp}/${endA.shield} B=${endB.hp}/${endB.shield}`,
  );

  if (afterEnd.status === "FINISHED") break;
}

const finalResponse = await deviceB.getBattle(battleId);
requireSuccess(finalResponse, "读取最终对局");
const finalState = finalResponse.state;
if (finalState.status !== "FINISHED") {
  throw new Error(
    `simulation did not finish, current status: ${finalState.status}`,
  );
}

console.log({
  result: "simulation complete",
  rounds: finalState.currentRound?.roundNo,
  winnerPlayerId: finalState.winnerPlayerId,
  loserPlayerId: finalState.loserPlayerId,
  finalPlayers: finalState.players.map((player) => ({
    playerId: player.playerId,
    characterId: player.characterId,
    hp: player.hp,
    shield: player.shield,
    alive: player.alive,
  })),
  eventCount: finalState.events.length,
});
