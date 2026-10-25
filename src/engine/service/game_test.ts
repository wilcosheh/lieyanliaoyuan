import { assertEquals } from "@std/assert";
import { COUNTDOWN_MS } from "../clock/clock.ts";
import { GameEngine } from "./game.ts";

function engine(now: { value: number }) {
  return new GameEngine({ now: () => now.value, random: () => 0.1234 });
}

async function call(
  game: GameEngine,
  deviceId: string,
  commandId: string,
  tool:
    | "submit_lobby_text"
    | "submit_utterance"
    | "begin_cast"
    | "cancel_cast"
    | "ack_playback"
    | "wait_event",
  text?: string,
  extra: {
    seat?: "A" | "B";
    voiceprint?: boolean;
    terminal?: "voice" | "web";
  } = {},
) {
  return await game.handle({
    deviceId,
    commandId,
    tool,
    text,
    seat: extra.seat,
    voiceprint: extra.voiceprint,
    terminal: extra.terminal,
  });
}

Deno.test("versus cpu opens on one countdown sentence and resolves the first cast", async () => {
  const now = { value: 1_000 };
  const game = engine(now);
  const versus = await call(
    game,
    "d1",
    "c1",
    "submit_lobby_text",
    "人机对抗呀",
  );
  assertEquals(versus.caller?.say, "对手是烈焰剑士。请选角色并准备。");
  assertEquals(versus.caller?.wait, false);

  const selected = await call(
    game,
    "d1",
    "c2",
    "submit_lobby_text",
    "选烈焰剑士",
  );
  assertEquals(selected.caller?.say, "已选烈焰剑士。");

  const ready = await call(game, "d1", "c3", "submit_lobby_text", "准备");
  assertEquals(
    ready.caller?.say,
    "双方各1000血。血量先到0的一方落败。三。二。一。",
  );
  assertEquals(ready.caller?.ack_required, false);
  assertEquals(ready.caller?.opens_in_ms, COUNTDOWN_MS);

  const early = await call(game, "d1", "c4", "submit_utterance", "破风斩");
  assertEquals(early.caller?.code, "ROUND_NOT_OPEN");
  assertEquals(early.caller?.say, "三。二。一。");

  now.value += COUNTDOWN_MS;
  const cast = await call(game, "d1", "c5", "submit_utterance", "破风斩");
  assertEquals(cast.caller?.code, "ACCEPTED");
  assertEquals(
    cast.caller?.say,
    "破风斩命中。你1000血。对手935血。三。二。一。",
  );
  assertEquals(cast.caller?.wait, true);
  assertEquals(cast.caller?.phase, "BATTLE");
});

Deno.test("practice during a battle leaves the battle and starts practice", async () => {
  const now = { value: 1_000 };
  const game = engine(now);
  await call(game, "d1", "c1", "submit_lobby_text", "对电脑");
  await call(game, "d1", "c2", "submit_lobby_text", "烈焰剑士");
  const ready = await call(game, "d1", "c3", "submit_lobby_text", "准备");
  assertEquals(ready.caller?.phase, "BATTLE");

  const practice = await call(game, "d1", "c4", "submit_lobby_text", "练习");
  assertEquals(practice.caller?.phase, "PRACTICE");
  assertEquals(practice.caller?.say.includes("破风斩"), true);

  const list = await call(game, "d1", "c5", "submit_lobby_text", "选角");
  assertEquals(list.caller?.phase, "LOBBY");
  assertEquals(list.caller?.say.includes("可选烈焰剑士"), true);

  const again = await call(game, "d1", "c6", "submit_lobby_text", "练习");
  assertEquals(again.caller?.phase, "PRACTICE");
});

Deno.test("lobby 选角 lists characters and practice without one asks for a name", async () => {
  const game = engine({ value: 0 });
  const list = await call(game, "d1", "c1", "submit_lobby_text", "选角");
  assertEquals(list.caller?.say.includes("可选烈焰剑士"), true);
  const practice = await call(game, "d1", "c2", "submit_lobby_text", "练习");
  assertEquals(practice.caller?.code, "CHARACTER_REQUIRED");
  assertEquals(practice.caller?.say.includes("先说角色名"), true);
  assertEquals(practice.caller?.say.includes("风行弓手"), true);
});

Deno.test("early ack repeats the countdown instead of an empty line", async () => {
  const now = { value: 1_000 };
  const game = engine(now);
  await call(game, "d1", "c1", "submit_lobby_text", "对电脑");
  await call(game, "d1", "c2", "submit_lobby_text", "烈焰剑士");
  await call(game, "d1", "c3", "submit_lobby_text", "准备");
  const acked = await call(game, "d1", "c4", "ack_playback");
  assertEquals(acked.caller?.say, "三。二。一。");
  assertEquals(acked.caller?.wait, false);
  assertEquals(acked.caller?.opens_in_ms, COUNTDOWN_MS);
});

Deno.test("practice reports perfection 100 and rejects a second skill in one line", async () => {
  const game = engine({ value: 0 });
  await call(game, "d1", "c1", "submit_lobby_text", "烈焰剑士");
  const practice = await call(
    game,
    "d1",
    "c2",
    "submit_lobby_text",
    "练技能",
  );
  assertEquals(practice.caller?.phase, "PRACTICE");
  assertEquals(practice.caller?.say.includes("破风斩"), true);
  assertEquals(practice.caller?.say.includes("直接念技能名练习"), true);

  const hit = await call(game, "d1", "c3", "submit_utterance", "破风斩");
  assertEquals(hit.caller?.say, "完成度100。破风斩。造成65点伤害。");
  assertEquals(hit.caller?.wait, false);

  const near = await call(game, "d1", "c3b", "submit_utterance", "破风站");
  assertEquals(near.caller?.code, "ACCEPTED");
  assertEquals(near.caller?.say.includes("破风斩"), true);
  assertEquals(near.caller?.say.includes("完成度100"), false);
  assertEquals(near.caller?.wait, false);

  const ambiguous = await call(
    game,
    "d1",
    "c4",
    "submit_utterance",
    "破风斩锐刃突刺",
  );
  assertEquals(ambiguous.caller?.code, "AMBIGUOUS_SKILL");
  assertEquals(ambiguous.caller?.say, "一次一道。");
  assertEquals(ambiguous.caller?.wait, false);

  const done = await call(game, "d1", "c5", "submit_utterance", "结束练习");
  assertEquals(done.caller?.say, "练习结束。说对电脑打一局，或开房间。");
  assertEquals(done.caller?.phase, "LOBBY");
  assertEquals(done.caller?.wait, false);
});

Deno.test("the same command id replays and a changed line is rejected", async () => {
  const game = engine({ value: 0 });
  const first = await call(game, "d1", "same", "submit_lobby_text", "烈焰剑士");
  const replay = await call(
    game,
    "d1",
    "same",
    "submit_lobby_text",
    "烈焰剑士",
  );
  assertEquals(replay.caller?.event_id, first.caller?.event_id);

  const changed = await call(
    game,
    "d1",
    "same",
    "submit_lobby_text",
    "圣光守卫",
  );
  assertEquals(changed.caller?.code, "COMMAND_ALREADY_PROCESSED");
  assertEquals(changed.caller?.say, "");
});

Deno.test("begin cast is rejected in the lobby", async () => {
  const game = engine({ value: 0 });
  const rejected = await call(game, "d1", "c1", "begin_cast");
  assertEquals(rejected.caller?.code, "PHASE_REJECTED");
  assertEquals(rejected.caller?.say, "");
});

Deno.test("cpu cast interrupts a player who already began", async () => {
  const now = { value: 0 };
  const game = engine(now);
  await call(game, "d1", "c1", "submit_lobby_text", "对电脑");
  await call(game, "d1", "c2", "submit_lobby_text", "烈焰剑士");
  await call(game, "d1", "c3", "submit_lobby_text", "准备");
  now.value = COUNTDOWN_MS;
  const began = await call(game, "d1", "c5", "begin_cast");
  assertEquals(began.caller?.code, "ACCEPTED");

  now.value = COUNTDOWN_MS + 3 * 400 + 2000;
  const late = await call(game, "d1", "c6", "submit_utterance", "锐刃突刺");
  assertEquals(late.caller?.code, "CAST_INTERRUPTED");
  assertEquals(late.caller?.say, "吟唱被打断。");
  assertEquals(
    late.pushes.some((push) => push.delivery.say.includes("中了")),
    true,
  );
});

Deno.test("local duo requires a seat and enrolls both speakers", async () => {
  const game = engine({ value: 0 });
  const missing = await call(game, "mic", "c0", "submit_lobby_text", "两个人");
  assertEquals(
    missing.caller?.say.includes("说角色名开始"),
    true,
  );
  assertEquals(
    missing.caller?.say.includes("烈焰剑士"),
    true,
  );

  const started = await call(game, "mic", "c1", "submit_lobby_text", "两个人", {
    voiceprint: true,
  });
  assertEquals(started.caller?.say, "先由甲说话。");

  const noSeat = await call(
    game,
    "mic",
    "c2",
    "submit_lobby_text",
    "烈焰剑士",
    {
      voiceprint: true,
    },
  );
  assertEquals(noSeat.caller?.code, "SEAT_UNKNOWN");

  const first = await call(game, "mic", "c3", "submit_lobby_text", "甲到", {
    seat: "A",
    voiceprint: true,
  });
  assertEquals(first.caller?.say, "甲已就座。换乙说话。");
  const second = await call(game, "mic", "c4", "submit_lobby_text", "乙到", {
    seat: "B",
    voiceprint: true,
  });
  assertEquals(second.caller?.say, "乙已就座。甲先说角色名。");
});

Deno.test("room codes are spoken digit by digit and a missing room is refused", async () => {
  const game = engine({ value: 0 });
  const created = await call(
    game,
    "host",
    "c0",
    "submit_lobby_text",
    "那你创建一个房间呀",
  );
  assertEquals(
    created.caller?.say,
    "房间号 1、2、3、4。把号码告诉对手。等对手加入。",
  );

  const game2 = engine({ value: 0 });
  const opened = await call(game2, "host", "c1", "submit_lobby_text", "开房间");
  assertEquals(
    opened.caller?.say,
    "房间号 1、2、3、4。把号码告诉对手。等对手加入。",
  );
  const asked = await call(
    game2,
    "host",
    "c7",
    "submit_lobby_text",
    "房号是啥呢",
  );
  assertEquals(asked.caller?.say, opened.caller?.say);
  const reopened = await call(
    game2,
    "host",
    "c8",
    "submit_lobby_text",
    "创建房间",
  );
  assertEquals(reopened.caller?.say, opened.caller?.say);
  const ownJoin = await call(
    game2,
    "host",
    "c10",
    "submit_lobby_text",
    "加入房间1234",
  );
  assertEquals(ownJoin.caller?.say.includes("你是房主"), true);
  assertEquals(ownJoin.caller?.say.includes("1、2、3、4"), true);
  const where = await call(
    game2,
    "host",
    "c11",
    "submit_lobby_text",
    "在哪个房间里",
  );
  assertEquals(where.caller?.say, opened.caller?.say);
  const roles = await call(
    game2,
    "host",
    "c12",
    "submit_lobby_text",
    "有什么角色",
  );
  assertEquals(roles.caller?.say.includes("烈焰剑士"), true);
  assertEquals(roles.caller?.say.includes("风行弓手"), true);

  const joined = await call(
    game,
    "guest",
    "c2",
    "submit_lobby_text",
    "加入房间1234。",
  );
  assertEquals(joined.caller?.say, "已加入。请选角色并准备。");
  assertEquals(joined.pushes[0]?.delivery.say, "对手来了。请选角色并准备。");
  assertEquals(joined.pushes[0]?.delivery.wait, true);
  assertEquals(joined.caller?.wait, false);
  const hostAgain = await call(
    game,
    "host",
    "c9",
    "submit_lobby_text",
    "创建房间",
  );
  assertEquals(
    hostAgain.caller?.say,
    "房间号 1、2、3、4。把号码告诉对手。等对手加入。",
  );
  assertEquals(hostAgain.pushes.length, 0);

  const practice = await call(game, "guest", "c4", "submit_lobby_text", "练习");
  assertEquals(
    practice.caller?.say,
    "先说角色名。可选烈焰剑士、圣光守卫、暗影术士、风行弓手。",
  );
  assertEquals(practice.pushes[0]?.delivery.say, "对手离开了。");
  const hostPractice = await call(
    game,
    "host",
    "c5",
    "submit_lobby_text",
    "对电脑",
  );
  assertEquals(hostPractice.caller?.say, "对手是烈焰剑士。请选角色并准备。");
  const openedAgain = await call(
    game,
    "host",
    "c6",
    "submit_lobby_text",
    "开房间",
  );
  assertEquals(
    openedAgain.caller?.say,
    "房间号 1、2、3、4。把号码告诉对手。等对手加入。",
  );
  const left = await call(game, "host", "c7", "submit_lobby_text", "退出");
  assertEquals(left.caller?.say, "已离开房间。可以说练习，对电脑，或开房间。");

  const missing = await call(game, "other", "c3", "submit_lobby_text", "9999");
  assertEquals(missing.caller?.code, "ROOM_NOT_FOUND");
  assertEquals(missing.caller?.say, "没有这个房间。");
  assertEquals(missing.caller?.wait, false);
});

Deno.test("加入房间，房间号6993 joins instead of rereading the host script", async () => {
  const game = engine({ value: 0 });
  await call(game, "host", "c1", "submit_lobby_text", "开房间");
  const guest = await call(
    game,
    "guest",
    "c2",
    "submit_lobby_text",
    "加入房间，房间号1234。",
  );
  assertEquals(guest.caller?.say, "已加入。请选角色并准备。");
  assertEquals(guest.caller?.wait, false);
  assertEquals(guest.pushes[0]?.delivery.say, "对手来了。请选角色并准备。");

  const spoken = engine({ value: 0 });
  await call(spoken, "host", "c1", "submit_lobby_text", "开房间");
  const byDigits = await call(
    spoken,
    "guest",
    "c2",
    "submit_lobby_text",
    "1、2、3、4",
  );
  assertEquals(byDigits.caller?.say, "已加入。请选角色并准备。");

  const own = engine({ value: 0 });
  await call(own, "host", "c1", "submit_lobby_text", "开房间");
  const hostAgain = await call(
    own,
    "host",
    "c2",
    "submit_lobby_text",
    "加入房间，房间号1234",
  );
  assertEquals(hostAgain.caller?.say.includes("你是房主"), true);
  assertEquals(hostAgain.caller?.wait, false);

  const absent = await call(
    own,
    "other",
    "c3",
    "submit_lobby_text",
    "加入房间，房间号9999。",
  );
  assertEquals(absent.caller?.say, "没有这个房间。");
  assertEquals(absent.caller?.wait, false);
});

Deno.test("practice does not wait for an opponent", async () => {
  const game = engine({ value: 0 });
  const needRole = await call(game, "d1", "c1", "submit_lobby_text", "练习");
  assertEquals(
    needRole.caller?.say,
    "先说角色名。可选烈焰剑士、圣光守卫、暗影术士、风行弓手。",
  );
  const listed = await call(
    game,
    "d1",
    "c2",
    "submit_lobby_text",
    "有什么角色",
  );
  assertEquals(listed.caller?.say.includes("烈焰剑士"), true);
  const picked = await call(game, "d1", "c3", "submit_lobby_text", "风行弓手");
  assertEquals(picked.caller?.say.includes("疾风箭"), true);
  assertEquals(picked.caller?.phase, "PRACTICE");
  assertEquals(picked.caller?.wait, false);

  const again = engine({ value: 0 });
  await call(again, "d1", "c1", "submit_lobby_text", "风行弓手");
  const start = await call(again, "d1", "c2", "submit_lobby_text", "开始吧");
  assertEquals(start.caller?.say.includes("疾风箭"), true);
  assertEquals(start.caller?.phase, "PRACTICE");
});

Deno.test("practice leaves an empty online room instead of waiting for a guest", async () => {
  const game = engine({ value: 0 });
  await call(game, "d1", "c1", "submit_lobby_text", "开房间");
  await call(game, "d1", "c2", "submit_lobby_text", "风行弓手");
  const practice = await call(game, "d1", "c3", "submit_lobby_text", "练习");
  assertEquals(practice.caller?.say.includes("疾风箭"), true);
  assertEquals(practice.caller?.phase, "PRACTICE");
  assertEquals(practice.caller?.say.includes("等对手"), false);

  const stuck = engine({ value: 0 });
  await call(stuck, "d1", "c1", "submit_lobby_text", "开房间");
  await call(stuck, "d1", "c2", "submit_lobby_text", "风行弓手");
  const ready = await call(stuck, "d1", "c3", "submit_lobby_text", "准备");
  assertEquals(ready.caller?.say.includes("对手还没来"), true);
  assertEquals(ready.caller?.say.includes("你已准备"), false);
  assertEquals(ready.caller?.wait, false);
});

Deno.test("versus cpu and online join still open without practice interference", async () => {
  const cpu = engine({ value: 0 });
  await call(cpu, "d1", "c1", "submit_lobby_text", "对电脑");
  await call(cpu, "d1", "c2", "submit_lobby_text", "风行弓手");
  const ready = await call(cpu, "d1", "c3", "submit_lobby_text", "准备");
  assertEquals(ready.caller?.say.includes("三。二。一。"), true);
  assertEquals(ready.caller?.wait, true);

  const online = engine({ value: 0 });
  const opened = await call(
    online,
    "host",
    "c1",
    "submit_lobby_text",
    "开房间",
  );
  assertEquals(opened.caller?.wait, true);
  const joined = await call(online, "guest", "c2", "submit_lobby_text", "1234");
  assertEquals(joined.caller?.wait, false);
  assertEquals(joined.pushes[0]?.delivery.say, "对手来了。请选角色并准备。");
  assertEquals(joined.pushes[0]?.delivery.wait, true);
  const hostSel = await call(
    online,
    "host",
    "c3",
    "submit_lobby_text",
    "烈焰剑士",
  );
  assertEquals(hostSel.pushes[0]?.delivery.say, "对手选了烈焰剑士。");
  await call(online, "guest", "c4", "submit_lobby_text", "风行弓手");
  const hostReady = await call(
    online,
    "host",
    "c5",
    "submit_lobby_text",
    "准备",
  );
  assertEquals(hostReady.caller?.say, "你已准备。等对手准备。");
  assertEquals(hostReady.pushes[0]?.delivery.say, "对手已准备。");
  const guestReady = await call(
    online,
    "guest",
    "c6",
    "submit_lobby_text",
    "准备",
  );
  assertEquals(guestReady.caller?.say.includes("三。二。一。"), true);
  assertEquals(
    guestReady.pushes[0]?.delivery.say.includes("三。二。一。"),
    true,
  );
});

Deno.test("engine snapshot restores the selected character and the room", async () => {
  const now = { value: 0 };
  const first = engine(now);
  await call(first, "host", "c1", "submit_lobby_text", "烈焰剑士");
  await call(first, "host", "c2", "submit_lobby_text", "开房间");
  const restored = engine(now);
  restored.loadState(first.exportState());
  const replay = await call(
    restored,
    "host",
    "c1",
    "submit_lobby_text",
    "烈焰剑士",
  );
  assertEquals(replay.caller?.say, "已选烈焰剑士。");
  const joined = await call(
    restored,
    "guest",
    "c3",
    "submit_lobby_text",
    "1234",
  );
  assertEquals(joined.caller?.say, "已加入。请选角色并准备。");
});
