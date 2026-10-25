import { extractCharacterName, matchSkill } from "../characters/match.ts";
import { CHARACTERS, getCharacter } from "../characters/skills.ts";
import type { SkillConfig } from "../characters/skills.ts";
import {
  ACK_MS,
  COUNTDOWN_MS,
  CPU_MS_PER_GRAPHEME,
  DISCONNECT_MS,
  due,
  VOICE_CPU_EXTRA_MS,
} from "../clock/clock.ts";
import { audienceFor } from "../delivery/delivery.ts";
import {
  CHARACTER_LIST,
  COUNTDOWN_SAY,
  ENTRANCE,
  openingSay,
  outcomeSay,
  practiceIntroSay,
  practiceSay,
  rejectionSay,
  roomSay,
  skillListSay,
  statusSay,
  unknownCharacterSay,
} from "../narration/lines.ts";
import type { BattleState, PlayerBattleState } from "../rules/state.ts";
import {
  type BattleRecord,
  InMemoryBattleRepository,
} from "../store/repository.ts";
import { BattleSessionService } from "./session.ts";

export type Phase = "LOBBY" | "PRACTICE" | "BATTLE" | "REVIEW";
export type Seat = "A" | "B";
export type TerminalKind = "voice" | "web";
export type ToolName =
  | "submit_lobby_text"
  | "submit_utterance"
  | "begin_cast"
  | "cancel_cast"
  | "ack_playback"
  | "wait_event";

export type Clip = { kind: "cpu_spell" | "voice"; url: string };

export type SayDelivery = {
  code: string;
  event_id: string;
  say: string;
  clips: Clip[];
  stop_clips: boolean;
  ack_required: boolean;
  phase: Phase;
  wait: boolean;
  opens_at?: string;
  opens_in_ms?: number;
};

export type EnginePush = {
  deviceId: string;
  seat?: Seat;
  delivery: SayDelivery;
};

export type EngineResult = {
  caller: SayDelivery | null;
  pushes: EnginePush[];
};

export type EngineCommand = {
  deviceId: string;
  commandId: string;
  tool: ToolName;
  text?: string;
  /** 省略等于 100。首版不从听写置信度推算。 */
  perfection?: number;
  seat?: Seat;
  voiceprint?: boolean;
  terminal?: TerminalKind;
  /** MCP 会话。换会话且空档超过 10 秒，视为断线。同一会话里的停顿不算离开。 */
  sessionId?: string;
};

type Mode = "VS_CPU" | "ONLINE" | "LOCAL_DUO";

type Actor = {
  key: string;
  deviceId: string;
  seat?: Seat;
  playerId: string;
  phase: Phase;
  characterId: string | null;
  battleId: string | null;
  mode: Mode | null;
  cpuCharacterId: string | null;
  /** 说过练习但还没选角：选完角色直接进练习。 */
  pendingPractice: boolean;
  casting: boolean;
  wasInterrupted: boolean;
  /** 被打断时，对方这一击已经算完的主持句。后到的施法完成要用整句，而不是只说被打断。 */
  pendingHit: string | null;
  rematch: boolean;
  lastSeenAt: number;
  lastSessionId: string | null;
};

type Device = {
  deviceId: string;
  voiceprint: boolean;
  localDuo: boolean;
  enrolled: { A: boolean; B: boolean };
  roomCode: string | null;
};

type Room = {
  code: string;
  hostKey: string;
  guestKey: string | null;
  terminal: TerminalKind;
  status: "OPEN" | "STARTED";
};

type BattleMeta = {
  cpuPlayerId: string | null;
  cpuExtraMs: number;
  opensAt: number | null;
  cpuCompleteAt: number | null;
  countdownSent: boolean;
  ackDeadline: number | null;
  disconnectDeadline: number | null;
  disconnectedPlayerId: string | null;
};

type Cached = { signature: string; result: EngineResult };

const ALLOWED: Record<Phase, ToolName[]> = {
  LOBBY: ["submit_lobby_text", "ack_playback", "wait_event"],
  PRACTICE: [
    "submit_lobby_text",
    "submit_utterance",
    "ack_playback",
    "wait_event",
  ],
  BATTLE: [
    "submit_utterance",
    "begin_cast",
    "cancel_cast",
    "ack_playback",
    "wait_event",
  ],
  REVIEW: ["submit_lobby_text", "ack_playback", "wait_event"],
};

function normalize(text: string | undefined): string {
  return (text ?? "")
    .normalize("NFC")
    .trim()
    .replace(/[。．.！!？?\s]+$/g, "")
    .replace(/[呀啊吧呢嘛哦哟]+$/g, "");
}

function wantsOpenRoom(text: string): boolean {
  return text === "开房间" || text === "创建房间" || text === "建房间" ||
    text.includes("开房间") || text.includes("创建房间") ||
    text.includes("建房间") || text.includes("开个房") ||
    text.includes("建个房") || /创建.+房间/.test(text) ||
    /开.+房间/.test(text) || /建.+房间/.test(text);
}

function wantsVersusCpu(text: string): boolean {
  return text === "对电脑" || text.startsWith("对电脑") ||
    text.includes("人机") || text.includes("对电脑") ||
    text.includes("打电脑") || text.includes("跟电脑") ||
    text.includes("和电脑") || text.includes("电脑打一局") ||
    text.includes("电脑对战") || text.includes("人机对抗") ||
    text.includes("人机对战");
}

function wantsPractice(text: string): boolean {
  return text === "开始练习" || text === "练技能" || text === "练习" ||
    text === "练一练" || text === "开练" || text.includes("开始练习") ||
    text.includes("练技能") || text.includes("练习技能");
}

/** 大厅里「开始吧」：没进对战模式就练技能，已在对战模式就当准备。 */
function wantsLooseStart(text: string): boolean {
  return text === "开始吧" || text === "开始" || text === "开练吧";
}

function wantsEndPractice(text: string): boolean {
  return text === "结束练习" || text.includes("结束练习") ||
    text === "退出练习";
}

function wantsReady(text: string): boolean {
  return text === "准备" || text === "我准备好了" || text === "准备好了";
}

function wantsLeaveRoom(text: string): boolean {
  return text === "退出" || text === "离开" || text === "退出房间" ||
    text === "离开房间" || text === "解散" || text === "回大厅";
}

function wantsRoomNumber(text: string): boolean {
  return text === "再说一次" || text.includes("房号") ||
    text.includes("房间号") || text.includes("号码") ||
    text.includes("哪个房间") || text.includes("什么房间") ||
    text.includes("哪间");
}

/** 四位房间号，或「加入房间，房间号6993」「1、2、3、4」这种说法。 */
export function extractJoinCode(text: string): string | null {
  const normalized = text
    .normalize("NFC")
    .trim()
    .replace(/[。．.！!？?\s]+$/g, "")
    .replace(/[呀啊吧呢嘛哦哟]+$/g, "");
  if (wantsOpenRoom(normalized)) return null;
  const compact = normalized.replace(/(\d)[、,，.．\s]+(?=\d)/g, "$1");
  if (/^\d{4}$/.test(compact)) return compact;
  const match = compact.match(
    /(?:加入房间|进入房间|进房间|加入|进入|房间号|房号)(?:是|为|：|:)?\s*(\d{4})$/,
  );
  if (match) return match[1] ?? null;
  const loose = compact.match(
    /(?:加入房间|进入房间|进房间|加入|进入).{0,12}?(?:房间号|房号|号码)?(?:是|为|：|:)?\s*(\d{4})$/,
  );
  return loose?.[1] ?? null;
}

function wantsCharacterList(text: string): boolean {
  return text === "选角" || text === "选角色" || text === "有哪些角色" ||
    text === "角色" || text.includes("什么角色") || text.includes("哪些角色");
}

/** 对局中再说这些，视为离开当前对局，回到大厅。 */
function wantsLeaveBattle(text: string): boolean {
  return wantsPractice(text) || wantsOpenRoom(text) || wantsVersusCpu(text) ||
    wantsCharacterList(text) || text === "回大厅" || text === "退出" ||
    extractCharacterName(text) !== null;
}

function parsePerfection(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 100) return value;
  return value;
}

function actorKey(deviceId: string, seat?: Seat): string {
  return seat ? `${deviceId}:${seat}` : deviceId;
}

export type EngineSnapshot = {
  devices: Device[];
  actors: Actor[];
  rooms: Room[];
  metas: Array<[string, BattleMeta]>;
  seen: Array<[string, Cached]>;
  seq: number;
  battles: BattleRecord[];
};

export class GameEngine {
  private readonly sessions: BattleSessionService;
  private readonly battles: InMemoryBattleRepository;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cpuExtraMs: number;
  private readonly devices = new Map<string, Device>();
  private readonly actors = new Map<string, Actor>();
  private readonly rooms = new Map<string, Room>();
  private readonly metas = new Map<string, BattleMeta>();
  private readonly seen = new Map<string, Cached>();
  private seq = 0;
  private pushes: EnginePush[] = [];

  constructor(deps: {
    sessions?: BattleSessionService;
    now?: () => number;
    random?: () => number;
    cpuExtraMs?: number;
  } = {}) {
    this.battles = new InMemoryBattleRepository();
    this.sessions = deps.sessions ??
      new BattleSessionService(this.battles);
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.cpuExtraMs = deps.cpuExtraMs ?? VOICE_CPU_EXTRA_MS;
  }

  exportState(): EngineSnapshot {
    this.pruneSeen();
    return structuredClone({
      devices: [...this.devices.values()],
      actors: [...this.actors.values()],
      rooms: [...this.rooms.values()],
      metas: [...this.metas.entries()],
      seen: [...this.seen.entries()],
      seq: this.seq,
      battles: this.battles.dump(),
    });
  }

  /** RestHub 每次整表读写；seen 过大时 PATCH 会拖过灵矽约 5s 超时。 */
  private pruneSeen(limit = 80): void {
    if (this.seen.size <= limit) return;
    const keys = [...this.seen.keys()];
    const drop = keys.length - limit;
    for (let i = 0; i < drop; i += 1) this.seen.delete(keys[i]!);
  }

  loadState(snapshot: EngineSnapshot | null | undefined): void {
    if (!snapshot?.devices) return;
    const next = structuredClone(snapshot);
    this.devices.clear();
    for (const device of next.devices) {
      this.devices.set(device.deviceId, device);
    }
    this.actors.clear();
    for (const actor of next.actors) {
      if (actor.pendingPractice === undefined) actor.pendingPractice = false;
      if (actor.pendingHit === undefined) actor.pendingHit = null;
      if (actor.lastSeenAt === undefined) actor.lastSeenAt = 0;
      if (actor.lastSessionId === undefined) actor.lastSessionId = null;
      this.actors.set(actor.key, actor);
    }
    this.rooms.clear();
    for (const room of next.rooms) this.rooms.set(room.code, room);
    this.metas.clear();
    for (const [battleId, meta] of next.metas ?? []) {
      if (meta.disconnectDeadline === undefined) meta.disconnectDeadline = null;
      if (meta.disconnectedPlayerId === undefined) {
        meta.disconnectedPlayerId = null;
      }
      this.metas.set(battleId, meta);
    }
    this.seen.clear();
    for (const [key, cached] of next.seen ?? []) this.seen.set(key, cached);
    this.seq = next.seq ?? 0;
    this.battles.restore(next.battles ?? []);
  }

  /**
   * 同一条命令已经写进快照时，只把当时的主持句交回去。
   * 不重新结算。枢纽超时后用它找回引擎原句。
   */
  replay(command: EngineCommand): SayDelivery | null {
    const device = this.devices.get(command.deviceId);
    if (!device) return null;
    const seat = device.localDuo ? command.seat : undefined;
    const actor = this.actors.get(actorKey(command.deviceId, seat));
    if (!actor) return null;
    const signature = `${command.tool}\n${normalize(command.text)}`;
    const key = actor.battleId
      ? `${actor.battleId}:${command.commandId}`
      : `${actor.playerId}:${command.commandId}`;
    const cached = this.seen.get(key);
    if (!cached || cached.signature !== signature) return null;
    return cached.result.caller;
  }

  /** SSE 断开时记下 10 秒截止。同一会话里的下一条命令若还没到期，不算离开。 */
  markDisconnected(deviceId: string, seat?: Seat): void {
    const actor = this.actors.get(actorKey(deviceId, seat));
    if (!actor?.battleId || actor.phase !== "BATTLE") return;
    const meta = this.metas.get(actor.battleId);
    if (!meta || meta.disconnectedPlayerId) return;
    meta.disconnectDeadline = this.now() + DISCONNECT_MS;
    meta.disconnectedPlayerId = actor.playerId;
  }

  async handle(command: EngineCommand): Promise<EngineResult> {
    this.pushes = [];
    const device = this.device(command);
    if (device.localDuo && !command.seat) {
      return this.finish(
        this.delivery(this.placeholder(command), "SEAT_UNKNOWN", ""),
      );
    }
    const actor = this.actor(command, device);
    const signature = `${command.tool}\n${normalize(command.text)}`;
    const idempotencyKey = actor.battleId
      ? `${actor.battleId}:${command.commandId}`
      : `${actor.playerId}:${command.commandId}`;
    const cached = this.seen.get(idempotencyKey);
    if (cached) {
      if (cached.signature === signature) return cached.result;
      return this.finish(this.delivery(actor, "COMMAND_ALREADY_PROCESSED", ""));
    }
    if (!ALLOWED[actor.phase].includes(command.tool)) {
      const text = normalize(command.text);
      if (
        actor.phase === "BATTLE" && command.tool === "submit_lobby_text" &&
        actor.mode !== "ONLINE" && wantsLeaveBattle(text)
      ) {
        actor.phase = "LOBBY";
        actor.battleId = null;
        actor.casting = false;
        actor.mode = null;
      } else if (
        actor.phase === "BATTLE" && command.tool === "submit_lobby_text"
      ) {
        return this.remember(
          idempotencyKey,
          signature,
          this.delivery(
            actor,
            "PHASE_REJECTED",
            "这局还在进行。直接念技能名。要结束就说投降。",
          ),
        );
      } else if (
        actor.phase === "REVIEW" && command.tool === "submit_utterance"
      ) {
        return this.remember(
          idempotencyKey,
          signature,
          await this.finishedLine(actor),
        );
      } else {
        return this.remember(
          idempotencyKey,
          signature,
          this.delivery(actor, "PHASE_REJECTED", ""),
        );
      }
    }
    const presence = this.notePresence(actor, command);
    if (actor.phase === "BATTLE") await this.refresh(actor);
    if (actor.phase === "REVIEW") {
      return this.remember(
        idempotencyKey,
        signature,
        this.takeOwn(actor) ?? await this.finishedLine(actor),
      );
    }
    if (presence === "restored") {
      this.pushes = [];
      const status = await this.blood(actor);
      status.say = `回来了。${status.say}`;
      return this.remember(idempotencyKey, signature, status);
    }
    const caller = await this.dispatch(actor, device, command);
    return this.remember(idempotencyKey, signature, caller);
  }

  private async dispatch(
    actor: Actor,
    device: Device,
    command: EngineCommand,
  ): Promise<SayDelivery | null> {
    const text = normalize(command.text);
    switch (command.tool) {
      case "wait_event":
        return null;
      case "ack_playback":
        return await this.ack(actor);
      case "begin_cast":
        return this.begin(actor);
      case "cancel_cast":
        actor.casting = false;
        return this.delivery(actor, "ACCEPTED", "");
      case "submit_utterance":
        return await this.utterance(
          actor,
          text,
          command.commandId,
          parsePerfection(command.perfection),
        );
      case "submit_lobby_text":
        return await this.lobby(actor, device, command, text);
    }
  }

  private async lobby(
    actor: Actor,
    device: Device,
    command: EngineCommand,
    text: string,
  ): Promise<SayDelivery> {
    if (device.localDuo && command.seat && !device.enrolled[command.seat]) {
      return await this.enroll(actor, device);
    }
    if (this.inOpenRoom(actor, device)) {
      if (wantsPractice(text) || wantsVersusCpu(text)) {
        this.leaveRoomQuiet(actor, device);
      } else {
        return await this.roomLobby(
          actor,
          device,
          text,
          command.terminal ?? "voice",
        );
      }
    }
    if (text === "两个人" || text.includes("两个人")) {
      if (!device.voiceprint) return this.speak(actor, ENTRANCE);
      device.localDuo = true;
      actor.mode = "LOCAL_DUO";
      return this.speak(actor, "先由甲说话。");
    }
    if (wantsEndPractice(text)) {
      actor.phase = "LOBBY";
      return this.speak(actor, "练习结束。说对电脑打一局，或开房间。");
    }
    if (wantsPractice(text)) {
      return this.startPractice(actor);
    }
    if (wantsLooseStart(text)) {
      if (
        actor.mode === "VS_CPU" || actor.mode === "ONLINE" ||
        actor.mode === "LOCAL_DUO"
      ) {
        return await this.ready(actor);
      }
      return this.startPractice(actor);
    }
    if (wantsOpenRoom(text)) {
      return this.openRoom(actor, device, command.terminal ?? "voice");
    }
    if (text === "再说一次") {
      if (!device.roomCode) return this.speak(actor, ENTRANCE);
      return this.delivery(actor, "ACCEPTED", roomSay(device.roomCode));
    }
    const joinCode = extractJoinCode(text);
    if (joinCode) {
      return await this.joinRoom(
        actor,
        device,
        joinCode,
        command.terminal ?? "voice",
      );
    }
    if (wantsVersusCpu(text)) {
      return await this.versusCpu(actor, text);
    }
    if (wantsReady(text)) return await this.ready(actor);
    if (text === "再来一局") return await this.rematch(actor);
    if (text === "复盘" || text === "从头复盘") return await this.review(actor);
    if (text === "还有哪些技能" || text === "有哪些技能") {
      return await this.listSkills(actor);
    }
    if (wantsCharacterList(text)) {
      actor.phase = "LOBBY";
      if (actor.pendingPractice) {
        return this.speak(
          actor,
          `先说角色名。可选${CHARACTER_LIST}。`,
        );
      }
      return this.speak(actor, ENTRANCE);
    }
    const selectedName = extractCharacterName(text);
    if (selectedName) {
      const character = CHARACTERS.find((item) => item.name === selectedName);
      if (character) {
        return await this.selectCharacter(actor, character.id, character.name);
      }
    }
    if (/选|角色|剑士|守卫|武士|术士|法师|弓手|骑士/.test(text)) {
      actor.phase = "LOBBY";
      return this.speak(actor, unknownCharacterSay());
    }
    actor.phase = "LOBBY";
    return this.speak(actor, ENTRANCE);
  }

  private startPractice(actor: Actor): SayDelivery {
    if (!actor.characterId) {
      actor.pendingPractice = true;
      return this.speak(
        actor,
        `先说角色名。可选${CHARACTER_LIST}。`,
        "CHARACTER_REQUIRED",
      );
    }
    actor.pendingPractice = false;
    const character = getCharacter(actor.characterId);
    actor.phase = "PRACTICE";
    const names = character?.skills.map((skill) => skill.name) ?? [];
    return this.speak(actor, practiceIntroSay(names));
  }

  private openRoom(
    actor: Actor,
    device: Device,
    terminal: TerminalKind,
  ): SayDelivery {
    const code = this.roomCode();
    this.rooms.set(code, {
      code,
      hostKey: actor.key,
      guestKey: null,
      terminal,
      status: "OPEN",
    });
    device.roomCode = code;
    actor.mode = "ONLINE";
    // 等对手：需要 wait_event
    return this.delivery(actor, "ACCEPTED", roomSay(code));
  }

  private async joinRoom(
    actor: Actor,
    device: Device,
    code: string,
    terminal: TerminalKind,
  ): Promise<SayDelivery> {
    const room = this.rooms.get(code);
    if (!room || room.status === "STARTED" || room.guestKey) {
      return this.speak(
        actor,
        rejectionSay("ROOM_NOT_FOUND"),
        "ROOM_NOT_FOUND",
      );
    }
    if (room.terminal !== terminal) {
      return this.speak(
        actor,
        rejectionSay("ROOM_TERMINAL_MISMATCH"),
        "ROOM_TERMINAL_MISMATCH",
      );
    }
    const host = this.actors.get(room.hostKey);
    if (!host) {
      return this.speak(
        actor,
        rejectionSay("ROOM_NOT_FOUND"),
        "ROOM_NOT_FOUND",
      );
    }
    room.guestKey = actor.key;
    actor.mode = "ONLINE";
    device.roomCode = code;
    await this.createPairBattle(host, actor, null);
    this.side(
      host,
      this.delivery(host, "ACCEPTED", "对手来了。请选角色并准备。"),
    );
    return this.speak(actor, "已加入。请选角色并准备。");
  }

  private inOpenRoom(actor: Actor, device: Device): boolean {
    if (actor.mode !== "ONLINE" || !device.roomCode) return false;
    const room = this.rooms.get(device.roomCode);
    if (!room || room.status === "STARTED") return false;
    return room.hostKey === actor.key || room.guestKey === actor.key;
  }

  /** 房间还没开战时，只接受选角、准备、重听房号和退出。 */
  private async roomLobby(
    actor: Actor,
    device: Device,
    text: string,
    terminal: TerminalKind,
  ): Promise<SayDelivery> {
    if (wantsLeaveRoom(text)) return this.leaveRoom(actor, device);
    const joinCode = extractJoinCode(text);
    if (joinCode && device.roomCode) {
      if (joinCode !== device.roomCode) {
        return this.speak(
          actor,
          `你在${roomSay(device.roomCode)}要换房先说退出。`,
        );
      }
      const room = this.rooms.get(joinCode);
      if (room?.hostKey === actor.key && !room.guestKey) {
        return this.speak(
          actor,
          `${roomSay(joinCode)}你是房主。对手要换一台设备加入。`,
        );
      }
      return this.speak(
        actor,
        "已经在房间里。请选角色并准备。要离开就说退出。",
      );
    }
    if (wantsRoomNumber(text) && device.roomCode) {
      return this.delivery(actor, "ACCEPTED", roomSay(device.roomCode));
    }
    if (wantsCharacterList(text)) {
      return this.speak(
        actor,
        `可选${CHARACTER_LIST}。说角色名，然后说准备。`,
      );
    }
    if (wantsOpenRoom(text)) {
      const room = device.roomCode
        ? this.rooms.get(device.roomCode)
        : undefined;
      if (room?.guestKey) {
        return this.delivery(actor, "ACCEPTED", roomSay(room.code));
      }
      if (room) this.rooms.delete(room.code);
      device.roomCode = null;
      if (actor.mode === "ONLINE") actor.mode = null;
      actor.battleId = null;
      return this.openRoom(actor, device, terminal);
    }
    if (wantsReady(text) || wantsLooseStart(text)) {
      return await this.ready(actor);
    }
    if (text === "还有哪些技能" || text === "有哪些技能") {
      return await this.listSkills(actor);
    }
    const selectedName = extractCharacterName(text);
    if (selectedName) {
      const character = CHARACTERS.find((item) => item.name === selectedName);
      if (character) {
        return await this.selectCharacter(actor, character.id, character.name);
      }
    }
    return this.speak(actor, "已经在房间里。请选角色并准备。要离开就说退出。");
  }

  private leaveRoom(actor: Actor, device: Device): SayDelivery {
    this.leaveRoomQuiet(actor, device);
    return this.speak(actor, "已离开房间。可以说练习，对电脑，或开房间。");
  }

  /** 退出空房间或改去练习/对电脑时，不念离开词。有对手则通知对方。 */
  private leaveRoomQuiet(actor: Actor, device: Device): void {
    const room = device.roomCode ? this.rooms.get(device.roomCode) : undefined;
    const otherKey = room
      ? (room.hostKey === actor.key ? room.guestKey : room.hostKey)
      : null;
    const other = this.opponent(actor) ??
      (otherKey ? this.actors.get(otherKey) : undefined);
    if (room) this.rooms.delete(room.code);
    device.roomCode = null;
    if (actor.mode === "ONLINE") actor.mode = null;
    actor.battleId = null;
    if (other && other.key !== actor.key) {
      const otherDevice = this.devices.get(other.deviceId);
      if (otherDevice && otherDevice.roomCode === room?.code) {
        otherDevice.roomCode = null;
      }
      if (other.mode === "ONLINE") other.mode = null;
      other.battleId = null;
      this.side(other, this.speak(other, "对手离开了。"));
    }
  }

  private async versusCpu(actor: Actor, text: string): Promise<SayDelivery> {
    const named = CHARACTERS.find((item) =>
      item.name !== "烈焰剑士" && text.includes(item.name)
    );
    const cpu = named ?? CHARACTERS[0]!;
    await this.createPairBattle(actor, null, cpu.id);
    return this.speak(actor, `对手是${cpu.name}。请选角色并准备。`);
  }

  private async selectCharacter(
    actor: Actor,
    characterId: string,
    name: string,
  ): Promise<SayDelivery> {
    actor.characterId = characterId;
    actor.rematch = false;
    if (actor.phase === "REVIEW") actor.phase = "LOBBY";
    if (actor.battleId) {
      const current = await this.sessions.getBattle(actor.battleId);
      if (current.ok && current.state?.status === "PREPARING") {
        const prepared = await this.sessions.preparePlayer(
          actor.battleId,
          actor.playerId,
          characterId,
        );
        if (!prepared.ok) {
          return this.delivery(
            actor,
            prepared.error.code,
            rejectionSay(prepared.error.code),
          );
        }
      }
    }
    const opponent = this.opponent(actor);
    if (opponent && actor.mode === "ONLINE") {
      this.side(
        opponent,
        this.delivery(opponent, "ACCEPTED", `对手选了${name}。`),
      );
    }
    if (actor.mode === "LOCAL_DUO" && actor.seat) {
      const label = actor.seat === "A" ? "甲" : "乙";
      const other = this.opponent(actor);
      if (other) {
        this.side(other, this.speak(other, `${label}已选${name}。`));
      }
      return this.speak(actor, `${label}已选${name}。`);
    }
    if (actor.pendingPractice) return this.startPractice(actor);
    return this.speak(actor, `已选${name}。`);
  }

  private async ready(actor: Actor): Promise<SayDelivery> {
    if (!actor.characterId) {
      return this.speak(
        actor,
        rejectionSay("CHARACTER_REQUIRED"),
        "CHARACTER_REQUIRED",
      );
    }
    if (!actor.battleId || !(await this.isPreparing(actor.battleId))) {
      if (actor.mode === "VS_CPU") {
        await this.createPairBattle(
          actor,
          null,
          actor.cpuCharacterId ?? CHARACTERS[0].id,
        );
      } else if (actor.mode === "LOCAL_DUO" || actor.mode === "ONLINE") {
        const other = this.opponent(actor);
        if (!other) {
          if (actor.mode === "ONLINE") {
            return this.speak(
              actor,
              "对手还没来。等对手加入，或说退出后练习。",
            );
          }
          return this.speak(actor, "你已准备。等对手准备。");
        }
        await this.createPairBattle(
          actor.seat === "B" ? other : actor,
          actor.seat === "B" ? actor : other,
          null,
        );
      } else if (actor.pendingPractice) {
        return this.startPractice(actor);
      } else {
        return this.speak(
          actor,
          "可以说练习，对电脑，或开房间。选角色后说准备开战。",
        );
      }
    }
    const battleId = actor.battleId;
    if (!battleId) return this.delivery(actor, "ACCEPTED", ENTRANCE);
    const marked = await this.sessions.setReady(battleId, actor.playerId, true);
    if (!marked.ok) {
      return this.delivery(
        actor,
        marked.error.code,
        rejectionSay(marked.error.code),
      );
    }
    if (!marked.state?.players.every((player) => player.ready)) {
      const other = this.opponent(actor);
      if (other) {
        this.side(other, this.delivery(other, "ACCEPTED", "对手已准备。"));
      }
      return this.delivery(actor, "ACCEPTED", "你已准备。等对手准备。");
    }
    return await this.beginMatch(actor, battleId);
  }

  private async beginMatch(
    actor: Actor,
    battleId: string,
  ): Promise<SayDelivery> {
    const started = await this.sessions.startBattle(battleId);
    if (!started.ok || !started.state) {
      const code = started.ok ? "BATTLE_ABORTED" : started.error.code;
      return this.delivery(
        actor,
        code,
        started.ok ? "这局中断了。" : rejectionSay(code),
      );
    }
    const room = [...this.rooms.values()].find((item) =>
      item.hostKey === actor.key || item.guestKey === actor.key
    );
    if (room) room.status = "STARTED";
    const now = this.now();
    const opensAt = now + COUNTDOWN_MS;
    const meta = this.metas.get(battleId);
    if (meta) {
      meta.ackDeadline = null;
      meta.countdownSent = true;
      meta.opensAt = opensAt;
      meta.cpuCompleteAt = null;
      const cpu = this.chooseCpuSkill(started.state);
      if (cpu && meta.cpuPlayerId) {
        meta.cpuCompleteAt = opensAt +
          Array.from(cpu.name).length * CPU_MS_PER_GRAPHEME +
          meta.cpuExtraMs;
      }
    }
    for (const member of this.actorsIn(battleId)) member.phase = "BATTLE";
    const you = started.state.players.find((player) =>
      player.playerId === actor.playerId
    );
    const opp = started.state.players.find((player) =>
      player.playerId !== actor.playerId
    );
    const say = `${
      openingSay(you?.hp ?? 1000, opp?.hp ?? 1000)
    }${COUNTDOWN_SAY}`;
    const options = { opensAt, opensInMs: COUNTDOWN_MS };
    for (const member of this.actorsIn(battleId)) {
      if (member.key === actor.key) continue;
      this.side(
        member,
        this.delivery(member, "ACCEPTED", say, options),
      );
    }
    return this.delivery(actor, "ACCEPTED", say, options);
  }

  private async rematch(actor: Actor): Promise<SayDelivery> {
    actor.rematch = true;
    if (actor.mode === "VS_CPU" && actor.characterId) {
      await this.createPairBattle(
        actor,
        null,
        actor.cpuCharacterId ?? CHARACTERS[0].id,
      );
      if (!actor.battleId) return this.delivery(actor, "ACCEPTED", ENTRANCE);
      await this.sessions.setReady(actor.battleId, actor.playerId, true);
      return await this.beginMatch(actor, actor.battleId);
    }
    const other = this.opponent(actor);
    if (!other?.rematch) {
      if (other) {
        this.side(other, this.speak(other, "对手想再来一局。"));
      }
      return this.speak(actor, "已记下。等对手也说再来一局。");
    }
    if (!actor.characterId || !other.characterId || !actor.battleId) {
      return this.speak(actor, "先说角色名，再说再来一局。");
    }
    const left = actor.seat === "B" ? other : actor;
    const right = actor.seat === "B" ? actor : other;
    await this.createPairBattle(left, right, null);
    if (!actor.battleId) return this.delivery(actor, "ACCEPTED", "");
    await this.sessions.setReady(actor.battleId, actor.playerId, true);
    await this.sessions.setReady(actor.battleId, other.playerId, true);
    return await this.beginMatch(actor, actor.battleId);
  }

  private async review(actor: Actor): Promise<SayDelivery> {
    if (!actor.battleId) return this.delivery(actor, "ACCEPTED", ENTRANCE);
    const current = await this.sessions.getBattle(actor.battleId);
    if (!current.ok || !current.state) {
      return this.delivery(actor, "ACCEPTED", ENTRANCE);
    }
    const win = current.state.winnerPlayerId === actor.playerId;
    const names = current.state.events
      .filter((event) =>
        event.type === "ACTION_ACCEPTED" && event.playerId === actor.playerId
      )
      .map((event) => {
        const skillId = event.skillId;
        const character = actor.characterId
          ? getCharacter(actor.characterId)
          : undefined;
        return character?.skills.find((skill) => skill.id === skillId)?.name;
      })
      .filter((name): name is string => Boolean(name));
    const used = names.length ? `你用了${names.join("、")}。` : "";
    return this.delivery(
      actor,
      "ACCEPTED",
      `${used}${win ? "你赢了。" : "你输了。"}`,
    );
  }

  private async enroll(actor: Actor, device: Device): Promise<SayDelivery> {
    const seat = actor.seat;
    if (!seat) return this.delivery(actor, "SEAT_UNKNOWN", "");
    device.enrolled[seat] = true;
    actor.mode = "LOCAL_DUO";
    if (!device.enrolled.A || !device.enrolled.B) {
      const say = seat === "A"
        ? "甲已就座。换乙说话。"
        : "乙已就座。换甲说话。";
      return this.delivery(actor, "ACCEPTED", say);
    }
    const first = this.actors.get(actorKey(device.deviceId, "A"));
    const second = this.actors.get(actorKey(device.deviceId, "B"));
    if (first && second) await this.createPairBattle(first, second, null);
    const say = seat === "B"
      ? "乙已就座。甲先说角色名。"
      : "甲已就座。甲先说角色名。";
    return this.delivery(actor, "ACCEPTED", say);
  }

  private async utterance(
    actor: Actor,
    text: string,
    commandId: string,
    perfection: number | undefined,
  ): Promise<SayDelivery> {
    if (actor.phase === "PRACTICE") {
      return this.practiceUtterance(actor, text, perfection);
    }
    if (text === "看血") return await this.blood(actor);
    if (text === "还有哪些技能" || text === "有哪些技能") {
      return await this.listSkills(actor);
    }
    if (text === "投降") return await this.surrender(actor);
    if (!this.windowOpen(actor)) return await this.closedOrEarly(actor);
    return await this.cast(actor, text, commandId, perfection);
  }

  private practiceUtterance(
    actor: Actor,
    text: string,
    perfection: number | undefined,
  ): SayDelivery {
    if (wantsEndPractice(text)) {
      actor.phase = "LOBBY";
      return this.speak(actor, "练习结束。说对电脑打一局，或开房间。");
    }
    if (!actor.characterId) {
      return this.speak(
        actor,
        rejectionSay("CHARACTER_REQUIRED"),
        "CHARACTER_REQUIRED",
      );
    }
    const character = getCharacter(actor.characterId);
    if (!character) {
      return this.speak(
        actor,
        rejectionSay("CHARACTER_REQUIRED"),
        "CHARACTER_REQUIRED",
      );
    }
    const matched = matchSkill(character, text);
    if (!matched.ok) {
      return this.speak(actor, rejectionSay(matched.code), matched.code);
    }
    const score = perfection === undefined
      ? matched.match.perfection
      : perfection;
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return this.speak(actor, "", "INVALID_PERFECTION");
    }
    return this.speak(actor, practiceSay(matched.match.skill, score));
  }

  private async blood(actor: Actor): Promise<SayDelivery> {
    actor.wasInterrupted = false;
    actor.pendingHit = null;
    const state = await this.load(actor.battleId);
    if (!state) return this.delivery(actor, "ACCEPTED", "");
    const you = state.players.find((player) =>
      player.playerId === actor.playerId
    );
    const opp = state.players.find((player) =>
      player.playerId !== actor.playerId
    );
    if (!you || !opp) return this.delivery(actor, "ACCEPTED", "");
    const labels = this.labels(actor);
    return this.delivery(
      actor,
      "ACCEPTED",
      statusSay({
        youLabel: labels.you,
        oppLabel: labels.opp,
        youHp: you.hp,
        oppHp: opp.hp,
        youShield: you.shield,
        oppShield: opp.shield,
        canSpeak: this.windowOpen(actor),
        disabled: you.actionState !== "READY",
      }),
    );
  }

  private async listSkills(actor: Actor): Promise<SayDelivery> {
    if (!actor.characterId) {
      return this.speak(
        actor,
        rejectionSay("CHARACTER_REQUIRED"),
        "CHARACTER_REQUIRED",
      );
    }
    const character = getCharacter(actor.characterId);
    if (!character) {
      return this.speak(
        actor,
        rejectionSay("CHARACTER_REQUIRED"),
        "CHARACTER_REQUIRED",
      );
    }
    if (
      !actor.battleId || actor.phase === "PRACTICE" || actor.phase === "LOBBY"
    ) {
      return this.speak(
        actor,
        skillListSay(character.skills.map((skill) => skill.name)),
      );
    }
    const state = await this.load(actor.battleId);
    const player = state?.players.find((item) =>
      item.playerId === actor.playerId
    );
    const roundNo = state?.currentRound?.roundNo ?? 1;
    if (!player || player.actionState !== "READY") {
      return this.delivery(actor, "ACCEPTED", skillListSay([]));
    }
    const names = character.skills
      .filter((skill) => this.usable(player, skill, roundNo))
      .map((skill) => skill.name);
    return this.delivery(actor, "ACCEPTED", skillListSay(names));
  }

  private async surrender(actor: Actor): Promise<SayDelivery> {
    actor.casting = false;
    if (!actor.battleId) return this.delivery(actor, "PHASE_REJECTED", "");
    let state = await this.load(actor.battleId);
    const round = state?.currentRound;
    if (round && (round.status === "SETTLING" || round.status === "ENDING")) {
      const drained = await this.drain(actor.battleId);
      state = drained.ok ? drained.state : state;
      if (state?.status === "FINISHED") return this.finishOutcome(actor, state);
    }
    const conceded = await this.sessions.concede(
      actor.battleId,
      actor.playerId,
    );
    if (!conceded.ok || !conceded.state) {
      const code = conceded.ok ? "BATTLE_ABORTED" : conceded.error.code;
      return this.delivery(
        actor,
        code,
        conceded.ok ? "这局中断了。" : rejectionSay(code),
      );
    }
    return this.finishOutcome(actor, conceded.state);
  }

  private finishOutcome(actor: Actor, state: BattleState): SayDelivery {
    this.closeWindow(actor.battleId);
    for (const member of this.actorsIn(state.battleId)) {
      member.phase = "REVIEW";
      member.casting = false;
    }
    const pushes = this.outcomePushes(state, "", null);
    const mine = pushes.find((push) => this.forCaller(actor, push));
    for (const push of pushes) {
      if (push !== mine) this.pushes.push(push);
    }
    return mine?.delivery ?? this.delivery(actor, "ACCEPTED", "你输了。");
  }

  private begin(actor: Actor): SayDelivery {
    if (!this.windowOpen(actor)) {
      return this.notOpenYet(actor);
    }
    actor.casting = true;
    return this.delivery(actor, "ACCEPTED", "");
  }

  private async ack(actor: Actor): Promise<SayDelivery> {
    const meta = actor.battleId ? this.metas.get(actor.battleId) : undefined;
    if (meta && !meta.countdownSent && actor.phase === "BATTLE") {
      await this.openWindow(actor.battleId!, this.now());
    }
    const current = actor.battleId ? this.metas.get(actor.battleId) : undefined;
    if (
      current?.countdownSent && current.opensAt !== null &&
      this.now() < current.opensAt
    ) {
      return this.delivery(actor, "ACCEPTED", COUNTDOWN_SAY, {
        opensAt: current.opensAt,
        opensInMs: Math.max(0, current.opensAt - this.now()),
        wait: false,
      });
    }
    return this.delivery(actor, "ACCEPTED", "", { wait: false });
  }

  private async cast(
    actor: Actor,
    text: string,
    commandId: string,
    perfection: number | undefined,
  ): Promise<SayDelivery> {
    const battleId = actor.battleId;
    if (!battleId) return this.delivery(actor, "PHASE_REJECTED", "");
    const before = await this.load(battleId);
    const round = before?.currentRound;
    if (
      !before || before.status !== "RUNNING" ||
      round?.status !== "WAITING_COMMAND"
    ) {
      return this.closedOrEarly(actor);
    }
    if (!actor.characterId) {
      return this.delivery(
        actor,
        "CHARACTER_REQUIRED",
        rejectionSay("CHARACTER_REQUIRED"),
      );
    }
    const character = getCharacter(actor.characterId);
    if (!character) {
      return this.delivery(
        actor,
        "CHARACTER_REQUIRED",
        rejectionSay("CHARACTER_REQUIRED"),
      );
    }
    const matched = matchSkill(character, text);
    if (!matched.ok) {
      actor.casting = false;
      return this.delivery(
        actor,
        matched.code,
        rejectionSay(matched.code),
      );
    }
    const skill = matched.match.skill;
    // 对战完成度以终端提交为准；省略按 100。不把拼音距离写成完成度。
    const score = perfection === undefined ? 100 : perfection;
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      actor.casting = false;
      return this.delivery(actor, "INVALID_PERFECTION", "");
    }
    const player = before.players.find((item) =>
      item.playerId === actor.playerId
    );
    if (player?.actionState !== "READY") {
      return this.delivery(
        actor,
        "ACTION_DISABLED",
        rejectionSay("ACTION_DISABLED"),
      );
    }
    const submitted = await this.sessions.submitAction(battleId, {
      playerId: actor.playerId,
      commandId,
      roundNo: round.roundNo,
      skillText: skill.name,
      perfection: score,
    });
    if (!submitted.ok) {
      actor.casting = false;
      const code = submitted.error.code === "ROUND_NOT_WAITING"
        ? "ROUND_CLOSED"
        : submitted.error.code;
      return this.delivery(actor, code, rejectionSay(code));
    }
    const drained = await this.drain(battleId);
    const after = drained.ok ? drained.state : submitted.state;
    if (!after) {
      return this.delivery(
        actor,
        "BATTLE_ABORTED",
        rejectionSay("BATTLE_ABORTED"),
      );
    }
    actor.casting = false;
    const pushes = this.outcomePushes(after, skill.name, actor.playerId);
    await this.armNextRound(
      battleId,
      pushes.map((push) => push.delivery),
      after.status === "FINISHED",
    );
    this.rememberHits(pushes);
    const mine = pushes.find((push) => this.forCaller(actor, push));
    for (const push of pushes) {
      if (push !== mine) this.pushes.push(push);
    }
    return mine?.delivery ??
      this.delivery(actor, "ACCEPTED", rejectionSay("BATTLE_ABORTED"));
  }

  private notePresence(
    actor: Actor,
    command: EngineCommand,
  ): "ok" | "restored" {
    const now = this.now();
    const prev = actor.lastSeenAt ?? 0;
    const prevSession = actor.lastSessionId ?? null;
    const session = command.sessionId ?? null;
    const gap = prev > 0 ? now - prev : 0;
    const changed = Boolean(
      session && prevSession && session !== prevSession,
    );
    let restored = false;
    if (actor.phase === "BATTLE" && actor.battleId) {
      const meta = this.metas.get(actor.battleId);
      if (meta) {
        const armed = meta.disconnectedPlayerId === actor.playerId &&
          meta.disconnectDeadline !== null;
        if (
          armed && meta.disconnectDeadline !== null &&
          now >= meta.disconnectDeadline
        ) {
          // 截止已到，留给 refresh 判负。
        } else if (armed && meta.disconnectDeadline !== null) {
          meta.disconnectDeadline = null;
          meta.disconnectedPlayerId = null;
          restored = true;
        } else if (changed && gap >= DISCONNECT_MS) {
          // 没收到断开回调时，换了会话且空档已经超过 10 秒，同样判负。
          // 短空档换会话不打断正在进行的施法。
          meta.disconnectDeadline = prev + DISCONNECT_MS;
          meta.disconnectedPlayerId = actor.playerId;
        }
      }
    }
    actor.lastSeenAt = now;
    if (session) actor.lastSessionId = session;
    return restored ? "restored" : "ok";
  }

  private async refresh(actor: Actor): Promise<void> {
    const battleId = actor.battleId;
    if (!battleId) return;
    const meta = this.metas.get(battleId);
    if (!meta) return;
    const kinds = due({
      opensAt: null,
      ackDeadline: meta.ackDeadline,
      disconnectDeadline: meta.disconnectDeadline,
      cpuCompleteAt: meta.cpuCompleteAt,
    }, this.now());
    if (kinds.includes("disconnect")) await this.forfeitDisconnect(battleId);
    if (actor.phase !== "BATTLE") return;
    if (kinds.includes("ack") && !meta.countdownSent) {
      await this.openWindow(battleId, this.now());
    }
    if (actor.phase !== "BATTLE") return;
    if (kinds.includes("cpu")) await this.resolveCpu(battleId);
  }

  private async forfeitDisconnect(battleId: string): Promise<void> {
    const meta = this.metas.get(battleId);
    const playerId = meta?.disconnectedPlayerId;
    if (!meta || !playerId || meta.disconnectDeadline === null) return;
    if (this.now() < meta.disconnectDeadline) return;
    meta.disconnectDeadline = null;
    meta.disconnectedPlayerId = null;
    const state = await this.load(battleId);
    if (!state || state.status !== "RUNNING") return;
    const conceded = await this.sessions.concede(battleId, playerId);
    if (!conceded.ok || !conceded.state) return;
    for (const push of this.outcomePushes(conceded.state, "", null)) {
      this.pushes.push(push);
    }
  }

  private async openWindow(battleId: string, now: number): Promise<void> {
    const meta = this.metas.get(battleId);
    if (!meta || meta.countdownSent) return;
    const opensAt = now + COUNTDOWN_MS;
    meta.opensAt = opensAt;
    meta.countdownSent = true;
    meta.ackDeadline = null;
    const state = await this.load(battleId);
    const cpu = state ? this.chooseCpuSkill(state) : undefined;
    if (cpu && meta.cpuPlayerId) {
      meta.cpuCompleteAt = opensAt +
        Array.from(cpu.name).length * CPU_MS_PER_GRAPHEME +
        meta.cpuExtraMs;
    }
    for (const member of this.actorsIn(battleId)) {
      this.side(
        member,
        this.delivery(member, "ACCEPTED", COUNTDOWN_SAY, {
          opensAt,
          opensInMs: COUNTDOWN_MS,
        }),
      );
    }
  }

  private async resolveCpu(battleId: string): Promise<void> {
    const meta = this.metas.get(battleId);
    if (!meta?.cpuPlayerId || meta.cpuCompleteAt === null) return;
    meta.cpuCompleteAt = null;
    const before = await this.load(battleId);
    if (!before || before.status !== "RUNNING") return;
    if (before.currentRound?.status !== "WAITING_COMMAND") return;
    const skill = this.chooseCpuSkill(before);
    if (!skill || !before.currentRound) return;
    const cpu = before.players.find((player) =>
      player.playerId === meta.cpuPlayerId
    );
    if (!cpu || cpu.actionState !== "READY") return;
    const submitted = await this.sessions.submitAction(battleId, {
      playerId: meta.cpuPlayerId,
      commandId: `cpu:${battleId}:${before.currentRound.roundNo}`,
      roundNo: before.currentRound.roundNo,
      skillText: skill.name,
    });
    if (!submitted.ok) return;
    const drained = await this.drain(battleId);
    const after = drained.ok ? drained.state : submitted.state;
    if (!after) return;
    const pushes = this.outcomePushes(after, skill.name, meta.cpuPlayerId);
    await this.armNextRound(
      battleId,
      pushes.map((push) => push.delivery),
      after.status === "FINISHED",
    );
    this.rememberHits(pushes);
    for (const push of pushes) this.pushes.push(push);
  }

  private outcomePushes(
    state: BattleState,
    skill: string,
    sourceId: string | null,
  ): EnginePush[] {
    const finished = state.status === "FINISHED";
    if (finished) this.closeWindow(state.battleId);
    return this.actorsIn(state.battleId).map((member) => {
      const you = state.players.find((player) =>
        player.playerId === member.playerId
      );
      const opp = state.players.find((player) =>
        player.playerId !== member.playerId
      );
      const interrupted = member.casting && sourceId !== null &&
        sourceId !== member.playerId;
      if (interrupted) member.wasInterrupted = true;
      member.casting = false;
      if (finished) member.phase = "REVIEW";
      return {
        deviceId: member.deviceId,
        seat: member.seat,
        delivery: this.delivery(
          member,
          "ACCEPTED",
          outcomeSay({
            skill,
            self: sourceId === member.playerId,
            youHp: you?.hp ?? 0,
            oppHp: opp?.hp ?? 0,
            youShield: you?.shield ?? 0,
            oppShield: opp?.shield ?? 0,
            interrupted,
            finished,
            win: state.winnerPlayerId === member.playerId,
          }),
          { ack: !finished, wait: true },
        ),
      };
    });
  }

  /**
   * 人机：战况后立刻接倒数，避免空等回执时玩家抢念、听不到三二一。
   * 联机：仍先回执再开倒数。
   */
  private async armNextRound(
    battleId: string,
    deliveries: SayDelivery[],
    finished: boolean,
  ): Promise<void> {
    if (finished) return;
    const meta = this.metas.get(battleId);
    if (!meta) return;
    if (!meta.cpuPlayerId) {
      this.armAck(battleId);
      return;
    }
    const now = this.now();
    const opensAt = now + COUNTDOWN_MS;
    meta.opensAt = opensAt;
    meta.countdownSent = true;
    meta.ackDeadline = null;
    const state = await this.load(battleId);
    const cpu = state ? this.chooseCpuSkill(state) : undefined;
    if (cpu) {
      meta.cpuCompleteAt = opensAt +
        Array.from(cpu.name).length * CPU_MS_PER_GRAPHEME +
        meta.cpuExtraMs;
    } else {
      meta.cpuCompleteAt = null;
    }
    for (const delivery of deliveries) {
      if (delivery.phase === "REVIEW") continue;
      delivery.say = `${delivery.say}${COUNTDOWN_SAY}`;
      delivery.opens_at = new Date(opensAt).toISOString();
      delivery.opens_in_ms = COUNTDOWN_MS;
      delivery.ack_required = false;
      delivery.wait = true;
    }
  }

  private async createPairBattle(
    left: Actor,
    right: Actor | null,
    cpuCharacterId: string | null,
  ): Promise<void> {
    const battleId = `b_${crypto.randomUUID()}`;
    const cpuPlayerId = cpuCharacterId ? `cpu:${battleId}` : null;
    const playerIds = [left.playerId];
    if (right) playerIds.push(right.playerId);
    if (cpuPlayerId) playerIds.push(cpuPlayerId);
    const created = await this.sessions.createBattle({ battleId, playerIds });
    if (!created.ok) return;
    left.battleId = battleId;
    if (cpuCharacterId) {
      left.mode = "VS_CPU";
      left.cpuCharacterId = cpuCharacterId;
    }
    if (right) {
      right.battleId = battleId;
      right.mode = left.mode === "LOCAL_DUO" ? "LOCAL_DUO" : "ONLINE";
      if (left.mode !== "LOCAL_DUO") left.mode = "ONLINE";
    }
    if (cpuPlayerId && cpuCharacterId) {
      await this.sessions.preparePlayer(battleId, cpuPlayerId, cpuCharacterId);
      await this.sessions.setReady(battleId, cpuPlayerId, true);
    }
    for (const member of [left, right]) {
      if (member?.characterId) {
        await this.sessions.preparePlayer(
          battleId,
          member.playerId,
          member.characterId,
        );
      }
    }
    this.metas.set(battleId, {
      cpuPlayerId,
      cpuExtraMs: this.cpuExtraMs,
      opensAt: null,
      cpuCompleteAt: null,
      countdownSent: false,
      ackDeadline: null,
      disconnectDeadline: null,
      disconnectedPlayerId: null,
    });
  }

  private chooseCpuSkill(state: BattleState): SkillConfig | undefined {
    const cpu = state.players.find((player) =>
      player.playerId.startsWith("cpu:")
    );
    if (
      !cpu?.characterId || !state.currentRound || cpu.actionState !== "READY"
    ) return;
    const character = getCharacter(cpu.characterId);
    if (!character) return;
    const usable = character.skills.filter((skill) =>
      this.usable(cpu, skill, state.currentRound!.roundNo)
    );
    const basic = usable.find((skill) => skill.slotType === "BASIC");
    if (basic) return basic;
    return usable
      .filter((skill) => skill.slotType === "CHARACTER")
      .sort((left, right) => {
        const gap = Array.from(left.name).length -
          Array.from(right.name).length;
        if (gap !== 0) return gap;
        return character.skills.indexOf(left) - character.skills.indexOf(right);
      })[0];
  }

  private usable(
    player: PlayerBattleState,
    skill: SkillConfig,
    roundNo: number,
  ): boolean {
    const usage = player.skillUsage[skill.id] ?? 0;
    const lastRound = player.skillLastUsedRound[skill.id];
    if (skill.reuseRule === "ONCE_PER_MATCH") return usage === 0;
    if (skill.reuseRule === "BASIC_NON_CONSECUTIVE") {
      return lastRound === undefined || roundNo - lastRound >= 2;
    }
    return usage < (skill.maxUsesPerMatch ?? 0) &&
      (lastRound === undefined || roundNo - lastRound >= skill.minRoundGap);
  }

  private async drain(battleId: string) {
    let current = await this.sessions.getBattle(battleId);
    for (let i = 0; i < 6; i += 1) {
      if (!current.ok || !current.state || current.state.status !== "RUNNING") {
        return current;
      }
      const status = current.state.currentRound?.status;
      if (!status || status === "WAITING_COMMAND" || status === "FINISHED") {
        return current;
      }
      current = await this.sessions.advance(battleId);
    }
    return current;
  }

  private async load(battleId: string | null): Promise<BattleState | null> {
    if (!battleId) return null;
    const current = await this.sessions.getBattle(battleId);
    return current.ok ? current.state : null;
  }

  private async isPreparing(battleId: string): Promise<boolean> {
    const state = await this.load(battleId);
    return state?.status === "PREPARING";
  }

  private windowOpen(actor: Actor): boolean {
    if (!actor.battleId) return false;
    const meta = this.metas.get(actor.battleId);
    return meta?.opensAt !== null && meta !== undefined &&
      this.now() >= (meta.opensAt ?? Infinity);
  }

  private armAck(battleId: string): void {
    const meta = this.metas.get(battleId);
    if (!meta) return;
    meta.countdownSent = false;
    meta.opensAt = null;
    meta.cpuCompleteAt = null;
    meta.ackDeadline = this.now() + ACK_MS;
  }

  private closeWindow(battleId: string | null): void {
    if (!battleId) return;
    const meta = this.metas.get(battleId);
    if (!meta) return;
    meta.opensAt = null;
    meta.cpuCompleteAt = null;
    meta.ackDeadline = null;
    meta.countdownSent = true;
  }

  private actorsIn(battleId: string): Actor[] {
    return [...this.actors.values()].filter((actor) =>
      actor.battleId === battleId
    );
  }

  private opponent(actor: Actor): Actor | undefined {
    if (!actor.battleId) {
      if (actor.mode !== "LOCAL_DUO" || !actor.seat) return undefined;
      const other: Seat = actor.seat === "A" ? "B" : "A";
      return this.actors.get(actorKey(actor.deviceId, other));
    }
    return this.actorsIn(actor.battleId).find((member) =>
      member.key !== actor.key
    );
  }

  private labels(actor: Actor): { you: string; opp: string } {
    if (actor.mode === "LOCAL_DUO" && actor.seat === "A") {
      return { you: "甲", opp: "乙" };
    }
    if (actor.mode === "LOCAL_DUO" && actor.seat === "B") {
      return { you: "乙", opp: "甲" };
    }
    return { you: "你", opp: "对手" };
  }

  private roomCode(): string {
    for (let i = 0; i < 20; i += 1) {
      const code = String(Math.floor(this.random() * 10000)).padStart(4, "0");
      if (!this.rooms.has(code)) return code;
    }
    return "0000";
  }

  private device(command: EngineCommand): Device {
    let device = this.devices.get(command.deviceId);
    if (!device) {
      device = {
        deviceId: command.deviceId,
        voiceprint: false,
        localDuo: false,
        enrolled: { A: false, B: false },
        roomCode: null,
      };
      this.devices.set(command.deviceId, device);
    }
    device.voiceprint = command.voiceprint === true;
    return device;
  }

  private actor(command: EngineCommand, device: Device): Actor {
    const seat = device.localDuo ? command.seat : undefined;
    const key = actorKey(command.deviceId, seat);
    let actor = this.actors.get(key);
    if (!actor) {
      actor = {
        key,
        deviceId: command.deviceId,
        seat,
        playerId: seat
          ? `p:${command.deviceId}:${seat}`
          : `p:${command.deviceId}`,
        phase: "LOBBY",
        characterId: null,
        battleId: null,
        mode: device.localDuo ? "LOCAL_DUO" : null,
        cpuCharacterId: null,
        pendingPractice: false,
        casting: false,
        wasInterrupted: false,
        pendingHit: null,
        rematch: false,
        lastSeenAt: 0,
        lastSessionId: null,
      };
      this.actors.set(key, actor);
    }
    return actor;
  }

  private placeholder(command: EngineCommand): Actor {
    return {
      key: command.deviceId,
      deviceId: command.deviceId,
      playerId: `p:${command.deviceId}`,
      phase: "LOBBY",
      characterId: null,
      battleId: null,
      mode: null,
      cpuCharacterId: null,
      pendingPractice: false,
      casting: false,
      wasInterrupted: false,
      pendingHit: null,
      rematch: false,
      lastSeenAt: 0,
      lastSessionId: null,
    };
  }

  private async closedOrEarly(actor: Actor): Promise<SayDelivery> {
    if (actor.wasInterrupted || actor.casting) {
      actor.wasInterrupted = false;
      actor.casting = false;
      const hit = actor.pendingHit;
      actor.pendingHit = null;
      this.dropOwnPushes(actor);
      const say = !hit
        ? rejectionSay("CAST_INTERRUPTED")
        : hit.startsWith("吟唱被打断。")
        ? hit
        : `吟唱被打断。${hit}`;
      return this.delivery(actor, "CAST_INTERRUPTED", say);
    }
    const state = await this.load(actor.battleId);
    const waiting = state?.status === "RUNNING" &&
      state.currentRound?.status === "WAITING_COMMAND";
    if (!waiting) {
      return this.delivery(actor, "ROUND_CLOSED", rejectionSay("ROUND_CLOSED"));
    }
    return this.notOpenYet(actor);
  }

  private notOpenYet(actor: Actor): SayDelivery {
    const meta = actor.battleId ? this.metas.get(actor.battleId) : undefined;
    if (meta?.countdownSent && meta.opensAt !== null) {
      const remain = Math.max(0, meta.opensAt - this.now());
      return this.delivery(actor, "ROUND_NOT_OPEN", COUNTDOWN_SAY, {
        opensAt: meta.opensAt,
        opensInMs: remain,
      });
    }
    return this.delivery(
      actor,
      "ROUND_NOT_OPEN",
      rejectionSay("ROUND_NOT_OPEN"),
    );
  }

  private rememberHits(pushes: EnginePush[]): void {
    for (const push of pushes) {
      const member = this.actors.get(actorKey(push.deviceId, push.seat));
      if (member?.wasInterrupted) member.pendingHit = push.delivery.say;
    }
  }

  private dropOwnPushes(actor: Actor): void {
    this.pushes = this.pushes.filter((push) =>
      !(push.deviceId === actor.deviceId && push.seat === actor.seat)
    );
  }

  private takeOwn(actor: Actor): SayDelivery | null {
    const index = this.pushes.findIndex((push) =>
      push.deviceId === actor.deviceId && push.seat === actor.seat
    );
    if (index < 0) return null;
    const [push] = this.pushes.splice(index, 1);
    return push?.delivery ?? null;
  }

  private async finishedLine(actor: Actor): Promise<SayDelivery> {
    const state = await this.load(actor.battleId);
    if (!state) return this.delivery(actor, "ACCEPTED", "你输了。");
    const you = state.players.find((player) =>
      player.playerId === actor.playerId
    );
    const opp = state.players.find((player) =>
      player.playerId !== actor.playerId
    );
    return this.delivery(
      actor,
      "ACCEPTED",
      outcomeSay({
        skill: "",
        self: false,
        youHp: you?.hp ?? 0,
        oppHp: opp?.hp ?? 0,
        youShield: you?.shield ?? 0,
        oppShield: opp?.shield ?? 0,
        interrupted: false,
        finished: true,
        win: state.winnerPlayerId === actor.playerId,
      }),
    );
  }

  private forCaller(actor: Actor, push: EnginePush): boolean {
    return audienceFor({
      speakerIsCaller: push.deviceId === actor.deviceId &&
        push.seat === actor.seat,
      eventFromCaller: true,
    }) === "caller";
  }

  private side(actor: Actor, delivery: SayDelivery): void {
    this.pushes.push({ deviceId: actor.deviceId, seat: actor.seat, delivery });
  }

  private delivery(
    actor: Actor,
    code: string,
    say: string,
    options: {
      ack?: boolean;
      wait?: boolean;
      opensAt?: number;
      opensInMs?: number;
    } = {},
  ): SayDelivery {
    this.seq += 1;
    const delivery: SayDelivery = {
      code,
      event_id: `e${this.seq}`,
      say,
      clips: [],
      stop_clips: false,
      ack_required: options.ack === true,
      phase: actor.phase,
      wait: options.wait !== false,
    };
    if (options.opensAt !== undefined) {
      delivery.opens_at = new Date(options.opensAt).toISOString();
      delivery.opens_in_ms = options.opensInMs ?? 0;
    }
    return delivery;
  }

  /** 大厅即时主持句：先播出，不必立刻挂 wait_event。 */
  private speak(actor: Actor, say: string, code = "ACCEPTED"): SayDelivery {
    return this.delivery(actor, code, say, { wait: false });
  }

  private remember(
    key: string,
    signature: string,
    caller: SayDelivery | null,
  ): EngineResult {
    this.pruneSeen();
    const result = { caller, pushes: this.pushes };
    this.seen.set(key, { signature, result });
    return result;
  }

  private finish(caller: SayDelivery | null): EngineResult {
    return { caller, pushes: this.pushes };
  }
}
