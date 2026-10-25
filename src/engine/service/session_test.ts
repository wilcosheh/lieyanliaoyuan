import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { InMemoryBattleRepository } from "../store/repository.ts";
import { type BattleSessionResponse, BattleSessionService } from "./session.ts";

function expectOk<T>(
  response: BattleSessionResponse<T>,
): asserts response is Extract<BattleSessionResponse<T>, { ok: true }> {
  assert(response.ok, response.ok ? undefined : response.error.code);
}

async function runningBattle(
  battleId = "shared-battle",
): Promise<{
  repository: InMemoryBattleRepository;
  deviceA: BattleSessionService;
  deviceB: BattleSessionService;
}> {
  const repository = new InMemoryBattleRepository();
  const deviceA = new BattleSessionService(repository);
  const deviceB = new BattleSessionService(repository);
  expectOk(
    await deviceA.createBattle({
      battleId,
      playerIds: ["player-a", "player-b"],
    }),
  );
  expectOk(await deviceA.preparePlayer(battleId, "player-a", "swordsman"));
  expectOk(await deviceB.preparePlayer(battleId, "player-b", "guardian"));
  expectOk(await deviceA.setReady(battleId, "player-a"));
  expectOk(await deviceB.setReady(battleId, "player-b"));
  expectOk(await deviceA.startBattle(battleId));
  return { repository, deviceA, deviceB };
}

Deno.test("different device services share one battle by battleId", async () => {
  const { repository, deviceA, deviceB } = await runningBattle();
  const fromA = await deviceA.getBattle("shared-battle");
  const fromB = await deviceB.getBattle("shared-battle");
  expectOk(fromA);
  expectOk(fromB);
  assertEquals(fromA.version, fromB.version);
  assertEquals(fromA.state, fromB.state);
  assertEquals(fromA.state.status, "RUNNING");
  assertEquals(fromA.state.players.map((player) => player.characterId), [
    "swordsman",
    "guardian",
  ]);
  const stored = await repository.load("shared-battle");
  assertEquals(stored?.controllerOptions.characters?.length, 4);
});

Deno.test("concurrent actions from two devices produce exactly one round winner", async () => {
  const { deviceA, deviceB } = await runningBattle();
  const [a, b] = await Promise.all([
    deviceA.submitAction("shared-battle", {
      playerId: "player-a",
      commandId: "device-a-round-1",
      roundNo: 1,
      skillText: "破风斩",
    }),
    deviceB.submitAction("shared-battle", {
      playerId: "player-b",
      commandId: "device-b-round-1",
      roundNo: 1,
      skillText: "守阵重击",
    }),
  ]);

  assertEquals([a, b].filter((response) => response.ok).length, 1);
  const rejected = [a, b].find((response) => !response.ok);
  assertEquals(rejected?.ok, false);
  if (rejected && !rejected.ok) {
    assertEquals(rejected.error.code, "ROUND_ALREADY_WON");
  }

  const final = await deviceA.getBattle("shared-battle");
  expectOk(final);
  assertEquals(final.state.currentRound?.status, "SETTLING");
  assert(
    final.state.currentRound?.winnerPlayerId === "player-a" ||
      final.state.currentRound?.winnerPlayerId === "player-b",
  );
  assertEquals(
    final.state.events.filter((event) => event.type === "ACTION_ACCEPTED")
      .length,
    1,
  );
});

Deno.test("same command retry is idempotent and does not create a new version", async () => {
  const { deviceA, deviceB } = await runningBattle();
  const input = {
    playerId: "player-a",
    commandId: "retry-command",
    roundNo: 1,
    skillText: "破风斩",
  };
  const first = await deviceA.submitAction("shared-battle", input);
  expectOk(first);
  const retried = await deviceB.submitAction("shared-battle", input);
  expectOk(retried);
  assertEquals(retried.version, first.version);
  assertEquals(retried.events, []);
});

Deno.test("a new service instance restores the complete battle", async () => {
  const { repository, deviceA } = await runningBattle();
  const accepted = await deviceA.submitAction("shared-battle", {
    playerId: "player-a",
    commandId: "before-restart",
    roundNo: 1,
    skillText: "破风斩",
    perfection: 90,
  });
  expectOk(accepted);

  const restartedService = new BattleSessionService(repository);
  const beforeAdvance = await restartedService.getBattle("shared-battle");
  expectOk(beforeAdvance);
  assertEquals(beforeAdvance.state.currentRound?.status, "SETTLING");
  assertEquals(beforeAdvance.state.currentRound?.perfection, 90);
  const advanced = await restartedService.advance("shared-battle", {
    expectedVersion: beforeAdvance.version,
  });
  expectOk(advanced);
  assertEquals(advanced.state.currentRound?.status, "ENDING");
  assertEquals(
    advanced.state.players.find((player) => player.playerId === "player-b")
      ?.hp,
    941,
  );
});

Deno.test("concurrent phase advances cannot skip a phase", async () => {
  const { deviceA, deviceB } = await runningBattle();
  expectOk(
    await deviceA.submitAction("shared-battle", {
      playerId: "player-a",
      commandId: "advance-race-action",
      roundNo: 1,
      skillText: "破风斩",
    }),
  );
  const before = await deviceA.getBattle("shared-battle");
  expectOk(before);

  const [first, second] = await Promise.all([
    deviceA.advance("shared-battle", { expectedVersion: before.version }),
    deviceB.advance("shared-battle", { expectedVersion: before.version }),
  ]);
  assertEquals([first, second].filter((response) => response.ok).length, 1);
  const conflict = [first, second].find((response) => !response.ok);
  if (conflict && !conflict.ok) {
    assertEquals(conflict.error.code, "VERSION_CONFLICT");
  }
  const final = await deviceA.getBattle("shared-battle");
  expectOk(final);
  assertEquals(final.state.currentRound?.roundNo, 1);
  assertEquals(final.state.currentRound?.status, "ENDING");
});

Deno.test("different battle ids remain isolated", async () => {
  const repository = new InMemoryBattleRepository();
  const service = new BattleSessionService(repository);
  expectOk(
    await service.createBattle({
      battleId: "battle-a",
      playerIds: ["a1", "a2"],
    }),
  );
  expectOk(
    await service.createBattle({
      battleId: "battle-b",
      playerIds: ["b1", "b2"],
    }),
  );
  expectOk(await service.preparePlayer("battle-a", "a1", "swordsman"));

  const a = await service.getBattle("battle-a");
  const b = await service.getBattle("battle-b");
  expectOk(a);
  expectOk(b);
  assertEquals(a.state.players[0]?.characterId, "swordsman");
  assertEquals(b.state.players[0]?.characterId, null);
  assertNotEquals(a.state.battleId, b.state.battleId);
});

Deno.test("repository reads and session responses cannot mutate stored state", async () => {
  const { repository, deviceA } = await runningBattle();
  const response = await deviceA.getBattle("shared-battle");
  const record = await repository.load("shared-battle");
  expectOk(response);
  assert(record);
  response.state.players[0]!.hp = 1;
  record.state.players[0]!.hp = 2;

  const current = await deviceA.getBattle("shared-battle");
  expectOk(current);
  assertEquals(current.state.players[0]?.hp, 1000);
});

Deno.test("missing, duplicate and stale-version requests are rejected", async () => {
  const repository = new InMemoryBattleRepository();
  const service = new BattleSessionService(repository);
  const missing = await service.getBattle("missing");
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error.code, "BATTLE_NOT_FOUND");

  expectOk(
    await service.createBattle({
      battleId: "battle",
      playerIds: ["a", "b"],
    }),
  );
  const duplicate = await service.createBattle({
    battleId: "battle",
    playerIds: ["a", "b"],
  });
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) {
    assertEquals(duplicate.error.code, "BATTLE_ALREADY_EXISTS");
  }

  const stale = await service.preparePlayer(
    "battle",
    "a",
    "swordsman",
    { expectedVersion: 0 },
  );
  assertEquals(stale.ok, false);
  if (!stale.ok) assertEquals(stale.error.code, "VERSION_CONFLICT");
  const current = await service.getBattle("battle");
  expectOk(current);
  assertEquals(current.state.players[0]?.characterId, null);
});
