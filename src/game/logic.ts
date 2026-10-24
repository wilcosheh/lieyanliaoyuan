import { pinyin } from "pinyin-pro";

export const SIMUL_MS = 300;
export const MATCH_MS = 600_000;
export const HP = 30;
export const MANA_START = 4;
export const MANA_CAP = 10;
export const MANA_REGEN_MS = 1000;
export const FAIL_SILENCE_MS = 1500;
export const FIZZLE_SILENCE_MS = 1000;
export const INTERRUPT_SILENCE_MS = 2000;

export type Grade = "perfect" | "standard";

export type Spell = {
  id: string;
  name: string;
  mana: number;
  channelMs: number;
  cooldownMs: number;
  damage: number;
  silenceMs: number;
  shield: number;
  shieldMs: number;
  sfx: string;
};

// 吟唱比「说完就能结算」的版本更长：对手要先听到战报、再开口、再走完一轮语音识别。
export const SPELLS: Spell[] = [
  {
    id: "huoshi",
    name: "火矢",
    mana: 2,
    channelMs: 0,
    cooldownMs: 3000,
    damage: 4,
    silenceMs: 0,
    shield: 0,
    shieldMs: 0,
    sfx: "huoshi",
  },
  {
    id: "shuimu",
    name: "水幕",
    mana: 3,
    channelMs: 0,
    cooldownMs: 8000,
    damage: 0,
    silenceMs: 0,
    shield: 8,
    shieldMs: 6000,
    sfx: "shuimu",
  },
  {
    id: "hanshuang",
    name: "寒霜止步",
    mana: 4,
    channelMs: 4500,
    cooldownMs: 8000,
    damage: 3,
    silenceMs: 3000,
    shield: 0,
    shieldMs: 0,
    sfx: "hanshuang",
  },
  {
    id: "lieyan",
    name: "烈焰燎原",
    mana: 5,
    channelMs: 6000,
    cooldownMs: 5000,
    damage: 12,
    silenceMs: 0,
    shield: 0,
    shieldMs: 0,
    sfx: "lieyan",
  },
  {
    id: "jiutian",
    name: "九天神火焚尽八荒",
    mana: 9,
    channelMs: 8000,
    cooldownMs: 0,
    damage: 25,
    silenceMs: 0,
    shield: 0,
    shieldMs: 0,
    sfx: "jiutian",
  },
];

export const SFX_NAMES = [
  "huoshi",
  "shuimu",
  "hanshuang",
  "lieyan",
  "jiutian",
  "duan",
  "sheng",
  "bai",
  "bao",
  "ping",
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

const FILLER = new Set([
  "a",
  "ai",
  "ya",
  "yo",
  "yao",
  "en",
  "eng",
  "e",
  "ei",
  "o",
  "ou",
  "ne",
  "ba",
  "bei",
  "ha",
  "wa",
  "wo",
  "de",
  "le",
  "ma",
  "me",
  "na",
  "la",
  "lo",
]);

export function syllablesOf(text: string): string[] {
  const cleaned = text.replace(/[^\u3400-\u9fff]/g, "");
  if (!cleaned) return [];
  const raw = pinyin(cleaned, {
    toneType: "none",
    type: "array",
    nonZh: "removed",
  });
  const list = Array.isArray(raw) ? raw : String(raw).split(/\s+/);
  return list
    .map((s) => s.toLowerCase().replaceAll("ü", "v").replaceAll("u:", "v"))
    .filter((s) => s.length > 0);
}

export function normalizeSyllables(text: string): string[] {
  const syl = syllablesOf(text);
  while (syl.length && FILLER.has(syl[0]!)) syl.shift();
  while (syl.length && FILLER.has(syl[syl.length - 1]!)) syl.pop();
  return syl;
}

const spellSylCache = new Map<string, string[]>();

export function spellSyllables(spell: Spell): string[] {
  const hit = spellSylCache.get(spell.id);
  if (hit) return hit;
  const syl = syllablesOf(spell.name);
  spellSylCache.set(spell.id, syl);
  return syl;
}

function hamming(a: string[], b: string[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function levenshtein(a: string[], b: string[]): number {
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function isStandard(input: string[], spell: string[]): boolean {
  if (spell.length < 4) return false;
  const allowed = spell.length >= 8 ? 2 : 1;
  if (input.length === spell.length) {
    const wrong = hamming(input, spell);
    return wrong > 0 && wrong <= allowed;
  }
  if (input.length === spell.length + 1) {
    const best = Math.min(
      hamming(input.slice(1), spell),
      hamming(input.slice(0, -1), spell),
    );
    return best <= allowed;
  }
  if (input.length === spell.length - 1) {
    const dist = levenshtein(input, spell);
    return dist > 0 && dist <= allowed;
  }
  return false;
}

export type MatchHit = { spell: Spell; grade: Grade } | {
  fail: "none" | "multi";
};

export function matchUtterance(text: string): MatchHit {
  const input = normalizeSyllables(text);
  if (input.length === 0) return { fail: "none" };

  type Span = { spell: Spell; start: number; end: number };
  const spans: Span[] = [];
  for (const spell of SPELLS) {
    const syl = spellSyllables(spell);
    for (let i = 0; i + syl.length <= input.length; i++) {
      let ok = true;
      for (let j = 0; j < syl.length; j++) {
        if (input[i + j] !== syl[j]) ok = false;
      }
      if (ok) spans.push({ spell, start: i, end: i + syl.length });
    }
  }
  const outer = spans.filter((s) =>
    !spans.some((o) =>
      o !== s && o.start <= s.start && o.end >= s.end &&
      (o.end - o.start) > (s.end - s.start)
    )
  );
  const unique: Spell[] = [];
  for (const s of outer) {
    if (!unique.includes(s.spell)) unique.push(s.spell);
  }
  if (unique.length >= 2) return { fail: "multi" };
  if (unique.length === 1) {
    const spell = unique[0]!;
    const syl = spellSyllables(spell);
    if (input.length === syl.length && hamming(input, syl) === 0) {
      return { spell, grade: "perfect" };
    }
    if (isStandard(input, syl)) return { spell, grade: "standard" };
    return { fail: "none" };
  }

  let best: { spell: Spell; score: number } | null = null;
  for (const spell of SPELLS) {
    const syl = spellSyllables(spell);
    if (!isStandard(input, syl)) continue;
    const score = syl.length * 10 - levenshtein(input, syl);
    if (!best || score > best.score) best = { spell, score };
  }
  if (best) return { spell: best.spell, grade: "standard" };
  return { fail: "none" };
}

export function gradeMul(grade: Grade): number {
  return grade === "perfect" ? 1 : 0.7;
}

export type Func = {
  name: "linx_play" | "linx_stop" | "change_role";
  arguments: Record<string, string>;
};

export type Line = { text: string; funcs: Func[] };

export type RpcId = number | string;

export type Player = {
  deviceId: string;
  name: string;
  ready: boolean;
  hp: number;
  mana: number;
  manaAt: number;
  silenceUntil: number;
  shield: { left: number; until: number } | null;
  cds: Record<string, number>;
  channel: { spellId: string; grade: Grade; resolveAt: number } | null;
  agentId: string;
  sessionId: string;
};

export type Phase = "lobby" | "battle" | "ended";

export type World = {
  code: string;
  phase: Phase;
  players: Player[];
  startedAt: number;
  endsAt: number;
  winner: string | null;
  endReason: string;
  log: string[];
  round: number;
};

export type AudioJob = {
  utterance: string;
  sessionId: string;
  agentId: string;
  nextTryAt: number;
  tries: number;
};

export type RoomState = {
  world: World;
  pending: Record<string, { rpcId: RpcId; tool: string; since: number }>;
  queued: Record<string, Line[]>;
  audio: Record<string, AudioJob>;
};

export type JsonResult = {
  jsonrpc: "2.0";
  id: RpcId;
  result: {
    content: { type: "text"; text: string }[];
    structuredContent?: { code: number; message: string; funcs: Func[] };
    isError: boolean;
  };
};

export type OutItem = { deviceId: string; body: JsonResult };

export const LOBBY_PROMPT =
  "你是烈焰燎原的房间主持人。你必须先把工具返回的文本原样说出来，不补充、不解释、不加表情，不要说为您播放，不要说正在播放，说完才能调用下一个工具。不要询问房间名称。玩家报出名字就调用 set_name。玩家要开房间就立刻调用 create_room。玩家说出四位房间号就调用 join_room。玩家说准备就调用 ready。文本如果是三二一开战，要一口气原样念完。开战之后先把血量原样说出来，玩家接着说的每一句都调用 cast，utterance 是玩家原话。血量到0才分胜负，中间可以打很多回合。玩家说看血就调用 match_status。玩家说投降就调用 surrender。文本如果只有一个句号，不要出声，立刻再调用 wait_event。工具超时、被取消或失败，也不要出声，立刻再调用 wait_event。";

export const BATTLE_PROMPT =
  "你是烈焰燎原的战场播报。你必须先把工具返回的文本原样说出来，比分和血量都要念，不要说为您播放，不要说正在播放，说完才能调用下一个工具。玩家每说完一句，立刻调用 cast，utterance 必须是玩家原话，一字不改。文本如果只有一个句号，不要出声，立刻再调用 wait_event。wait_event 超时、被取消或失败，马上再次调用。玩家说投降就调用 surrender。玩家说看血就调用 match_status。";

// 灵矽大约 26 秒会取消还没返回的工具调用。提前交还句号，让模型自己再挂上。
export const HOLD_MS = 18_000;

export const REVIEW_PROMPT =
  "对局已经结束。你把工具返回的文本原样说出来。玩家说复盘就调用 review_last_match。玩家要再来一局，就调用 create_room 或 join_room。不要调用 cast。";

export function toolResult(id: RpcId, line: Line, isError = false): JsonResult {
  const result: JsonResult = {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: line.text }],
      isError,
    },
  };
  if (line.funcs.length) {
    result.result.structuredContent = {
      code: 0,
      message: line.text,
      funcs: line.funcs,
    };
  }
  return result;
}

export function speak(text: string, funcs: Func[] = []): Line {
  return { text, funcs };
}

export function play(sfxBase: string, name: string, title: string): Func {
  return {
    name: "linx_play",
    arguments: { audio_url: `${sfxBase}/sfx/${name}.wav`, title },
  };
}

export function playUrl(url: string, title: string): Func {
  return { name: "linx_play", arguments: { audio_url: url, title } };
}

export function changeRole(prompt: string): Func {
  return { name: "change_role", arguments: { role_prompt: prompt } };
}

export function manaOf(p: Player, now: number): number {
  const gained = Math.floor(Math.max(0, now - p.manaAt) / MANA_REGEN_MS);
  return Math.min(MANA_CAP, p.mana + gained);
}

export function makePlayer(
  deviceId: string,
  name: string,
  now: number,
): Player {
  return {
    deviceId,
    name: name || "玩家",
    ready: false,
    hp: HP,
    mana: MANA_START,
    manaAt: now,
    silenceUntil: 0,
    shield: null,
    cds: {},
    channel: null,
    agentId: "",
    sessionId: "",
  };
}

export function emptyRoom(code: string, host: Player): RoomState {
  return {
    world: {
      code,
      phase: "lobby",
      players: [host],
      startedAt: 0,
      endsAt: 0,
      winner: null,
      endReason: "",
      log: [],
      round: 0,
    },
    pending: {},
    queued: {},
    audio: {},
  };
}

export function cleanName(name: string): string {
  return name.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "").slice(0, 8);
}

export function roomCodeOf(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return digits.slice(-4);
}

export function roomCodeFromArgs(args: Record<string, unknown>): string {
  const named = roomCodeOf(
    args.code ?? args.room_id ?? args.roomId ?? args.room,
  );
  if (named) return named;
  for (const value of Object.values(args)) {
    const code = roomCodeOf(value);
    if (code) return code;
  }
  return "";
}

export type ToolOp = {
  type: "tool";
  deviceId: string;
  agentId: string;
  sessionId: string;
  rpcId: RpcId;
  name: string;
  args: Record<string, unknown>;
  audioEnabled: boolean;
  sfxBase: string;
  now: number;
};

export type Op =
  | ToolOp
  | { type: "tick"; now: number; sfxBase: string }
  | {
    type: "audio";
    deviceId: string;
    url: string | null;
    now: number;
  }
  | { type: "cancel"; deviceId: string; rpcId: RpcId }
  | { type: "remove"; deviceId: string; now: number; sfxBase: string };

export function reduce(input: RoomState, op: Op): {
  state: RoomState;
  outbox: OutItem[];
} {
  const state = structuredClone(input);
  const bucket = new Map<string, Line[]>();
  const extra: OutItem[] = [];
  const add = (deviceId: string, line: Line) => {
    const cur = bucket.get(deviceId) ?? [];
    cur.push(line);
    bucket.set(deviceId, cur);
  };

  let parked = false;
  let immediateId: string | null = null;
  let rpcId: RpcId | null = null;

  if (op.type === "cancel") {
    const pending = state.pending[op.deviceId];
    if (pending && String(pending.rpcId) === String(op.rpcId)) {
      delete state.pending[op.deviceId];
    }
    return { state, outbox: [] };
  }

  if (op.type === "remove") {
    removePlayer(state, op.deviceId, op.now, op.sfxBase, add);
  } else if (op.type === "tick") {
    settleDue(state, op.now, op.sfxBase, add);
    releaseHolds(state, op.now, op.sfxBase, bucket, extra);
  } else if (op.type === "audio") {
    delete state.audio[op.deviceId];
    if (op.url) {
      const opp = other(state, op.deviceId);
      if (opp) {
        add(opp.deviceId, speak("对方原声。", [playUrl(op.url, "对方咒语")]));
      }
    }
  } else {
    immediateId = op.deviceId;
    rpcId = op.rpcId;
    const prev = state.pending[op.deviceId];
    if (prev && String(prev.rpcId) !== String(op.rpcId)) {
      delete state.pending[op.deviceId];
      extra.push({
        deviceId: op.deviceId,
        body: toolResult(prev.rpcId, speak("。")),
      });
    }
    parked = applyTool(state, op, add, (id) => bucket.has(id));
    if (parked) immediateId = null;
  }

  const outbox = extra.concat(flush(state, bucket, immediateId, rpcId));
  return { state, outbox };
}

function applyTool(
  state: RoomState,
  op: ToolOp,
  add: (deviceId: string, line: Line) => void,
  fresh: (deviceId: string) => boolean,
): boolean {
  const self = player(state, op.deviceId);
  if (self) {
    if (op.agentId) self.agentId = op.agentId;
    if (op.sessionId) self.sessionId = op.sessionId;
  }

  switch (op.name) {
    case "set_name": {
      const name = cleanName(String(op.args.name ?? ""));
      if (!name) {
        add(op.deviceId, speak("没听清名字。"));
        return false;
      }
      if (self) self.name = name;
      add(op.deviceId, speak(`已记下，你是${name}。`));
      return false;
    }
    case "join_room": {
      if (self) {
        add(op.deviceId, speak(`你已经在${state.world.code}。`));
        return false;
      }
      if (state.world.phase !== "lobby") {
        add(op.deviceId, speak("这局已经开始了。"));
        return false;
      }
      if (state.world.players.length >= 2) {
        add(op.deviceId, speak("房间满了。"));
        return false;
      }
      const name = cleanName(String(op.args.name ?? "")) || "玩家";
      const joined = makePlayer(op.deviceId, name, op.now);
      joined.agentId = op.agentId;
      joined.sessionId = op.sessionId;
      state.world.players.push(joined);
      add(op.deviceId, speak(`已加入${state.world.code}。说准备开战。`));
      const host = other(state, op.deviceId);
      if (host) add(host.deviceId, speak("对手来了。说准备。"));
      return false;
    }
    case "ready": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      if (state.world.phase !== "lobby") {
        add(op.deviceId, speak("这局不能准备。"));
        return false;
      }
      self.ready = true;
      if (!bothReady(state)) {
        state.pending[op.deviceId] = {
          rpcId: op.rpcId,
          tool: "ready",
          since: op.now,
        };
        return true;
      }
      startMatch(state, op.now);
      for (const p of state.world.players) {
        delete state.queued[p.deviceId];
        add(p.deviceId, openingLine(state, p, op.sfxBase, op.now));
      }
      state.world.log.push("开战");
      return false;
    }
    case "wait_event": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      settleDue(state, op.now, op.sfxBase, add);
      const queued = state.queued[op.deviceId] ?? [];
      if (queued.length === 0 && !fresh(op.deviceId)) {
        state.pending[op.deviceId] = {
          rpcId: op.rpcId,
          tool: "wait_event",
          since: op.now,
        };
        return true;
      }
      return false;
    }
    case "match_status": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      settleDue(state, op.now, op.sfxBase, add);
      if (state.world.phase !== "battle") {
        if (!fresh(op.deviceId)) {
          add(
            op.deviceId,
            speak(
              state.world.phase === "ended"
                ? `${verdictFor(state, self)}${scoreText(state, self)}`
                : "还没开战。",
            ),
          );
        }
        return false;
      }
      add(op.deviceId, battleStatus(state, self, op.sfxBase, op.now, "看血。"));
      return false;
    }
    case "surrender": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      if (state.world.phase !== "battle") {
        add(op.deviceId, speak("还没开战。"));
        return false;
      }
      const opp = other(state, self.deviceId);
      if (!opp) {
        add(op.deviceId, speak("还没有对手。"));
        return false;
      }
      finish(state, opp.deviceId, "surrender");
      state.world.log.push(`${self.name}认输`);
      add(self.deviceId, verdictLine(state, self, op.sfxBase, "你认输了。"));
      add(opp.deviceId, verdictLine(state, opp, op.sfxBase, "对手认输。"));
      return false;
    }
    case "review_last_match": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      if (state.world.phase !== "ended") {
        add(op.deviceId, speak("对局还没结束。"));
        return false;
      }
      const recap = state.world.log.slice(-6).join("。");
      add(
        op.deviceId,
        speak(
          recap
            ? `${verdictFor(state, self)}${recap}。`
            : verdictFor(state, self),
        ),
      );
      return false;
    }
    case "cast": {
      if (!self) {
        add(op.deviceId, speak("你不在这间房。"));
        return false;
      }
      settleDue(state, op.now, op.sfxBase, add);
      if (state.world.phase !== "battle") {
        if (!fresh(op.deviceId)) {
          add(
            op.deviceId,
            speak(
              state.world.phase === "ended"
                ? verdictFor(state, self)
                : "还没开战。",
            ),
          );
        }
        return false;
      }
      castSpell(state, self, op, add);
      return false;
    }
    default:
      add(op.deviceId, speak("没有这个动作。"));
      return false;
  }
}

function castSpell(
  state: RoomState,
  self: Player,
  op: ToolOp,
  add: (deviceId: string, line: Line) => void,
) {
  const now = op.now;
  const utterance = String(op.args.utterance ?? op.args.text ?? "").trim();
  const opp = other(state, self.deviceId);
  if (!opp) {
    add(self.deviceId, speak("还没有对手。"));
    return;
  }
  if (!utterance) {
    add(self.deviceId, speak("咒语没成。"));
    return;
  }
  if (self.silenceUntil > now) {
    add(self.deviceId, speak("禁言中。"));
    noteAudio(state, self, opp, utterance, op, add);
    return;
  }
  const matched = matchUtterance(utterance);
  if ("fail" in matched) {
    self.silenceUntil = now + FAIL_SILENCE_MS;
    add(
      self.deviceId,
      speak(matched.fail === "multi" ? "一次一道。" : "咒语没成。"),
    );
    state.world.log.push(`${self.name}念偏了`);
    noteAudio(state, self, opp, utterance, op, add);
    return;
  }
  const spell = matched.spell;
  if (manaOf(self, now) < spell.mana) {
    syncMana(self, now);
    self.silenceUntil = Math.max(self.silenceUntil, now + FIZZLE_SILENCE_MS);
    add(self.deviceId, speak("法力不足。"));
    noteAudio(state, self, opp, utterance, op, add);
    return;
  }
  if ((self.cds[spell.id] ?? 0) > now) {
    self.silenceUntil = Math.max(self.silenceUntil, now + FIZZLE_SILENCE_MS);
    add(self.deviceId, speak(`${spell.name}冷却中。`));
    noteAudio(state, self, opp, utterance, op, add);
    return;
  }

  syncMana(self, now);
  self.mana -= spell.mana;
  if (spell.cooldownMs > 0) self.cds[spell.id] = now + spell.cooldownMs;

  // 瞬发才能打断吟唱。寒霜止步对上烈焰燎原时，两段吟唱各算各的。
  if (
    spell.channelMs === 0 && opp.channel &&
    opp.channel.resolveAt - now > SIMUL_MS
  ) {
    const broken = spellById(opp.channel.spellId);
    opp.channel = null;
    opp.silenceUntil = Math.max(opp.silenceUntil, now + INTERRUPT_SILENCE_MS);
    state.world.log.push(`${self.name}打断${opp.name}的${broken.name}`);
    add(opp.deviceId, speak("吟唱被打断。"));
  }

  if (spell.channelMs > 0) {
    self.channel = {
      spellId: spell.id,
      grade: matched.grade,
      resolveAt: now + spell.channelMs,
    };
    state.world.log.push(`${self.name}开始吟唱${spell.name}`);
    add(self.deviceId, speak(`你开始吟唱${spell.name}。`));
    add(opp.deviceId, speak(`对手开始吟唱${spell.name}。`));
    noteAudio(state, self, opp, utterance, op, add);
    return;
  }

  const effect = applyEffect(state, self, opp, spell, matched.grade, now);
  emitEffect(state, effect, op.sfxBase, add);
  closeBattle(state, now, op.sfxBase, add);
  noteAudio(state, self, opp, utterance, op, add);
}

function noteAudio(
  state: RoomState,
  self: Player,
  opp: Player,
  utterance: string,
  op: ToolOp,
  add: (deviceId: string, line: Line) => void,
) {
  const direct = String(op.args.audio_url ?? "").trim();
  if (direct) {
    add(opp.deviceId, speak("对方原声。", [playUrl(direct, "对方咒语")]));
    return;
  }
  if (!op.audioEnabled || !self.agentId || !self.sessionId) return;
  state.audio[self.deviceId] = {
    utterance,
    sessionId: self.sessionId,
    agentId: self.agentId,
    nextTryAt: op.now,
    tries: 0,
  };
}

type Effect = {
  casterId: string;
  targetId: string;
  spell: Spell;
  grade: Grade;
  absorbedAll: boolean;
  targetHp: number;
  shield: boolean;
};

function applyEffect(
  state: RoomState,
  caster: Player,
  target: Player,
  spell: Spell,
  grade: Grade,
  now: number,
): Effect {
  const mul = gradeMul(grade);
  caster.channel = null;
  if (spell.shield > 0) {
    caster.shield = {
      left: Math.max(1, Math.round(spell.shield * mul)),
      until: now + spell.shieldMs,
    };
    state.world.log.push(`${caster.name}张开${spell.name}`);
    return {
      casterId: caster.deviceId,
      targetId: target.deviceId,
      spell,
      grade,
      absorbedAll: false,
      targetHp: target.hp,
      shield: true,
    };
  }
  let damage = Math.round(spell.damage * mul);
  let absorbedAll = false;
  if (target.shield && target.shield.until > now && damage > 0) {
    const use = Math.min(target.shield.left, damage);
    damage -= use;
    target.shield = null;
    absorbedAll = damage === 0;
  }
  if (damage > 0) target.hp = Math.max(0, target.hp - damage);
  if (spell.silenceMs > 0) {
    target.silenceUntil = Math.max(
      target.silenceUntil,
      now + Math.round(spell.silenceMs * mul),
    );
  }
  const verb = grade === "perfect" ? "命中" : "擦中";
  state.world.log.push(`${caster.name}${spell.name}${verb}`);
  return {
    casterId: caster.deviceId,
    targetId: target.deviceId,
    spell,
    grade,
    absorbedAll,
    targetHp: target.hp,
    shield: false,
  };
}

function emitEffect(
  state: RoomState,
  effect: Effect,
  sfxBase: string,
  add: (deviceId: string, line: Line) => void,
) {
  const caster = player(state, effect.casterId);
  const target = player(state, effect.targetId);
  if (!caster || !target) return;
  state.world.round = (state.world.round ?? 0) + 1;
  void sfxBase;
  const round = `第${state.world.round}回合。`;
  const casterHp = `你${caster.hp}血。对手${effect.targetHp}血。`;
  const targetHp = `你${effect.targetHp}血。对手${caster.hp}血。`;
  if (effect.shield) {
    add(
      caster.deviceId,
      speak(`${round}${effect.spell.name}张开。${casterHp}`),
    );
    add(
      target.deviceId,
      speak(`${round}对手张开${effect.spell.name}。${targetHp}`),
    );
    return;
  }
  const verb = effect.grade === "perfect" ? "命中" : "擦中";
  if (effect.absorbedAll) {
    add(
      caster.deviceId,
      speak(`${round}${effect.spell.name}被挡住。${casterHp}`),
    );
    add(
      target.deviceId,
      speak(`${round}水幕挡住${effect.spell.name}。${targetHp}`),
    );
    return;
  }
  add(
    caster.deviceId,
    speak(`${round}${effect.spell.name}${verb}。${casterHp}`),
  );
  add(
    target.deviceId,
    speak(`${round}中了${effect.spell.name}。${targetHp}`),
  );
}

function closeBattle(
  state: RoomState,
  now: number,
  sfxBase: string,
  add: (deviceId: string, line: Line) => void,
) {
  if (state.world.phase !== "battle") return;
  const dead = state.world.players.filter((p) => p.hp <= 0);
  if (dead.length > 0) {
    if (dead.length >= 2 || state.world.players.every((p) => p.hp <= 0)) {
      finish(state, "draw", "ko");
    } else {
      const winner = state.world.players.find((p) => p.hp > 0);
      finish(state, winner ? winner.deviceId : "draw", "ko");
    }
    for (const p of state.world.players) {
      add(p.deviceId, verdictLine(state, p, sfxBase, ""));
    }
    return;
  }
  if (state.world.endsAt > 0 && now >= state.world.endsAt) {
    timeout(state, sfxBase, add);
  }
}

function timeout(
  state: RoomState,
  sfxBase: string,
  add: (deviceId: string, line: Line) => void,
) {
  const [a, b] = state.world.players;
  if (!a || !b) return;
  finish(state, "draw", "timeout");
  state.world.log.push("时间到");
  add(a.deviceId, verdictLine(state, a, sfxBase, "时间到。"));
  add(b.deviceId, verdictLine(state, b, sfxBase, "时间到。"));
}

function settleDue(
  state: RoomState,
  now: number,
  sfxBase: string,
  add: (deviceId: string, line: Line) => void,
) {
  if (state.world.phase !== "battle") return;
  const due = state.world.players.filter((p) =>
    p.channel && p.channel.resolveAt <= now
  );
  const effects: Effect[] = [];
  for (const caster of due) {
    const channel = caster.channel;
    if (!channel) continue;
    caster.channel = null;
    const target = other(state, caster.deviceId);
    if (!target) continue;
    effects.push(applyEffect(
      state,
      caster,
      target,
      spellById(channel.spellId),
      channel.grade,
      now,
    ));
  }
  for (const effect of effects) emitEffect(state, effect, sfxBase, add);
  closeBattle(state, now, sfxBase, add);
}

function finish(state: RoomState, winner: string, reason: string) {
  state.world.phase = "ended";
  state.world.winner = winner;
  state.world.endReason = reason;
  for (const p of state.world.players) {
    p.channel = null;
    p.ready = false;
  }
}

function startMatch(state: RoomState, now: number) {
  state.world.phase = "battle";
  state.world.startedAt = now;
  state.world.endsAt = now + MATCH_MS;
  state.world.winner = null;
  state.world.endReason = "";
  state.world.log = [];
  state.world.round = 0;
  for (const p of state.world.players) {
    p.hp = HP;
    p.mana = MANA_START;
    p.manaAt = now;
    p.silenceUntil = 0;
    p.shield = null;
    p.cds = {};
    p.channel = null;
    p.ready = true;
  }
}

function openingLine(
  state: RoomState,
  p: Player,
  _sfxBase: string,
  _now: number,
): Line {
  return speak(
    `三。二。一。开战。双方各${p.hp}血。血量先到0的一方落败。开始念咒。`,
  );
}

function scoreText(state: RoomState, p: Player): string {
  const opp = other(state, p.deviceId);
  const mine = p.hp;
  const theirs = opp ? opp.hp : 0;
  const pace = mine > theirs
    ? "你领先。"
    : mine < theirs
    ? "你落后。"
    : "血量持平。";
  return `${pace}你${mine}血。对手${theirs}血。`;
}

function battleStatus(
  state: RoomState,
  p: Player,
  sfxBase: string,
  now: number,
  leadIn: string,
): Line {
  const played = state.world.round > 0
    ? `已经打了${state.world.round}回合。`
    : "";
  void sfxBase;
  return speak(
    `${leadIn}${played}${scoreText(state, p)}法力${
      manaOf(p, now)
    }。血量到0才分胜负。继续念火矢、水幕、寒霜止步、烈焰燎原或九天神火。`,
  );
}

function verdictFor(state: RoomState, p: Player): string {
  if (state.world.winner === "draw" || state.world.winner === null) {
    return "平局。";
  }
  return state.world.winner === p.deviceId ? "你赢了。" : "你输了。";
}

function verdictLine(
  state: RoomState,
  p: Player,
  sfxBase: string,
  prefix: string,
): Line {
  void sfxBase;
  const verdict = verdictFor(state, p);
  return speak(`${prefix}${verdict}${scoreText(state, p)}`, [
    changeRole(REVIEW_PROMPT),
  ]);
}

function removePlayer(
  state: RoomState,
  deviceId: string,
  now: number,
  sfxBase: string,
  add: (deviceId: string, line: Line) => void,
) {
  const self = player(state, deviceId);
  if (!self) return;
  const opp = other(state, deviceId);
  if (state.world.phase === "battle" && opp) {
    finish(state, opp.deviceId, "leave");
    state.world.log.push(`${self.name}离开`);
    add(opp.deviceId, verdictLine(state, opp, sfxBase, "对手离开。"));
  }
  state.world.players = state.world.players.filter((p) =>
    p.deviceId !== deviceId
  );
  delete state.pending[deviceId];
  delete state.queued[deviceId];
  delete state.audio[deviceId];
  void now;
}

function flush(
  state: RoomState,
  bucket: Map<string, Line[]>,
  immediateId: string | null,
  rpcId: RpcId | null,
): OutItem[] {
  const out: OutItem[] = [];
  if (immediateId && rpcId !== null) {
    const prev = state.queued[immediateId] ?? [];
    const lines = bucket.get(immediateId) ?? [];
    delete state.queued[immediateId];
    bucket.delete(immediateId);
    if (lines.length) {
      out.push(ship(state, immediateId, rpcId, lines));
      const rest = state.queued[immediateId] ?? [];
      if (prev.length || rest.length) {
        state.queued[immediateId] = [...prev, ...rest];
      }
    } else if (prev.length) {
      out.push(ship(state, immediateId, rpcId, prev));
    }
  }
  for (const [deviceId, lines] of bucket) {
    const prev = state.queued[deviceId] ?? [];
    delete state.queued[deviceId];
    const pending = state.pending[deviceId];
    if (pending && canFulfill(state, pending.tool)) {
      delete state.pending[deviceId];
      out.push(ship(state, deviceId, pending.rpcId, [...prev, ...lines]));
      continue;
    }
    const kept = [...prev, ...lines];
    if (kept.length) state.queued[deviceId] = kept;
  }
  return out;
}

function releaseHolds(
  state: RoomState,
  now: number,
  sfxBase: string,
  bucket: Map<string, Line[]>,
  extra: OutItem[],
) {
  for (const deviceId of Object.keys(state.pending)) {
    const pending = state.pending[deviceId];
    if (!pending) continue;
    if (typeof pending.since !== "number") {
      pending.since = now;
      continue;
    }
    if (now - pending.since < HOLD_MS) continue;
    const prev = state.queued[deviceId] ?? [];
    const fresh = bucket.get(deviceId) ?? [];
    delete state.queued[deviceId];
    bucket.delete(deviceId);
    delete state.pending[deviceId];
    const kept = [...prev, ...fresh];
    const self = player(state, deviceId);
    const beat = state.world.phase === "battle" && self
      ? battleStatus(state, self, sfxBase, now, "对战中。")
      : speak("。");
    extra.push(
      ship(
        state,
        deviceId,
        pending.rpcId,
        kept.length ? kept : [beat],
      ),
    );
  }
}

function present(
  state: RoomState,
  deviceId: string,
  rpcId: RpcId,
  line: Line,
): OutItem {
  const role = line.funcs.find((func) => func.name === "change_role");
  const rest = line.funcs.filter((func) => func.name !== "change_role");
  const spoken = !role || (line.text === "。" && rest.length === 0)
    ? line
    : { text: line.text, funcs: rest };
  if (role && spoken !== line) {
    const queued = state.queued[deviceId] ?? [];
    queued.push(speak("。", [role]));
    state.queued[deviceId] = queued;
  }
  return { deviceId, body: toolResult(rpcId, spoken) };
}

function canFulfill(_state: RoomState, tool: string): boolean {
  return tool === "wait_event" || tool === "ready";
}

function ship(
  state: RoomState,
  deviceId: string,
  rpcId: RpcId,
  lines: Line[],
): OutItem {
  const { now, later } = speakOne(lines);
  if (later.length) {
    const queued = state.queued[deviceId] ?? [];
    state.queued[deviceId] = [...later, ...queued];
  }
  return present(state, deviceId, rpcId, fold(now));
}

// 一句一句交给主持人念。胜负和对方原声跟在当前这句后面，下一则战报留到下一次。
function speakOne(lines: Line[]): { now: Line[]; later: Line[] } {
  if (lines.length === 0) return { now: [speak("。")], later: [] };
  const now = [lines[0]!];
  let index = 1;
  if (lines[0]!.text.includes("吟唱被打断") && index < lines.length) {
    now.push(lines[index]!);
    index++;
  }
  while (index < lines.length && attaches(lines[index]!)) {
    now.push(lines[index]!);
    index++;
  }
  return { now, later: lines.slice(index) };
}

function attaches(line: Line): boolean {
  if (spellPlay(line)) return false;
  return line.text.startsWith("对方原声") ||
    /你赢了|你输了|平局/.test(line.text);
}

function spellPlay(line: Line): boolean {
  return line.funcs.some((func) => {
    if (func.name !== "linx_play") return false;
    const url = func.arguments.audio_url ?? "";
    return /\/sfx\/(huoshi|shuimu|hanshuang|lieyan|jiutian)\.wav$/.test(url);
  });
}

function fold(lines: Line[]): Line {
  if (lines.length === 1) {
    return { text: lines[0]!.text, funcs: [...lines[0]!.funcs] };
  }
  const text = lines.map((l) => l.text.replace(/。$/, "")).filter((t) =>
    t.length > 0
  )
    .join("。");
  const funcs: Func[] = [];
  let role: Func | undefined;
  for (const line of lines) {
    for (const func of line.funcs) {
      if (func.name === "change_role") role = func;
      else funcs.push(func);
    }
  }
  if (role) funcs.unshift(role);
  const spoken = text.length === 0
    ? "。"
    : (text.endsWith("。") ? text : `${text}。`);
  return { text: spoken.slice(0, 80), funcs };
}

function bothReady(state: RoomState): boolean {
  return state.world.players.length === 2 &&
    state.world.players.every((p) => p.ready);
}

function player(state: RoomState, id: string): Player | undefined {
  return state.world.players.find((p) => p.deviceId === id);
}

function other(state: RoomState, id: string): Player | undefined {
  return state.world.players.find((p) => p.deviceId !== id);
}

function spellById(id: string): Spell {
  const spell = SPELLS.find((s) => s.id === id);
  if (!spell) throw new Error(`unknown spell ${id}`);
  return spell;
}

function syncMana(p: Player, now: number) {
  p.mana = manaOf(p, now);
  p.manaAt = now;
}

export function peekAudio(
  state: RoomState,
  now: number,
): { deviceId: string; job: AudioJob }[] {
  const out: { deviceId: string; job: AudioJob }[] = [];
  for (const [deviceId, job] of Object.entries(state.audio)) {
    if (job.nextTryAt <= now && job.tries < 5) out.push({ deviceId, job });
  }
  return out;
}

export function bumpAudio(
  state: RoomState,
  deviceId: string,
  now: number,
): RoomState {
  const next = structuredClone(state);
  const job = next.audio[deviceId];
  if (!job) return next;
  job.tries += 1;
  job.nextTryAt = now + 2000;
  if (job.tries >= 5) delete next.audio[deviceId];
  return next;
}
