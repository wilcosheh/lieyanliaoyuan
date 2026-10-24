import { assertEquals, assertNotEquals } from "@std/assert";
import { BattleStateMachine } from "./state.ts";

function createMachine(): BattleStateMachine {
  return BattleStateMachine.create(
    "battle-1",
    [{ playerId: "a" }, { playerId: "b" }],
  );
}

Deno.test("state machine owns state and applies mutations without rule validation", () => {
  const machine = createMachine();
  machine.setBattleStatus("FINISHED");
  machine.setWinner("a", "b");
  machine.updatePlayer("a", { hp: -50, shield: 9999, alive: true });
  machine.setCurrentRound({
    roundNo: 99,
    status: "SETTLING",
    winnerPlayerId: "a",
    commandId: "cmd",
    skillId: "skill",
  });

  const state = machine.snapshot();
  assertEquals(state.status, "FINISHED");
  assertEquals(state.winnerPlayerId, "a");
  assertEquals(state.players[0]?.hp, -50);
  assertEquals(state.players[0]?.shield, 9999);
  assertEquals(state.currentRound?.roundNo, 99);
});

Deno.test("state machine manages players, usage, statuses and ordered events", () => {
  const machine = createMachine();
  machine.incrementSkillUse("a", "s1", 3);
  machine.addStatusEffect("a", {
    id: "effect-1",
    kind: "BUFF",
    tag: "DAMAGE_BOOST",
    value: 20,
    remainingRounds: 2,
    remainingTriggers: null,
    stacks: 1,
    sourcePlayerId: "a",
    sourceSkillId: "s1",
    appliedRound: 3,
    dispellable: true,
  });
  machine.appendEvent({
    type: "ONE",
    roundNo: 3,
    playerId: "a",
    targetPlayerId: "b",
    skillId: "s1",
    payload: {},
  });
  machine.recordProcessedCommand({
    commandId: "command-1",
    signature: "signature",
    ok: true,
    errorCode: null,
  });
  machine.appendEvent({
    type: "TWO",
    roundNo: 3,
    playerId: null,
    targetPlayerId: null,
    skillId: null,
    payload: {},
  });

  assertEquals(machine.getPlayer("a")?.skillUsage.s1, 1);
  assertEquals(machine.getPlayer("a")?.skillLastUsedRound.s1, 3);
  assertEquals(machine.getPlayer("a")?.statusEffects.length, 1);
  assertEquals(
    machine.getEventsSince(0).map((event) => event.sequence),
    [1, 2],
  );
  assertEquals(machine.getEventCount(), 2);
  assertEquals(machine.getOpponent("a")?.playerId, "b");
  assertEquals(machine.getProcessedCommand("command-1")?.ok, true);

  machine.removeStatusEffects("a", (effect) => effect.id === "effect-1");
  assertEquals(machine.getPlayer("a")?.statusEffects, []);
});

Deno.test("state machine snapshots and query results cannot mutate owned state", () => {
  const machine = createMachine();
  const snapshot = machine.snapshot();
  const player = machine.getPlayer("a")!;
  const players = machine.getPlayers();
  snapshot.players[0]!.hp = 1;
  player.hp = 2;
  players[0]!.hp = 3;

  assertNotEquals(snapshot.players[0]?.hp, machine.getPlayer("a")?.hp);
  assertEquals(machine.getPlayer("a")?.hp, 1000);
});

Deno.test("state machine restores an isolated owned copy of a snapshot", () => {
  const source = createMachine();
  source.updatePlayer("a", { hp: 321 });
  const snapshot = source.snapshot();
  const restored = BattleStateMachine.restore(snapshot);

  snapshot.players[0]!.hp = 1;
  restored.updatePlayer("a", { shield: 88 });

  assertEquals(restored.getPlayer("a")?.hp, 321);
  assertEquals(restored.getPlayer("a")?.shield, 88);
  assertEquals(source.getPlayer("a")?.shield, 0);
});
