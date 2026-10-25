import type { EngineSnapshot } from "../../engine/service/game.ts";

function emptySnapshot(): EngineSnapshot {
  return {
    devices: [],
    actors: [],
    rooms: [],
    metas: [],
    seen: [],
    seq: 0,
    battles: [],
  };
}

function ownsRoom(
  room: { hostKey: string; guestKey: string | null },
  key: string,
): boolean {
  return room.hostKey === key || room.hostKey.startsWith(`${key}:`) ||
    room.guestKey === key || (room.guestKey?.startsWith(`${key}:`) ?? false);
}

/** 把另一台设备上的房间、角色和对局并进当前快照。当前设备自己的角色保留。 */
export function absorbPeer(
  base: EngineSnapshot | null,
  peerKey: string,
  peer: EngineSnapshot,
): EngineSnapshot {
  const into = base ? structuredClone(base) : emptySnapshot();
  const device = peer.devices.find((item) => item.deviceId === peerKey);
  if (device) {
    const index = into.devices.findIndex((item) => item.deviceId === peerKey);
    if (index >= 0) into.devices[index] = structuredClone(device);
    else into.devices.push(structuredClone(device));
  }
  for (const actor of peer.actors) {
    if (actor.deviceId !== peerKey) continue;
    const index = into.actors.findIndex((item) => item.key === actor.key);
    if (index >= 0) into.actors[index] = structuredClone(actor);
    else into.actors.push(structuredClone(actor));
  }
  for (const room of peer.rooms) {
    if (!ownsRoom(room, peerKey)) continue;
    const index = into.rooms.findIndex((item) => item.code === room.code);
    if (index < 0) {
      into.rooms.push(structuredClone(room));
      continue;
    }
    const current = into.rooms[index]!;
    if (
      room.status === "STARTED" ||
      (room.guestKey && !current.guestKey)
    ) {
      into.rooms[index] = structuredClone(room);
    }
  }
  const battleIds = new Set(
    into.actors.flatMap((actor) =>
      actor.deviceId === peerKey && actor.battleId ? [actor.battleId] : []
    ),
  );
  for (const battle of peer.battles) {
    if (!battleIds.has(battle.battleId)) continue;
    const index = into.battles.findIndex((item) =>
      item.battleId === battle.battleId
    );
    if (index < 0) {
      into.battles.push(structuredClone(battle));
      continue;
    }
    if (battle.version >= into.battles[index]!.version) {
      into.battles[index] = structuredClone(battle);
    }
  }
  for (const [battleId, meta] of peer.metas) {
    if (!battleIds.has(battleId)) continue;
    const index = into.metas.findIndex((item) => item[0] === battleId);
    if (index < 0) into.metas.push([battleId, structuredClone(meta)]);
  }
  into.seq = Math.max(into.seq, peer.seq);
  return into;
}

export function peerIsRelevant(
  peerKey: string,
  peer: EngineSnapshot,
  selfKey: string,
  joinCode: string | null,
): boolean {
  return peer.rooms.some((room) =>
    (joinCode !== null && room.code === joinCode) ||
    ownsRoom(room, selfKey) || ownsRoom(room, peerKey)
  );
}
