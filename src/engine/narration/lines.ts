import type { SkillConfig } from "../characters/skills.ts";

export const CHARACTER_LIST = "烈焰剑士、圣光守卫、暗影术士、风行弓手";

export const ENTRANCE =
  `说角色名开始。可选${CHARACTER_LIST}。可以练技能，对电脑，或开房间。两个人在旁边就说两个人。`;

export function unknownCharacterSay(): string {
  return `没有这个角色。可选${CHARACTER_LIST}。`;
}

export const COUNTDOWN_SAY = "三。二。一。";

export function practiceIntroSay(names: string[]): string {
  if (names.length === 0) return "先说角色名。";
  return `${names.join("、")}。直接念技能名练习。`;
}

export function rejectionSay(code: string): string {
  switch (code) {
    case "ASR_FAILED":
      return "咒语没成。";
    case "AMBIGUOUS_SKILL":
      return "一次一道。";
    case "SKILL_EXHAUSTED":
      return "这招已经用过。";
    case "BASIC_CONSECUTIVE_REJECTED":
      return "这招不能连着念。";
    case "REUSE_LIMIT_REJECTED":
      return "这招还不能再用。";
    case "ACTION_DISABLED":
      return "这回合你不能行动。";
    case "CHARACTER_REQUIRED":
    case "CHARACTER_NOT_SELECTED":
      return "先说角色名。";
    case "CHARACTER_NOT_OWNED":
      return `还没有这个角色。${CHARACTER_LIST}。`;
    case "ROOM_NOT_FOUND":
      return "没有这个房间。";
    case "ROOM_TERMINAL_MISMATCH":
      return "这个房间进不去。";
    case "ROUND_NOT_OPEN":
      return "还不能开口。";
    case "ROUND_CLOSED":
      return "这回合过了。";
    case "CAST_INTERRUPTED":
      return "吟唱被打断。";
    case "PHASE_REJECTED":
      return "现在还不能念。";
    case "BATTLE_ABORTED":
      return "这局中断了。";
    default:
      return "";
  }
}

export function roomSay(code: string): string {
  return `房间号 ${code.split("").join("、")}。把号码告诉对手。等对手加入。`;
}

export function practiceSay(skill: SkillConfig, perfection: number): string {
  const effect = skill.effects[0];
  let detail = "已记下。";
  if (effect?.type === "DAMAGE") {
    detail = `造成${Math.round(effect.amount * perfection / 100)}点伤害。`;
  } else if (effect?.type === "HEAL") {
    detail = `恢复${effect.amount}点生命。`;
  } else if (effect?.type === "SHIELD") {
    detail = `获得${effect.amount}点护盾。`;
  }
  return `完成度${perfection}。${skill.name}。${detail}`;
}

export function skillListSay(names: string[]): string {
  if (names.length === 0) return "这回合你不能行动。";
  return `${names.join("、")}。`;
}

export function statusSay(input: {
  youLabel: string;
  oppLabel: string;
  youHp: number;
  oppHp: number;
  youShield: number;
  oppShield: number;
  canSpeak: boolean;
  disabled: boolean;
}): string {
  const lead = input.youHp === input.oppHp
    ? ""
    : input.youHp > input.oppHp
    ? `${input.youLabel}领先。`
    : `${input.youLabel}落后。`;
  const shield = input.youShield > 0 || input.oppShield > 0
    ? `${input.youLabel}护盾${input.youShield}。${input.oppLabel}护盾${input.oppShield}。`
    : "";
  const tail = input.disabled
    ? "这回合你不能行动。"
    : input.canSpeak
    ? "可以念了。"
    : "还不能开口。";
  return `${lead}${input.youLabel}${input.youHp}血。${input.oppLabel}${input.oppHp}血。${shield}${tail}`;
}

export function outcomeSay(input: {
  skill: string;
  self: boolean;
  youHp: number;
  oppHp: number;
  youShield?: number;
  oppShield?: number;
  interrupted: boolean;
  finished: boolean;
  win: boolean;
}): string {
  if (input.finished) {
    const head = input.win ? "你赢了。" : "你输了。";
    const prefix = input.interrupted ? "吟唱被打断。" : "";
    return `${prefix}${head}你${input.youHp}血。对手${input.oppHp}血。说再来一局，或复盘。`;
  }
  const hit = input.self ? `${input.skill}命中。` : `中了${input.skill}。`;
  const prefix = input.interrupted ? "吟唱被打断。" : "";
  const youShield = input.youShield && input.youShield > 0
    ? `护盾${input.youShield}。`
    : "";
  const oppShield = input.oppShield && input.oppShield > 0
    ? `对手护盾${input.oppShield}。`
    : "";
  return `${prefix}${hit}你${input.youHp}血。${youShield}对手${input.oppHp}血。${oppShield}`;
}

export function openingSay(youHp: number, oppHp: number): string {
  if (youHp === oppHp) {
    return `双方各${youHp}血。血量先到0的一方落败。`;
  }
  return `你${youHp}血。对手${oppHp}血。血量先到0的一方落败。`;
}
