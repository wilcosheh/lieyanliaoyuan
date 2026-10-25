import { assertEquals } from "@std/assert";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { absorbPeer } from "./room_sync.ts";

Deno.test("absorbPeer keeps the host room visible to a guest snapshot", () => {
  const host: EngineSnapshot = {
    devices: [{
      deviceId: "host",
      voiceprint: false,
      localDuo: false,
      enrolled: { A: false, B: false },
      roomCode: "4787",
    }],
    actors: [{
      key: "host",
      deviceId: "host",
      playerId: "p:host",
      phase: "LOBBY",
      characterId: "guardian",
      battleId: null,
      mode: "ONLINE",
      cpuCharacterId: null,
      pendingPractice: false,
      echoedOpensAt: null,
      casting: false,
      wasInterrupted: false,
      pendingHit: null,
      rematch: false,
      lastSeenAt: 0,
      lastSessionId: null,
    }],
    rooms: [{
      code: "4787",
      hostKey: "host",
      guestKey: null,
      terminal: "voice",
      status: "OPEN",
    }],
    metas: [],
    seen: [],
    seq: 3,
    battles: [],
  };
  const merged = absorbPeer(null, "host", host);
  assertEquals(merged.rooms[0]?.code, "4787");
  assertEquals(merged.actors[0]?.characterId, "guardian");
  assertEquals(merged.devices[0]?.roomCode, "4787");
});

Deno.test("absorbPeer keeps the earlier disconnect deadline", () => {
  const actor = {
    key: "host",
    deviceId: "host",
    playerId: "p:host",
    phase: "BATTLE" as const,
    characterId: "swordsman",
    battleId: "b1",
    mode: "ONLINE" as const,
    cpuCharacterId: null,
    pendingPractice: false,
    casting: false,
    wasInterrupted: false,
    pendingHit: null,
    rematch: false,
    lastSeenAt: 0,
    lastSessionId: null,
    echoedOpensAt: null,
  };
  const meta = {
    cpuPlayerId: null,
    cpuExtraMs: 0,
    opensAt: null,
    cpuCompleteAt: null,
    countdownSent: true,
    ackDeadline: null,
    disconnectDeadline: null as number | null,
    disconnectedPlayerId: null as string | null,
  };
  const base: EngineSnapshot = {
    devices: [],
    actors: [{
      ...actor,
      key: "guest",
      deviceId: "guest",
      playerId: "p:guest",
    }],
    rooms: [],
    metas: [["b1", { ...meta }]],
    seen: [],
    seq: 1,
    battles: [],
  };
  const peer: EngineSnapshot = {
    devices: [],
    actors: [actor],
    rooms: [],
    metas: [["b1", {
      ...meta,
      disconnectDeadline: 5_000,
      disconnectedPlayerId: "p:host",
    }]],
    seen: [],
    seq: 2,
    battles: [],
  };
  const merged = absorbPeer(base, "host", peer);
  assertEquals(merged.metas[0]?.[1].disconnectDeadline, 5_000);
  assertEquals(merged.metas[0]?.[1].disconnectedPlayerId, "p:host");
});
