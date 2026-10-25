import { assertEquals, assertThrows } from "@std/assert";
import { BattleController } from "../rules/controller.ts";
import {
  CHARACTERS,
  getCharacter,
  getSkill,
  matchSkillByExactName,
  validateCharacterConfig,
} from "./skills.ts";

Deno.test("built-in character configurations satisfy the seven-skill contract", () => {
  assertEquals(CHARACTERS.length, 4);
  for (const character of CHARACTERS) {
    assertEquals(validateCharacterConfig(character), []);
    assertEquals(character.skills.length, 7);
    assertEquals(
      character.skills.filter((skill) => skill.slotType === "BASIC").length,
      1,
    );
    assertEquals(
      character.skills.filter((skill) => skill.phraseLengthTier === "SHORT")
        .length,
      3,
    );
    assertEquals(
      character.skills.find((skill) => skill.slotType === "BASIC")?.effects
        .some((effect) => effect.type === "DAMAGE"),
      true,
    );
  }
});

Deno.test("skill lookup is exact and scoped to the selected character", () => {
  assertEquals(getCharacter("swordsman")?.name, "烈焰剑士");
  assertEquals(getSkill("swordsman", "swordsman_basic")?.name, "疾风剑");
  assertEquals(
    matchSkillByExactName("swordsman", "疾风剑")?.id,
    "swordsman_basic",
  );
  assertEquals(matchSkillByExactName("swordsman", " 疾风剑"), undefined);
  assertEquals(matchSkillByExactName("guardian", "疾风剑"), undefined);
});

Deno.test("controller refuses an invalid ruleset at construction", () => {
  const invalid = structuredClone(CHARACTERS[0]!);
  invalid.skills = invalid.skills.slice(0, 6);
  assertThrows(
    () => new BattleController("bad", ["a", "b"], { characters: [invalid] }),
    Error,
    "expected 7 skills",
  );
  assertThrows(
    () => new BattleController("bad", ["a", "a"]),
    Error,
    "exactly two unique players",
  );

  const invalidEffect = structuredClone(CHARACTERS[0]!);
  invalidEffect.skills[1]!.effects = [{ type: "DAMAGE", amount: -1 }];
  assertThrows(
    () =>
      new BattleController("bad-effect", ["a", "b"], {
        characters: [invalidEffect],
      }),
    Error,
    "amount must be positive",
  );
});

Deno.test("controller snapshots configuration so callers cannot change live rules", () => {
  const configs = structuredClone(CHARACTERS);
  const controller = new BattleController("stable", ["a", "b"], {
    characters: configs,
  });
  configs[0]!.skills[0]!.name = "篡改技能";
  configs[0]!.skills[0]!.effects = [{ type: "DAMAGE", amount: 99999 }];

  assertEquals(controller.preparePlayer("a", "swordsman").ok, true);
  assertEquals(controller.preparePlayer("b", "guardian").ok, true);
  assertEquals(controller.setReady("a").ok, true);
  assertEquals(controller.setReady("b").ok, true);
  assertEquals(controller.startBattle().ok, true);
  assertEquals(
    controller.submitAction({
      playerId: "a",
      commandId: "stable-command",
      roundNo: 1,
      skillText: "疾风剑",
    }).ok,
    true,
  );
  assertEquals(controller.advance().ok, true);
  assertEquals(controller.getPlayerState("b")?.hp, 935);
});
