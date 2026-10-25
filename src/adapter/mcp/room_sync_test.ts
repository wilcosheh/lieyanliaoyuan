import { assertEquals } from "@std/assert";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { absorbPeer, textNeedsRoomLock } from "./room_sync.ts";

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
      rematch: false,
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

Deno.test("practice and versus cpu do not take the room lock up front", () => {
  assertEquals(textNeedsRoomLock("练习"), false);
  assertEquals(textNeedsRoomLock("人机对战"), false);
  assertEquals(textNeedsRoomLock("圣光守卫"), false);
  assertEquals(textNeedsRoomLock("开房间"), true);
  assertEquals(textNeedsRoomLock("6993"), true);
  assertEquals(textNeedsRoomLock("加入房间，房间号6993"), true);
});
