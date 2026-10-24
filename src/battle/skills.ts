export type SkillSlot = "BASIC" | "CHARACTER";
export type ReuseRule =
  | "ONCE_PER_MATCH"
  | "BASIC_NON_CONSECUTIVE"
  | "LIMITED_REPEAT";
export type PhraseLengthTier = "SHORT" | "MEDIUM" | "LONG";

export type SkillEffect =
  | { type: "DAMAGE"; amount: number }
  | { type: "HEAL"; amount: number }
  | { type: "SHIELD"; amount: number }
  | {
    type: "SELF_BUFF";
    tag: string;
    value: number;
    durationRounds: number;
    triggerCount?: number;
    dispellable?: boolean;
  }
  | {
    type: "OPPONENT_DEBUFF";
    tag: string;
    value: number;
    durationRounds: number;
    triggerCount?: number;
    dispellable?: boolean;
  }
  | { type: "BREAK_SHIELD"; amount: number | null }
  | { type: "REMOVE_OPPONENT_BUFF"; tag?: string }
  | { type: "CLEANSE_SELF_DEBUFF"; tag?: string }
  | { type: "ACTION_RESTRICTION"; durationRounds: number };

export type SkillConfig = {
  id: string;
  name: string;
  slotType: SkillSlot;
  phraseLengthTier: PhraseLengthTier;
  reuseRule: ReuseRule;
  maxUsesPerMatch: number | null;
  minRoundGap: number;
  effects: SkillEffect[];
  effectVersion: number;
};

export type CharacterConfig = {
  id: string;
  name: string;
  skills: SkillConfig[];
};

function defineSkill(
  skill: Omit<SkillConfig, "effectVersion">,
): SkillConfig {
  return { ...skill, effectVersion: 1 };
}

const basic = (
  id: string,
  name: string,
  amount: number,
): SkillConfig =>
  defineSkill({
    id,
    name,
    slotType: "BASIC",
    phraseLengthTier: "SHORT",
    reuseRule: "BASIC_NON_CONSECUTIVE",
    maxUsesPerMatch: null,
    minRoundGap: 2,
    effects: [{ type: "DAMAGE", amount }],
  });

const once = (
  id: string,
  name: string,
  phraseLengthTier: PhraseLengthTier,
  effects: SkillEffect[],
): SkillConfig =>
  defineSkill({
    id,
    name,
    slotType: "CHARACTER",
    phraseLengthTier,
    reuseRule: "ONCE_PER_MATCH",
    maxUsesPerMatch: 1,
    minRoundGap: 0,
    effects,
  });

const repeat = (
  id: string,
  name: string,
  phraseLengthTier: PhraseLengthTier,
  maxUsesPerMatch: number,
  minRoundGap: number,
  effects: SkillEffect[],
): SkillConfig =>
  defineSkill({
    id,
    name,
    slotType: "CHARACTER",
    phraseLengthTier,
    reuseRule: "LIMITED_REPEAT",
    maxUsesPerMatch,
    minRoundGap,
    effects,
  });

export const CHARACTERS: CharacterConfig[] = [
  {
    id: "swordsman",
    name: "烈焰剑士",
    skills: [
      basic("swordsman_basic", "破风斩", 65),
      once("swordsman_thrust", "锐刃突刺", "SHORT", [
        { type: "DAMAGE", amount: 80 },
      ]),
      once("swordsman_chase", "焰步追击", "SHORT", [
        { type: "DAMAGE", amount: 75 },
      ]),
      once("swordsman_combo", "裂甲连环斩", "MEDIUM", [
        { type: "DAMAGE", amount: 110 },
        { type: "BREAK_SHIELD", amount: 30 },
      ]),
      once("swordsman_buff", "战意燃锋诀", "MEDIUM", [
        {
          type: "SELF_BUFF",
          tag: "DAMAGE_BOOST",
          value: 25,
          durationRounds: 2,
          triggerCount: 2,
        },
      ]),
      once("swordsman_mark", "血刃追魂印", "MEDIUM", [
        { type: "DAMAGE", amount: 90 },
        {
          type: "OPPONENT_DEBUFF",
          tag: "DAMAGE_TAKEN_UP",
          value: 15,
          durationRounds: 2,
        },
      ]),
      once("swordsman_ultimate", "焚天裂空万刃归一", "LONG", [
        { type: "DAMAGE", amount: 260 },
      ]),
    ],
  },
  {
    id: "guardian",
    name: "圣光守卫",
    skills: [
      basic("guardian_basic", "守阵重击", 55),
      once("guardian_counter", "护阵回击", "SHORT", [
        { type: "DAMAGE", amount: 65 },
        { type: "SHIELD", amount: 40 },
      ]),
      repeat("guardian_small_heal", "安魂微光", "SHORT", 2, 2, [
        { type: "HEAL", amount: 65 },
      ]),
      once("guardian_armor", "圣甲护身诀", "MEDIUM", [
        { type: "SHIELD", amount: 210 },
        {
          type: "SELF_BUFF",
          tag: "DAMAGE_REDUCTION",
          value: 20,
          durationRounds: 2,
        },
      ]),
      once("guardian_regen", "回春守势诀", "MEDIUM", [
        { type: "HEAL", amount: 100 },
        {
          type: "SELF_BUFF",
          tag: "HEAL_OVER_TIME",
          value: 45,
          durationRounds: 2,
        },
      ]),
      once("guardian_cleanse", "圣光净化万象咒", "MEDIUM", [
        { type: "CLEANSE_SELF_DEBUFF" },
        { type: "REMOVE_OPPONENT_BUFF" },
      ]),
      once("guardian_ultimate", "神圣壁垒永昼长明", "LONG", [
        { type: "SHIELD", amount: 280 },
        { type: "HEAL", amount: 120 },
      ]),
    ],
  },
  {
    id: "warlock",
    name: "暗影术士",
    skills: [
      basic("warlock_basic", "蚀魂弹", 60),
      once("warlock_quick_buff", "咒火弹", "SHORT", [
        { type: "DAMAGE", amount: 75 },
        {
          type: "SELF_BUFF",
          tag: "NEXT_EFFECT_BOOST",
          value: 10,
          durationRounds: 1,
          triggerCount: 1,
        },
      ]),
      repeat("warlock_focus", "灵息聚能", "SHORT", 2, 2, [
        {
          type: "SELF_BUFF",
          tag: "NEXT_EFFECT_BOOST",
          value: 15,
          durationRounds: 1,
          triggerCount: 1,
        },
      ]),
      once("warlock_power", "幽冥增幅契", "MEDIUM", [
        {
          type: "SELF_BUFF",
          tag: "DAMAGE_BOOST",
          value: 20,
          durationRounds: 3,
        },
        {
          type: "SELF_BUFF",
          tag: "HEAL_BOOST",
          value: 30,
          durationRounds: 3,
          triggerCount: 1,
        },
      ]),
      once("warlock_recovery", "血契回流式", "MEDIUM", [
        { type: "HEAL", amount: 110 },
        {
          type: "SELF_BUFF",
          tag: "HEAL_BOOST",
          value: 25,
          durationRounds: 2,
        },
      ]),
      once("warlock_focus_field", "虚空咒能聚合", "MEDIUM", [
        {
          type: "SELF_BUFF",
          tag: "NEXT_EFFECT_BOOST",
          value: 35,
          durationRounds: 2,
          triggerCount: 1,
        },
      ]),
      once("warlock_ultimate", "万咒归源幽冥禁章", "LONG", [
        { type: "DAMAGE", amount: 190 },
        {
          type: "SELF_BUFF",
          tag: "DAMAGE_BOOST",
          value: 20,
          durationRounds: 2,
        },
      ]),
    ],
  },
  {
    id: "archer",
    name: "风行弓手",
    skills: [
      basic("archer_basic", "疾风箭", 60),
      once("archer_quick_shot", "裂风短矢", "SHORT", [
        { type: "DAMAGE", amount: 75 },
      ]),
      once("archer_quick_break", "穿甲短矢", "SHORT", [
        { type: "DAMAGE", amount: 65 },
        { type: "BREAK_SHIELD", amount: 40 },
      ]),
      repeat("archer_poison", "毒雨连射阵", "MEDIUM", 2, 2, [
        {
          type: "OPPONENT_DEBUFF",
          tag: "DOT",
          value: 35,
          durationRounds: 3,
        },
      ]),
      once("archer_weaken", "蚀心削势矢", "MEDIUM", [
        {
          type: "OPPONENT_DEBUFF",
          tag: "DAMAGE_DEALT_DOWN",
          value: 25,
          durationRounds: 2,
        },
      ]),
      once("archer_dispel", "破界散射万象术", "MEDIUM", [
        { type: "REMOVE_OPPONENT_BUFF" },
        { type: "BREAK_SHIELD", amount: 80 },
      ]),
      once("archer_control", "寒星封行九霄长矢", "LONG", [
        { type: "DAMAGE", amount: 80 },
        { type: "ACTION_RESTRICTION", durationRounds: 1 },
      ]),
    ],
  },
];

export function getCharacter(characterId: string): CharacterConfig | undefined {
  return CHARACTERS.find((character) => character.id === characterId);
}

export function getSkill(
  characterId: string,
  skillId: string,
): SkillConfig | undefined {
  return getCharacter(characterId)?.skills.find((skill) =>
    skill.id === skillId
  );
}

export function matchSkillByExactName(
  characterId: string,
  text: string,
): SkillConfig | undefined {
  return getCharacter(characterId)?.skills.find((skill) => skill.name === text);
}

export function validateCharacterConfig(character: CharacterConfig): string[] {
  const errors: string[] = [];
  if (character.skills.length !== 7) {
    errors.push(`${character.id}: expected 7 skills`);
  }
  const basics = character.skills.filter((skill) => skill.slotType === "BASIC");
  const characterSkills = character.skills.filter((skill) =>
    skill.slotType === "CHARACTER"
  );
  if (basics.length !== 1) {
    errors.push(`${character.id}: expected exactly one basic skill`);
  }
  if (characterSkills.length !== 6) {
    errors.push(`${character.id}: expected exactly six character skills`);
  }
  if (
    basics[0] && !basics[0].effects.some((effect) => effect.type === "DAMAGE")
  ) {
    errors.push(`${character.id}: basic skill must deal damage`);
  }
  if (basics[0]?.reuseRule !== "BASIC_NON_CONSECUTIVE") {
    errors.push(`${character.id}: basic skill must use BASIC_NON_CONSECUTIVE`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const skill of character.skills) {
    if (!skill.id || !skill.name) {
      errors.push(`${character.id}: skill id and name are required`);
    }
    if (ids.has(skill.id)) {
      errors.push(`${character.id}: duplicate skill id ${skill.id}`);
    }
    if (names.has(skill.name)) {
      errors.push(`${character.id}: duplicate skill name ${skill.name}`);
    }
    ids.add(skill.id);
    names.add(skill.name);
    const length = Array.from(skill.name).length;
    if (skill.phraseLengthTier === "SHORT" && length > 4) {
      errors.push(`${skill.id}: SHORT name must be at most 4 characters`);
    }
    if (skill.phraseLengthTier === "MEDIUM" && (length < 5 || length > 7)) {
      errors.push(`${skill.id}: MEDIUM name must be 5-7 characters`);
    }
    if (skill.phraseLengthTier === "LONG" && length < 8) {
      errors.push(`${skill.id}: LONG name must be at least 8 characters`);
    }
    if (skill.effects.length === 0) {
      errors.push(`${skill.id}: skill must contain at least one effect`);
    }
    if (
      skill.reuseRule === "ONCE_PER_MATCH" &&
      skill.maxUsesPerMatch !== 1
    ) {
      errors.push(`${skill.id}: ONCE_PER_MATCH must have maxUsesPerMatch 1`);
    }
    if (
      skill.reuseRule === "LIMITED_REPEAT" &&
      ((skill.maxUsesPerMatch ?? 0) < 2 || skill.minRoundGap < 1)
    ) {
      errors.push(
        `${skill.id}: LIMITED_REPEAT requires uses >= 2 and gap >= 1`,
      );
    }
    for (const effect of skill.effects) {
      if (
        (effect.type === "DAMAGE" || effect.type === "HEAL" ||
          effect.type === "SHIELD") && effect.amount <= 0
      ) {
        errors.push(`${skill.id}: ${effect.type} amount must be positive`);
      }
      if (
        effect.type === "BREAK_SHIELD" && effect.amount !== null &&
        effect.amount <= 0
      ) {
        errors.push(
          `${skill.id}: BREAK_SHIELD amount must be positive or null`,
        );
      }
      if (
        (effect.type === "SELF_BUFF" ||
          effect.type === "OPPONENT_DEBUFF") &&
        (effect.value < 0 || effect.durationRounds < 1 ||
          (effect.triggerCount !== undefined && effect.triggerCount < 1))
      ) {
        errors.push(`${skill.id}: status values and durations must be valid`);
      }
      if (
        effect.type === "ACTION_RESTRICTION" && effect.durationRounds !== 1
      ) {
        errors.push(
          `${skill.id}: action restriction must last exactly one round`,
        );
      }
    }
  }
  return errors;
}
