import {
  CHARACTERS,
  type SkillConfig,
} from "../../engine/characters/skills.ts";
import type {
  BattleState,
  PlayerBattleState,
} from "../../engine/rules/state.ts";
import type { WebBattleView, WebPlayerView, WebSkillView } from "./dto.ts";

const unavailableMessages: Record<string, string> = {
  battle: "对局尚未进入行动阶段",
  action: "本回合无法行动",
  once: "本局已使用",
  basic: "基础技能不能连续使用",
  gap: "尚未达到再次使用的回合间隔",
};

function playerView(
  player: PlayerBattleState,
  nicknames: Record<string, string>,
): WebPlayerView {
  const character = CHARACTERS.find((item) => item.id === player.characterId);
  return {
    playerId: player.playerId,
    nickname: nicknames[player.playerId] ?? "挑战者",
    characterId: player.characterId,
    characterName: character?.name ?? null,
    ready: player.ready,
    hp: player.hp,
    maxHp: player.maxHp,
    shield: player.shield,
    maxShield: player.maxShield,
    alive: player.alive,
    actionDisabled: player.actionState === "ACTION_DISABLED",
    statuses: structuredClone(player.statusEffects),
  };
}

function skillView(
  state: BattleState,
  player: PlayerBattleState,
  skill: SkillConfig,
): WebSkillView {
  const used = player.skillUsage[skill.id] ?? 0;
  const roundNo = state.currentRound?.roundNo ?? 0;
  const lastRound = player.skillLastUsedRound[skill.id];
  let reason: string | null = null;
  if (
    state.status !== "RUNNING" ||
    state.currentRound?.status !== "WAITING_COMMAND"
  ) reason = unavailableMessages.battle;
  else if (player.actionState === "ACTION_DISABLED") {
    reason = unavailableMessages.action;
  } else if (skill.maxUsesPerMatch !== null && used >= skill.maxUsesPerMatch) {
    reason = unavailableMessages.once;
  } else if (
    skill.reuseRule === "BASIC_NON_CONSECUTIVE" && lastRound === roundNo - 1
  ) reason = unavailableMessages.basic;
  else if (lastRound !== undefined && roundNo - lastRound < skill.minRoundGap) {
    reason = unavailableMessages.gap;
  }
  return {
    id: skill.id,
    name: skill.name,
    phraseLengthTier: skill.phraseLengthTier,
    effects: structuredClone(skill.effects),
    used,
    remainingUses: skill.maxUsesPerMatch === null
      ? null
      : Math.max(0, skill.maxUsesPerMatch - used),
    available: reason === null,
    unavailableReason: reason,
  };
}

export function toWebBattleView(input: {
  state: BattleState;
  version: number;
  playerId: string;
  nicknames?: Record<string, string>;
  afterSequence?: number;
}): WebBattleView {
  const self = input.state.players.find((player) =>
    player.playerId === input.playerId
  );
  const opponent = input.state.players.find((player) =>
    player.playerId !== input.playerId
  );
  if (!self || !opponent) throw new Error("PLAYER_NOT_IN_BATTLE");
  const character = CHARACTERS.find((item) => item.id === self.characterId);
  const cursor = input.afterSequence ?? 0;
  return {
    battleId: input.state.battleId,
    version: input.version,
    status: input.state.status,
    roundNo: input.state.currentRound?.roundNo ?? null,
    roundStatus: input.state.currentRound?.status ?? null,
    self: playerView(self, input.nicknames ?? {}),
    opponent: playerView(opponent, input.nicknames ?? {}),
    skills:
      character?.skills.map((skill) => skillView(input.state, self, skill)) ??
        [],
    events: input.state.events.filter((event) => event.sequence > cursor).map((
      event,
    ) => structuredClone(event)),
    latestSequence: input.state.events.at(-1)?.sequence ?? 0,
    winnerPlayerId: input.state.winnerPlayerId,
  };
}
