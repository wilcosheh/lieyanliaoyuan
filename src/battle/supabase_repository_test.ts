import { assertEquals, assertRejects } from "@std/assert";
import { BattleController } from "./controller.ts";
import {
  BattleNotFoundError,
  BattleVersionConflictError,
} from "./repository.ts";
import { SupabaseBattleRepository } from "./supabase_repository.ts";

type RequestLog = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function state() {
  return new BattleController("battle-1", ["a", "b"]).getState();
}

Deno.test("Supabase repository creates and loads a versioned battle", async () => {
  const requests: RequestLog[] = [];
  const snapshot = state();
  const responses = [
    jsonResponse(true),
    jsonResponse([{
      battle_id: "battle-1",
      version: 1,
      state: snapshot,
      controller_options: {},
    }]),
  ];
  const request = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(responses.shift()!);
  }) as typeof fetch;
  const repository = new SupabaseBattleRepository(
    "https://example.supabase.co/",
    "service-key",
    request,
  );

  const created = await repository.create({
    battleId: "battle-1",
    state: snapshot,
    controllerOptions: {},
  });
  assertEquals(created.version, 1);
  assertEquals(requests.length, 2);
  assertEquals(
    requests[0]?.url,
    "https://example.supabase.co/rest/v1/rpc/ly_battle_create",
  );
  assertEquals(
    JSON.parse(String(requests[0]?.init?.body)).p_battle_id,
    "battle-1",
  );
  assertEquals(
    requests[1]?.url,
    "https://example.supabase.co/rest/v1/ly_battle?battle_id=eq.battle-1&select=battle_id,version,state,controller_options",
  );
});

Deno.test("Supabase save returns the atomic version without a racy reload", async () => {
  const requests: RequestLog[] = [];
  const request = ((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Promise.resolve(jsonResponse(8));
  }) as typeof fetch;
  const repository = new SupabaseBattleRepository(
    "https://example.supabase.co",
    "service-key",
    request,
  );

  assertEquals(await repository.save("battle-1", 7, state()), 8);
  assertEquals(requests.length, 1);
  assertEquals(
    requests[0]?.url,
    "https://example.supabase.co/rest/v1/rpc/ly_battle_save",
  );
  assertEquals(JSON.parse(String(requests[0]?.init?.body)), {
    p_battle_id: "battle-1",
    p_expected_version: 7,
    p_state: state(),
  });
});

Deno.test("Supabase save distinguishes version conflict from missing battle", async () => {
  const snapshot = state();
  const conflictResponses = [
    jsonResponse(null),
    jsonResponse([{
      battle_id: "battle-1",
      version: 9,
      state: snapshot,
      controller_options: {},
    }]),
  ];
  const conflictRequest =
    (() => Promise.resolve(conflictResponses.shift()!)) as typeof fetch;
  const conflicting = new SupabaseBattleRepository(
    "https://example.supabase.co",
    "service-key",
    conflictRequest,
  );
  const conflict = await assertRejects(
    () => conflicting.save("battle-1", 7, snapshot),
    BattleVersionConflictError,
  );
  assertEquals(conflict.expectedVersion, 7);
  assertEquals(conflict.actualVersion, 9);

  const missingResponses = [jsonResponse(null), jsonResponse([])];
  const missingRequest =
    (() => Promise.resolve(missingResponses.shift()!)) as typeof fetch;
  const missing = new SupabaseBattleRepository(
    "https://example.supabase.co",
    "service-key",
    missingRequest,
  );
  await assertRejects(
    () => missing.save("missing", 1, { ...snapshot, battleId: "missing" }),
    BattleNotFoundError,
  );
});
