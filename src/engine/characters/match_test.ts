import { assertEquals } from "@std/assert";
import { getCharacter } from "./skills.ts";
import {
  characterPerfection,
  extractCharacterName,
  matchSkill,
} from "./match.ts";

Deno.test("extractCharacterName accepts 选烈焰剑士", () => {
  assertEquals(extractCharacterName("选烈焰剑士"), "烈焰剑士");
  assertEquals(extractCharacterName("我要圣光守卫"), "圣光守卫");
  assertEquals(extractCharacterName("圣光武士"), "圣光守卫");
  assertEquals(extractCharacterName("暗影术士"), "暗影术士");
});

Deno.test("matchSkill accepts near-pinyin ASR for 疾风剑", () => {
  const character = getCharacter("swordsman")!;
  const hit = matchSkill(character, "疾风剑");
  assertEquals(hit.ok, true);
  if (hit.ok) {
    assertEquals(hit.match.skill.name, "疾风剑");
    assertEquals(hit.match.perfection, 100);
  }

  const near = matchSkill(character, "疾风见");
  assertEquals(near.ok, true);
  if (near.ok) {
    assertEquals(near.match.skill.name, "疾风剑");
    assertEquals(near.match.exact, false);
    assertEquals(near.match.perfection < 100, true);
  }
});

Deno.test("matchSkill maps 守正回击 to 护阵回击", () => {
  const character = getCharacter("guardian")!;
  const hit = matchSkill(character, "守正回击");
  assertEquals(hit.ok, true);
  if (hit.ok) assertEquals(hit.match.skill.name, "护阵回击");
});

Deno.test("characterPerfection counts overlapping han", () => {
  assertEquals(characterPerfection("疾风剑", "疾风剑"), 100);
  assertEquals(characterPerfection("疾风剑", "疾风见") > 50, true);
  assertEquals(characterPerfection("疾风剑", ""), 0);
});
