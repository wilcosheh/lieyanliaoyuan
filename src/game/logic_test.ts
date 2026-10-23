import { assert, assertEquals } from "@std/assert";
import {
  emptyRoom,
  type Grade,
  HP,
  makePlayer,
  manaOf,
  matchUtterance,
  normalizeSyllables,
  type OutItem,
  reduce,
  type RoomState,
  SPELLS,
  spellSyllables,
} from "./logic.ts";

const SFX = "http://sfx";

function lineText(items: OutItem[], deviceId?: string): string[] {
  return items
    .filter((item) => deviceId === undefined || item.deviceId === deviceId)
    .map((item) => item.body.result.content[0]!.text);
}

function lineFuncs(items: OutItem[], deviceId: string) {
  return items
    .filter((item) => item.deviceId === deviceId)
    .flatMap((item) => item.body.result.structuredContent?.funcs ?? []);
}

class Table {
  state: RoomState;
  now = 20_000;
  seq = 1;

  constructor() {
    this.state = emptyRoom("4821", makePlayer("a", "甲", this.now));
    this.tool("b", "join_room", { name: "乙" });
  }

  tool(
    deviceId: string,
    name: string,
    args: Record<string, unknown> = {},
    rpcId?: number,
  ): OutItem[] {
    const out = reduce(this.state, {
      type: "tool",
      deviceId,
      agentId: "agent",
      sessionId: `sess-${deviceId}`,
      rpcId: rpcId ?? this.seq++,
      name,
      args,
      audioEnabled: true,
      sfxBase: SFX,
      now: this.now,
    });
    this.state = out.state;
    return out.outbox;
  }

  tick(): OutItem[] {
    const out = reduce(this.state, {
      type: "tick",
      now: this.now,
      sfxBase: SFX,
    });
    this.state = out.state;
    return out.outbox;
  }

  player(id: string) {
    const found = this.state.world.players.find((p) => p.deviceId === id);
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
}

function start(table: Table) {
  const parked = table.tool("a", "ready");
  assertEquals(parked, []);
  assertEquals(table.state.pending.a?.tool, "ready");
  const opened = table.tool("b", "ready");
  assert(lineText(opened, "a").join("").includes("开战"));
  assert(lineText(opened, "b").join("").includes("开战"));
  assert(lineFuncs(opened, "a").some((f) => f.name === "change_role"));
  assertEquals(table.state.world.phase, "battle");
}

Deno.test("拼音按无声调音节对齐咒语", () => {
  assertEquals(normalizeSyllables("火矢！"), ["huo", "shi"]);
  assertEquals(spellSyllables(SPELLS[2]!), ["han", "shuang", "zhi", "bu"]);
  assertEquals(spellSyllables(SPELLS[4]!), [
    "jiu",
    "tian",
    "shen",
    "huo",
    "fen",
    "jin",
    "ba",
    "huang",
  ]);
  assertEquals(grade("火矢"), "perfect");
  assertEquals(grade("啊火矢呀"), "perfect");
  assertEquals(grade("大火矢"), "none");
  assertEquals(grade("寒霜止走"), "standard");
  assertEquals(grade("九天神火焚尽走海"), "standard");
  assertEquals(grade("火矢水幕"), "multi");
  assertEquals(grade("今天天气不错"), "none");
});

function grade(text: string): Grade | "none" | "multi" {
  const hit = matchUtterance(text);
  if ("fail" in hit) return hit.fail;
  return hit.grade;
}

Deno.test("开战、瞬发、水幕和禁言", () => {
  const table = new Table();
  start(table);
  table.now += 10_000;
  assertEquals(manaOf(table.player("a"), table.now), 10);

  table.tool("b", "wait_event");
  const shot = table.tool("a", "cast", {
    utterance: "火矢",
    audio_url: "https://raw/a.wav",
  });
  assert(lineText(shot, "a").join("").includes("火矢命中"));
  assertEquals(table.player("b").hp, HP - 4);
  const urls = lineFuncs(shot, "b").map((f) => f.arguments.audio_url);
  assert(urls.some((url) => url?.endsWith("/sfx/huoshi.wav")));
  assert(urls.includes("https://raw/a.wav"));

  table.tool("a", "wait_event");
  const veil = table.tool("b", "cast", { utterance: "水幕" });
  assert(lineText(veil, "b").join("").includes("水幕张开"));
  table.now += 3_000;
  table.tool("b", "wait_event");
  const blocked = table.tool("a", "cast", { utterance: "火矢" });
  assert(lineText(blocked, "b").join("").includes("水幕挡住火矢"));
  assertEquals(table.player("b").hp, HP - 4);

  table.now += 3_000;
  const again = table.tool("a", "cast", { utterance: "火矢" });
  assert(lineText(again, "a").join("").includes("命中"));
  assertEquals(table.player("b").hp, HP - 8);

  const early = table.tool("a", "cast", { utterance: "火矢" });
  assert(lineText(early, "a").join("").includes("冷却中"));

  const slur = table.tool("b", "cast", { utterance: "火矢水幕" });
  assert(lineText(slur, "b").join("").includes("一次一道"));
  const gagged = table.tool("b", "cast", { utterance: "火矢" });
  assert(lineText(gagged, "b").join("").includes("禁言中"));
});

Deno.test("吟唱可被打断，临近结算则同时生效", () => {
  const table = new Table();
  start(table);
  table.now += 10_000;

  table.tool("a", "wait_event");
  const chant = table.tool("b", "cast", { utterance: "烈焰燎原" });
  assert(lineText(chant, "a").join("").includes("对手吟唱烈焰燎原"));
  const manaAfter = table.player("b").mana;
  table.now += 1_000;
  table.tool("b", "wait_event");
  const cut = table.tool("a", "cast", { utterance: "火矢" });
  assertEquals(table.player("b").channel, null);
  assert(table.player("b").silenceUntil > table.now);
  assertEquals(table.player("b").mana, manaAfter);
  assert(lineText(cut, "b").join("").includes("吟唱被打断"));
  assertEquals(table.player("b").hp, HP - 4);
  assertEquals(table.player("a").hp, HP);

  table.now += 10_000;
  table.tool("b", "cast", { utterance: "烈焰燎原" });
  const resolveAt = table.player("b").channel?.resolveAt ?? 0;
  table.now = resolveAt - 200;
  table.tool("b", "wait_event");
  const both = table.tool("a", "cast", { utterance: "火矢" });
  assert(table.player("b").channel);
  assert(lineText(both, "b").join("").includes("对手火矢"));
  table.now = resolveAt;
  const boom = table.tool("a", "wait_event");
  assertEquals(table.state.world.phase, "battle");
  assertEquals(table.player("a").hp, HP - 12);
  assert(lineText(boom, "a").join("").includes("烈焰燎原"));
});

Deno.test("差一个音算擦中，超时和投降会结算", () => {
  const table = new Table();
  start(table);
  table.now += 10_000;
  const graze = table.tool("b", "cast", { utterance: "寒霜止走" });
  assert(lineText(graze, "b").join("").includes("吟唱寒霜止步"));
  const chant = table.tool("a", "wait_event");
  assert(lineText(chant, "a").join("").includes("吟唱"));
  table.tool("a", "wait_event");
  table.now = table.player("b").channel?.resolveAt ?? table.now;
  const landed = table.tick();
  assert(
    lineText(landed, "a").join("").includes("你28血") ||
      lineText(landed, "a").join("").includes("你27血") ||
      lineText(landed).join("").includes("擦"),
    JSON.stringify(lineText(landed)) + " hp=" + table.player("a").hp,
  );
  assertEquals(table.player("a").hp, HP - 2);
  assert(table.player("a").silenceUntil > table.now);

  table.tool("a", "wait_event");
  table.tool("b", "wait_event");
  table.now = table.state.world.endsAt;
  const ended = table.tick();
  assertEquals(table.state.world.phase, "ended");
  assert(lineText(ended).join("").includes("时间到"));
  const review = table.tool("a", "review_last_match");
  assert(lineText(review, "a").join("").length > 0);
});

Deno.test("血量归零立刻分出胜负", () => {
  const table = new Table();
  start(table);
  table.now += 10_000;
  table.player("b").hp = 4;
  table.tool("b", "wait_event");
  const fin = table.tool("a", "cast", { utterance: "火矢" });
  assertEquals(table.state.world.phase, "ended");
  assertEquals(table.state.world.winner, "a");
  assert(lineText(fin, "a").join("").includes("你赢了"));
  assert(lineText(fin, "b").join("").includes("你输了"));
  assert(
    lineFuncs(fin, "a").some((f) =>
      f.arguments.audio_url?.endsWith("/sfx/sheng.wav")
    ),
  );
  assert(
    lineFuncs(fin, "b").some((f) =>
      f.arguments.audio_url?.endsWith("/sfx/bai.wav")
    ),
  );
});

Deno.test("取消等待后，战报留到下一次 wait_event", () => {
  const table = new Table();
  start(table);
  table.now += 10_000;
  const parked = table.tool("b", "wait_event", {}, 40);
  assertEquals(parked, []);
  const cancelled = reduce(table.state, {
    type: "cancel",
    deviceId: "b",
    rpcId: 40,
  });
  table.state = cancelled.state;
  const shot = table.tool("a", "cast", { utterance: "火矢" });
  assertEquals(lineText(shot, "b"), []);
  const later = table.tool("b", "wait_event");
  assert(
    lineText(later, "b").join("").includes("对手火矢"),
    JSON.stringify(lineText(later)) + " queued=" +
      JSON.stringify(table.state.queued),
  );
});
