import { pinyin } from "pinyin-pro";
import {
  type CharacterConfig,
  CHARACTERS,
  type SkillConfig,
} from "./skills.ts";

function syllablesOf(text: string): string[] {
  const cleaned = text.replace(/[^\u3400-\u9fff]/g, "");
  if (!cleaned) return [];
  const raw = pinyin(cleaned, {
    toneType: "none",
    type: "array",
    nonZh: "removed",
  });
  const list = Array.isArray(raw) ? raw : String(raw).split(/\s+/);
  return list
    .map((s) => s.toLowerCase().replaceAll("ü", "v").replaceAll("u:", "v"))
    .filter((s) => s.length > 0);
}

function hanOf(text: string): string {
  return text.replace(/[^\u3400-\u9fff]/g, "");
}

/** 汉字重合比例，0–100。用于练习反馈；对战完成度仍以终端提交为准。 */
export function characterPerfection(expected: string, spoken: string): number {
  const want = [...hanOf(expected)];
  const got = [...hanOf(spoken)];
  if (want.length === 0) return 100;
  if (got.length === 0) return 0;
  let hit = 0;
  const pool = [...got];
  for (const ch of want) {
    const idx = pool.indexOf(ch);
    if (idx >= 0) {
      hit += 1;
      pool.splice(idx, 1);
    }
  }
  const lengthPenalty = Math.min(want.length, got.length) /
    Math.max(want.length, got.length);
  return Math.max(
    0,
    Math.min(100, Math.round(100 * (hit / want.length) * lengthPenalty)),
  );
}

function pinyinDistance(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp: number[][] = Array.from(
    { length: n + 1 },
    () => Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[n]![m]!;
}

export type SkillMatch = {
  skill: SkillConfig;
  perfection: number;
  exact: boolean;
};

/** 听写常见别名 → 标准技能名（按角色技能表再校验）。 */
const SKILL_ALIASES: Array<[string, string]> = (
  [
    ["守正回击", "护阵回击"],
    ["守阵回击", "护阵回击"],
    ["古镇回街", "护阵回击"],
    ["护阵回击", "护阵回击"],
    ["守阵重击", "守阵重击"],
    ["圣甲护身", "圣甲护身诀"],
  ] as Array<[string, string]>
).sort((a, b) => b[0].length - a[0].length);

function resolveSkillAlias(text: string): string {
  for (const [alias, name] of SKILL_ALIASES) {
    if (text === alias || text.includes(alias)) return name;
  }
  return text;
}

/**
 * 先别名，再精确 / 包含标准技能名，再按拼音纠偏听写。
 * 一句里命中两招以上算歧义。
 */
export function matchSkill(
  character: CharacterConfig,
  text: string,
):
  | { ok: true; match: SkillMatch }
  | { ok: false; code: "ASR_FAILED" | "AMBIGUOUS_SKILL" } {
  text = resolveSkillAlias(text);
  const contained = character.skills.filter((skill) =>
    text.includes(skill.name)
  );
  if (contained.length >= 2) return { ok: false, code: "AMBIGUOUS_SKILL" };
  if (contained.length === 1) {
    const skill = contained[0]!;
    const exact = text === skill.name || hanOf(text) === skill.name;
    return {
      ok: true,
      match: {
        skill,
        perfection: exact ? 100 : characterPerfection(skill.name, text),
        exact,
      },
    };
  }

  const spoken = syllablesOf(text);
  if (spoken.length === 0) return { ok: false, code: "ASR_FAILED" };

  const ranked = character.skills.map((skill) => {
    const want = syllablesOf(skill.name);
    const distance = pinyinDistance(want, spoken);
    const allowed = want.length <= 2 ? 0 : want.length <= 4 ? 1 : 2;
    return { skill, distance, allowed, wantLen: want.length };
  }).filter((row) => row.distance <= row.allowed)
    .sort((a, b) => a.distance - b.distance || a.wantLen - b.wantLen);

  if (ranked.length === 0) return { ok: false, code: "ASR_FAILED" };
  if (ranked.length >= 2 && ranked[0]!.distance === ranked[1]!.distance) {
    return { ok: false, code: "AMBIGUOUS_SKILL" };
  }
  const best = ranked[0]!;
  const exact = best.distance === 0 && hanOf(text) === best.skill.name;
  return {
    ok: true,
    match: {
      skill: best.skill,
      perfection: exact ? 100 : characterPerfection(best.skill.name, text),
      exact,
    },
  };
}

const CHARACTERS_BY_NAME_LENGTH = CHARACTERS
  .map((c) => c.name)
  .sort((a, b) => b.length - a.length);

/** 听写常见别名 → 标准角色名。 */
const CHARACTER_ALIASES: Array<[string, string]> = (
  [
    ["圣光武士", "圣光守卫"],
    ["圣光战士", "圣光守卫"],
    ["圣光骑士", "圣光守卫"],
    ["火焰剑士", "烈焰剑士"],
    ["烈焰战士", "烈焰剑士"],
    ["烈焰武士", "烈焰剑士"],
    ["暗影法师", "暗影术士"],
    ["暗黑术士", "暗影术士"],
    ["风行者", "风行弓手"],
    ["弓箭手", "风行弓手"],
  ] as Array<[string, string]>
).sort((a, b) => b[0].length - a[0].length);

/** 从「选烈焰剑士」「圣光武士」等口令里抽出标准角色名。 */
export function extractCharacterName(text: string): string | null {
  for (const [alias, name] of CHARACTER_ALIASES) {
    if (text === alias || text.includes(alias)) return name;
  }
  for (const name of CHARACTERS_BY_NAME_LENGTH) {
    if (text === name || text.includes(name)) return name;
  }
  return null;
}
