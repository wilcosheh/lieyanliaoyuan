import { assert, assertEquals } from "@std/assert";
import {
  BattleController,
  type BattleResponse,
  type ControllerOptions,
  type RuleErrorCode,
} from "./controller.ts";
import { CHARACTERS } from "../characters/skills.ts";

function expectOk(response: BattleResponse): void {
  assert(response.ok, response.ok ? undefined : response.error.code);
}

function expectError(response: BattleResponse, code: RuleErrorCode): void {
  assertEquals(response.ok, false);
  if (!response.ok) assertEquals(response.error.code, code);
}

class Game {
  controller: BattleController;
  command = 0;

  constructor(
    aCharacter = "swordsman",
    bCharacter = "guardian",
    options: ControllerOptions = {},
  ) {
    this.controller = new BattleController("battle", ["a", "b"], options);
    expectOk(this.controller.preparePlayer("a", aCharacter));
    expectOk(this.controller.preparePlayer("b", bCharacter));
    expectOk(this.controller.setReady("a"));
    expectOk(this.controller.setReady("b"));
    expectOk(this.controller.startBattle());
  }

  submit(
    playerId: string,
    skillText: string,
    roundNo?: number,
    perfection?: number,
  ): BattleResponse {
    return this.controller.submitAction({
      playerId,
      skillText,
      roundNo: roundNo ?? this.roundNo,
      commandId: `command-${++this.command}`,
      perfection,
    });
  }

  action(
    playerId: string,
    skillText: string,
    perfection?: number,
  ): BattleResponse {
    const accepted = this.submit(playerId, skillText, undefined, perfection);
    if (!accepted.ok) return accepted;
    const battle = this.controller.advance();
    if (!battle.ok || this.controller.getState().status === "FINISHED") {
      return battle;
    }
    return this.controller.advance();
  }

  get roundNo(): number {
    return this.controller.getState().currentRound?.roundNo ?? 0;
  }

  player(playerId: string) {
    const player = this.controller.getPlayerState(playerId);
    if (!player) throw new Error(`missing player ${playerId}`);
    return player;
  }
}

Deno.test("preparation and battle start transitions are guarded", () => {
  const controller = new BattleController("battle", ["a", "b"]);
  expectError(controller.setReady("a"), "CHARACTER_NOT_SELECTED");
  expectError(controller.startBattle(), "CHARACTER_NOT_SELECTED");
  expectError(
    controller.preparePlayer("missing", "swordsman"),
    "PLAYER_NOT_FOUND",
  );
  expectError(controller.preparePlayer("a", "missing"), "CHARACTER_NOT_FOUND");

  expectOk(controller.preparePlayer("a", "swordsman"));
  expectOk(controller.preparePlayer("b", "guardian"));
  expectOk(controller.setReady("a"));
  expectError(controller.startBattle(), "PLAYERS_NOT_READY");
  expectOk(controller.setReady("b"));
  const started = controller.startBattle();
  expectOk(started);
  assertEquals(started.state.status, "RUNNING");
  assertEquals(started.state.currentRound?.roundNo, 1);
  assertEquals(started.state.currentRound?.status, "WAITING_COMMAND");
  expectError(controller.preparePlayer("a", "archer"), "BATTLE_NOT_PREPARING");
});

Deno.test("external snapshots cannot bypass controller rules", () => {
  const game = new Game();
  const snapshot = game.controller.getState();
  snapshot.players[0]!.hp = 0;
  snapshot.players[0]!.skillUsage.swordsman_ultimate = 99;
  snapshot.status = "FINISHED";
  assertEquals(game.player("a").hp, 1000);
  assertEquals(game.player("a").skillUsage.swordsman_ultimate, undefined);
  assertEquals(game.controller.getState().status, "RUNNING");
});

Deno.test("round phases are explicit and only advance through controller", () => {
  const game = new Game();
  const accepted = game.submit("a", "锐刃突刺");
  expectOk(accepted);
  assertEquals(game.controller.getState().currentRound?.status, "SETTLING");
  assertEquals(game.player("b").hp, 1000);

  const late = game.submit("b", "守阵重击");
  expectError(late, "ROUND_ALREADY_WON");
  assertEquals(game.player("b").skillUsage.guardian_basic, undefined);

  expectOk(game.controller.advance());
  assertEquals(game.controller.getState().currentRound?.status, "ENDING");
  assertEquals(game.player("b").hp, 920);
  expectError(game.submit("b", "守阵重击"), "ROUND_ALREADY_WON");

  expectOk(game.controller.advance());
  assertEquals(
    game.controller.getState().currentRound?.status,
    "WAITING_COMMAND",
  );
  assertEquals(game.roundNo, 2);
  expectError(game.controller.advance(), "ROUND_NOT_WAITING");

  const types = game.controller.getState().events.map((event) => event.type);
  const acceptedAt = types.indexOf("ACTION_ACCEPTED");
  const resultAt = types.indexOf("BATTLE_RESULT");
  const endingAt = types.indexOf("ROUND_ENDING");
  const finishedAt = types.indexOf("ROUND_FINISHED");
  assert(acceptedAt < resultAt && resultAt < endingAt && endingAt < finishedAt);
});

Deno.test("skill text is exact and invalid actions do not consume the round", () => {
  const game = new Game();
  expectError(game.submit("a", " 疾风剑"), "ASR_FAILED");
  expectError(game.submit("a", "疾风箭"), "ASR_FAILED");
  expectError(game.submit("a", "守阵重击"), "ASR_FAILED");
  assertEquals(game.roundNo, 1);
  assertEquals(
    game.controller.getState().currentRound?.status,
    "WAITING_COMMAND",
  );
  assertEquals(game.player("a").skillUsage, {});
  expectOk(game.action("a", "疾风剑"));
  assertEquals(game.roundNo, 2);
});

Deno.test("skill perfection defaults to 100 and scales direct damage", () => {
  const full = new Game();
  const accepted = full.submit("a", "疾风剑");
  expectOk(accepted);
  assertEquals(accepted.state.currentRound?.perfection, 100);
  expectOk(full.controller.advance());
  assertEquals(full.player("b").hp, 935);

  const partial = new Game();
  expectOk(partial.action("a", "疾风剑", 90));
  assertEquals(partial.player("b").hp, 941);
  const damage = partial.controller.getState().events.findLast((event) =>
    event.type === "DAMAGE_APPLIED"
  );
  assertEquals(damage?.payload.rawAmount, 65);
  assertEquals(damage?.payload.perfection, 90);
  assertEquals(damage?.payload.amount, 59);
});

Deno.test("skill perfection only scales damage in a composite skill", () => {
  const game = new Game("guardian", "swordsman");
  expectOk(game.action("a", "护阵回击", 50));
  assertEquals(game.player("b").hp, 967);
  assertEquals(game.player("a").shield, 40);
});

Deno.test("DOT keeps the perfection of the action that applied it", () => {
  const game = new Game("archer", "guardian");
  expectOk(game.action("a", "毒雨连射阵", 90));
  const dot = game.player("b").statusEffects.find((effect) =>
    effect.kind === "DOT"
  );
  assertEquals(dot?.value, 35);
  assertEquals(dot?.sourcePerfection, 90);

  expectOk(game.action("b", "守阵重击"));
  assertEquals(game.player("b").hp, 968);
  const tick = game.controller.getState().events.findLast((event) =>
    event.type === "STATUS_TICK" && event.payload.tag === "DOT"
  );
  assertEquals(tick?.payload.rawValue, 35);
  assertEquals(tick?.payload.perfection, 90);
  assertEquals(tick?.payload.value, 32);
});

Deno.test("invalid perfection does not consume skill or round", () => {
  const game = new Game();
  for (const perfection of [-1, 100.1, Number.NaN]) {
    expectError(
      game.submit("a", "疾风剑", undefined, perfection),
      "INVALID_PERFECTION",
    );
  }
  assertEquals(
    game.controller.getState().currentRound?.status,
    "WAITING_COMMAND",
  );
  assertEquals(game.player("a").skillUsage, {});

  expectOk(game.action("a", "疾风剑", 0));
  assertEquals(game.player("b").hp, 1000);
});

Deno.test("basic skill is unlimited but cannot be used in consecutive rounds", () => {
  const game = new Game();
  expectOk(game.action("a", "疾风剑"));
  expectError(game.submit("a", "疾风剑"), "BASIC_CONSECUTIVE_REJECTED");
  expectOk(game.action("a", "锐刃突刺"));
  expectOk(game.action("a", "疾风剑"));
  assertEquals(game.player("a").skillUsage.swordsman_basic, 2);
});

Deno.test("one-use skills reject reuse and stale round commands cannot enter the next round", () => {
  const game = new Game();
  const roundOne = game.roundNo;
  expectOk(game.action("a", "锐刃突刺"));
  expectError(game.submit("b", "守阵重击", roundOne), "ROUND_ALREADY_WON");
  expectOk(game.action("b", "守阵重击"));
  expectError(game.submit("a", "锐刃突刺"), "SKILL_EXHAUSTED");
  assertEquals(game.player("a").skillUsage.swordsman_thrust, 1);
});

Deno.test("limited-repeat skill enforces gap and maximum uses", () => {
  const game = new Game("guardian", "swordsman");
  expectOk(game.action("b", "疾风剑"));
  expectOk(game.action("a", "安魂微光"));
  assertEquals(game.player("a").hp, 1000);
  expectError(game.submit("a", "安魂微光"), "REUSE_LIMIT_REJECTED");
  expectOk(game.action("a", "守阵重击"));
  expectOk(game.action("a", "安魂微光"));
  expectOk(game.action("b", "锐刃突刺"));
  expectError(game.submit("a", "安魂微光"), "REUSE_LIMIT_REJECTED");
  assertEquals(game.player("a").skillUsage.guardian_small_heal, 2);
});

Deno.test("damage buffs use trigger counts and damage still passes through shield first", () => {
  const game = new Game();
  expectOk(game.action("a", "战意燃锋诀"));
  expectOk(game.action("a", "疾风剑"));
  assertEquals(game.player("b").hp, 919);
  expectOk(game.action("a", "锐刃突刺"));
  assertEquals(game.player("b").hp, 819);
  expectOk(game.action("b", "圣甲护身诀"));
  assertEquals(game.player("b").shield, 210);
  expectOk(game.action("a", "焰步追击"));
  assertEquals(game.player("b").hp, 819);
  assertEquals(game.player("b").shield, 150);
});

Deno.test("next-effect boost applies to a configured status and is consumed once", () => {
  const game = new Game("warlock", "guardian");
  expectOk(game.action("a", "灵息聚能"));
  expectOk(game.action("a", "幽冥增幅契"));
  const damageBoost = game.player("a").statusEffects.find((effect) =>
    effect.tag === "DAMAGE_BOOST"
  );
  const nextBoost = game.player("a").statusEffects.find((effect) =>
    effect.tag === "NEXT_EFFECT_BOOST"
  );
  assertEquals(damageBoost?.value, 23);
  assertEquals(nextBoost, undefined);
  expectOk(game.action("a", "蚀魂弹"));
  assertEquals(game.player("b").hp, 926);
});

Deno.test("warlock healing boost affects the next recovery", () => {
  const game = new Game("warlock", "guardian", { maxHp: 300 });
  expectOk(game.action("b", "守阵重击"));
  expectOk(game.action("a", "幽冥增幅契"));
  expectOk(game.action("b", "护阵回击"));
  assertEquals(game.player("a").hp, 180);
  expectOk(game.action("a", "血契回流式"));
  assertEquals(game.player("a").hp, 300);
  assertEquals(
    game.player("a").statusEffects.find((effect) => effect.tag === "HEAL_BOOST")
      ?.value,
    25,
  );
});

Deno.test("DOT ticks at round end and cleanse removes it before the next tick", () => {
  const game = new Game("archer", "guardian");
  expectOk(game.action("a", "毒雨连射阵"));
  assertEquals(game.player("b").hp, 1000);
  expectOk(game.action("b", "守阵重击"));
  assertEquals(game.player("b").hp, 965);
  assertEquals(
    game.player("b").statusEffects.some((effect) => effect.kind === "DOT"),
    true,
  );
  expectOk(game.action("b", "圣光净化万象咒"));
  assertEquals(game.player("b").hp, 965);
  assertEquals(
    game.player("b").statusEffects.some((effect) => effect.kind === "DOT"),
    false,
  );
});

Deno.test("DOT boost participates in periodic damage and consumes its trigger", () => {
  const warlock = structuredClone(
    CHARACTERS.find((character) => character.id === "warlock")!,
  );
  const dotBoost = warlock.skills.find((skill) => skill.id === "warlock_power")!
    .effects.find((effect) =>
      effect.type === "SELF_BUFF" && effect.tag === "HEAL_BOOST"
    );
  if (dotBoost?.type === "SELF_BUFF") dotBoost.tag = "DOT_BOOST";
  warlock.skills.find((skill) => skill.id === "warlock_recovery")!.effects = [
    {
      type: "OPPONENT_DEBUFF",
      tag: "DOT",
      value: 10,
      durationRounds: 1,
    },
  ];
  const game = new Game("warlock", "warlock", { characters: [warlock] });
  expectOk(game.action("a", "幽冥增幅契"));
  expectOk(game.action("a", "血契回流式"));
  expectOk(game.action("b", "蚀魂弹"));
  assertEquals(game.player("b").hp, 985);
  assertEquals(
    game.player("a").statusEffects.some((effect) => effect.tag === "DOT_BOOST"),
    false,
  );
});

Deno.test("lethal DOT finishes the battle during ENDING and creates no next round", () => {
  const game = new Game("archer", "warlock", { maxHp: 70 });
  expectOk(game.action("a", "毒雨连射阵"));
  expectOk(game.action("b", "灵息聚能"));
  assertEquals(game.player("b").hp, 35);

  expectOk(game.submit("b", "幽冥增幅契"));
  expectOk(game.controller.advance());
  assertEquals(game.controller.getState().currentRound?.status, "ENDING");
  expectOk(game.controller.advance());
  const state = game.controller.getState();
  assertEquals(state.status, "FINISHED");
  assertEquals(state.currentRound?.roundNo, 3);
  assertEquals(state.currentRound?.status, "FINISHED");
  assertEquals(state.winnerPlayerId, "a");
  assertEquals(game.player("b").hp, 0);
});

Deno.test("periodic healing starts on later rounds and respects max HP", () => {
  const game = new Game("guardian", "swordsman", { maxHp: 300 });
  expectOk(game.action("b", "锐刃突刺"));
  assertEquals(game.player("a").hp, 220);
  expectOk(game.action("a", "回春守势诀"));
  assertEquals(game.player("a").hp, 300);
  expectOk(game.action("b", "焰步追击"));
  assertEquals(game.player("a").hp, 270);
  expectOk(game.action("b", "裂甲连环斩"));
  assertEquals(game.player("a").hp, 205);
});

Deno.test("debuff lowers outgoing damage and dispel removes buffs plus shield", () => {
  const game = new Game("archer", "guardian");
  expectOk(game.action("a", "蚀心削势矢"));
  expectOk(game.action("b", "守阵重击"));
  assertEquals(game.player("a").hp, 959);
  expectOk(game.action("b", "圣甲护身诀"));
  assertEquals(
    game.player("b").statusEffects.some((effect) => effect.kind === "BUFF"),
    true,
  );
  expectOk(game.action("a", "破界散射万象术"));
  assertEquals(game.player("b").shield, 130);
  assertEquals(
    game.player("b").statusEffects.some((effect) => effect.kind === "BUFF"),
    false,
  );
});

Deno.test("dispel preserves statuses configured as non-dispellable", () => {
  const archer = structuredClone(
    CHARACTERS.find((character) => character.id === "archer")!,
  );
  const guardian = structuredClone(
    CHARACTERS.find((character) => character.id === "guardian")!,
  );
  const armor = guardian.skills.find((skill) => skill.id === "guardian_armor")!;
  const reduction = armor.effects.find((effect) => effect.type === "SELF_BUFF");
  if (reduction?.type === "SELF_BUFF") reduction.dispellable = false;

  const game = new Game("archer", "guardian", {
    characters: [archer, guardian],
  });
  expectOk(game.action("b", "圣甲护身诀"));
  expectOk(game.action("a", "破界散射万象术"));
  assertEquals(
    game.player("b").statusEffects.some((effect) =>
      effect.tag === "DAMAGE_REDUCTION"
    ),
    true,
  );
});

Deno.test("action restriction blocks only the next round and never interrupts accepted action", () => {
  const game = new Game("archer", "guardian");
  expectOk(game.action("a", "寒星封行九霄长矢"));
  assertEquals(game.roundNo, 2);
  assertEquals(game.player("b").actionState, "ACTION_DISABLED");
  expectError(game.submit("b", "守阵重击"), "ACTION_DISABLED");
  expectOk(game.action("a", "疾风箭"));
  assertEquals(game.roundNo, 3);
  assertEquals(game.player("b").actionState, "READY");
  expectOk(game.submit("b", "守阵重击"));
  assertEquals(game.controller.getState().currentRound?.status, "SETTLING");
});

Deno.test("lethal action finishes battle immediately and archived battle is immutable", () => {
  const game = new Game("swordsman", "guardian", { maxHp: 200 });
  expectOk(game.submit("a", "焚天裂空万刃归一"));
  expectOk(game.controller.advance());
  const finished = game.controller.getState();
  assertEquals(finished.status, "FINISHED");
  assertEquals(finished.currentRound?.status, "FINISHED");
  assertEquals(finished.winnerPlayerId, "a");
  assertEquals(finished.loserPlayerId, "b");
  assertEquals(game.player("b").hp, 0);
  expectError(
    game.controller.submitAction({
      playerId: "b",
      commandId: "after-finish",
      roundNo: 1,
      skillText: "守阵重击",
    }),
    "BATTLE_ALREADY_FINISHED",
  );
  expectOk(game.controller.archiveBattle());
  assertEquals(game.controller.getState().status, "ARCHIVED");
});

Deno.test("command idempotency returns the original result without a second settlement", () => {
  const game = new Game();
  const input = {
    playerId: "a",
    commandId: "same-command",
    roundNo: 1,
    skillText: "锐刃突刺",
  };
  const first = game.controller.submitAction(input);
  const second = game.controller.submitAction({ ...input, perfection: 100 });
  expectOk(first);
  expectOk(second);
  assertEquals(second.state, first.state);
  assertEquals(game.player("a").skillUsage.swordsman_thrust, 1);
  expectError(
    game.controller.submitAction({ ...input, perfection: 90 }),
    "COMMAND_ALREADY_PROCESSED",
  );
  expectError(
    game.controller.submitAction({
      ...input,
      playerId: "b",
      skillText: "守阵重击",
    }),
    "COMMAND_ALREADY_PROCESSED",
  );
  expectOk(game.controller.advance());
  assertEquals(game.player("b").hp, 920);
});
