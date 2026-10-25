import { CHARACTERS } from "../characters/skills.ts";
import type { BattleEvent, BattleState } from "../rules/state.ts";

export function narrateEvent(event: BattleEvent, state: BattleState): string {
  const player = state.players.find((item) => item.playerId === event.playerId);
  const character = CHARACTERS.find((item) => item.id === player?.characterId);
  const skill = character?.skills.find((item) => item.id === event.skillId);
  switch (event.type) {
    case "ACTION_ACCEPTED":
      return `${character?.name ?? "挑战者"}发动${skill?.name ?? "技能"}`;
    case "DAMAGE_APPLIED":
      return `造成${Number(event.payload.hpDamage ?? 0)}点伤害`;
    case "HEAL_APPLIED":
      return `恢复${Number(event.payload.amount ?? 0)}点生命`;
    case "SHIELD_APPLIED":
      return `获得${Number(event.payload.amount ?? 0)}点护盾`;
    case "ROUND_STARTED":
      return `第${event.roundNo ?? "新"}回合开始`;
    case "BATTLE_FINISHED":
      return "对局结束";
    default:
      return "战局发生变化";
  }
}
