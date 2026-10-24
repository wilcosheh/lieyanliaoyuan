import { CHARACTERS } from "../battle/skills.ts";
import type { WebCharacterView } from "./dto.ts";

const metadata: Record<
  string,
  Pick<WebCharacterView, "role" | "summary" | "accent" | "portrait">
> = {
  swordsman: {
    role: "强攻",
    summary: "快速压低生命，以爆发终结对手",
    accent: "#f05a3c",
    portrait: "/characters/swordsman.svg",
  },
  guardian: {
    role: "守御",
    summary: "护盾、治疗与减伤维持战线",
    accent: "#e8b647",
    portrait: "/characters/guardian.svg",
  },
  warlock: {
    role: "增幅",
    summary: "叠加增益，放大后续技能收益",
    accent: "#9b63d9",
    portrait: "/characters/warlock.svg",
  },
  archer: {
    role: "削弱",
    summary: "施加减益并拆解对手防御",
    accent: "#35a374",
    portrait: "/characters/archer.svg",
  },
};

export const WEB_CHARACTERS: WebCharacterView[] = CHARACTERS.map((
  character,
) => ({
  id: character.id,
  name: character.name,
  ...metadata[character.id]!,
  skills: character.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    phraseLengthTier: skill.phraseLengthTier,
    effects: structuredClone(skill.effects),
  })),
}));
