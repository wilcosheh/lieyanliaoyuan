import { GameEngine, type SayDelivery } from "../../engine/service/game.ts";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { extractJoinCode } from "../../engine/service/game.ts";
import { settleHubCall } from "./call_budget.ts";
import { type HubCall, type LocalSend } from "./hub.ts";
import { type RpcId, rpcResult } from "./protocol.ts";
import { absorbPeer, peerIsRelevant, textNeedsRoomLock } from "./room_sync.ts";

const EMPTY: SayDelivery = {
  code: "ACCEPTED",
  event_id: "",
  say: "",
  clips: [],
  stop_clips: false,
  ack_required: false,
  phase: "LOBBY",
  wait: false,
};

const REST_TIMEOUT_MS = 8000;
const CALL_BUDGET_MS = 20000;

type Rest = {
  url: string;
  key: string;
  request: typeof fetch;
};

/** 用 PostgREST 按设备存对局快照。SSE 实例定时抽自己的会话。 */
export class RestHub {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly bound = new Map<string, string>();

  constructor(
    private readonly rest: Rest,
    private readonly owns: (sessionId: string) => boolean,
    private readonly send: LocalSend,
  ) {}

  watch(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const tick = () => {
      this.pullWaiting(sessionId).catch((error) =>
        console.error("mcp pull", error)
      );
    };
    tick();
    this.timers.set(sessionId, setInterval(tick, 150));
  }

  unwatch(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(sessionId);
    const key = this.bound.get(sessionId);
    this.bound.delete(sessionId);
    if (!key) return;
    this.persistDisconnect(key).catch((error) => {
      console.error("mcp disconnect", error);
    });
  }

  tick(sessionId: string): Promise<void> {
    return this.pullWaiting(sessionId).catch((error) => {
      console.error("mcp pull", error);
    });
  }

  async publish(sessionId: string, body: unknown): Promise<void> {
    if (this.send(sessionId, body)) return;
    await this.insertMessage(sessionId, null, body);
  }

  async cancel(sessionId: string, rpcId: RpcId): Promise<void> {
    await this.rpc("DELETE", "ly_mcp_sub", {
      query: `session_id=eq.${encodeURIComponent(sessionId)}&rpc_id=eq.${
        encodeURIComponent(String(rpcId))
      }`,
    });
  }

  async call(input: HubCall): Promise<unknown | null> {
    // 存盘只按物理设备。模型误传 seat 时不能写成「小贾:A」另起一行。
    const key = input.command.deviceId;
    input.command.sessionId = input.sessionId;
    this.bound.set(input.sessionId, key);
    const work = this.serialize(key, () => this.runCall(input, key));
    return await settleHubCall(
      work,
      CALL_BUDGET_MS,
      (error) => this.recover(input, key, error),
    );
  }

  private async recover(
    input: HubCall,
    key: string,
    error: unknown,
  ): Promise<unknown> {
    try {
      const snapshot = await this.loadEngine(key);
      const engine = new GameEngine();
      engine.loadState(snapshot);
      const heard = engine.replay(input.command);
      if (heard) {
        const body = rpcResult(input.rpcId, heard);
        try {
          await this.publish(input.sessionId, body);
        } catch {
          // 原句已经能返回给这次调用。
        }
        return body;
      }
    } catch (recoverError) {
      console.error("mcp rest recover", recoverError);
    }
    return await this.fallback(input, error);
  }

  private async persistDisconnect(key: string): Promise<void> {
    const snapshot = await this.loadEngine(key);
    if (!snapshot) return;
    const engine = new GameEngine();
    engine.loadState(snapshot);
    engine.markDisconnected(key);
    await this.saveEngine(key, engine.exportState());
  }

  private async fallback(input: HubCall, error: unknown): Promise<unknown> {
    console.error("mcp rest call", error);
    // ack/wait 失败绝不能回可播报句子，否则灵矽会 ack→报错→再 ack 死循环。
    const silent = input.command.tool === "ack_playback" ||
      input.command.tool === "wait_event" ||
      input.command.tool === "cancel_cast" ||
      input.command.tool === "begin_cast";
    const body = rpcResult(input.rpcId, {
      ...EMPTY,
      say: silent ? "" : "刚才没听清，请再说一次。",
      wait: silent,
    });
    try {
      await this.publish(input.sessionId, body);
    } catch {
      // ignore
    }
    return body;
  }

  private async runCall(
    input: HubCall,
    key: string,
  ): Promise<unknown | null> {
    const started = Date.now();
    const text = input.command.text ?? "";
    const tool = input.command.tool;
    const joinCode = extractJoinCode(text);
    const opening = textNeedsRoomLock(text) && !joinCode;
    const before = await this.loadEngine(key);
    const loaded = new Map<string, EngineSnapshot | null>([[key, before]]);
    let merged = before;
    let reserved = new Set<string>();

    // 加入：扫表找房。对局中：只拉房间里的对手，禁止每次 wait/出招都拉全表。
    // 开房：只收集已占用房号。练习 / 人机：不动别人。
    if (joinCode) {
      const others = await this.loadOtherEngines(key);
      for (const other of others) {
        if (!peerIsRelevant(other.device_key, other.state, key, joinCode)) {
          continue;
        }
        loaded.set(other.device_key, other.state);
        merged = absorbPeer(merged, other.device_key, other.state);
      }
    } else if (opening) {
      const others = await this.loadOtherEngines(key);
      reserved = occupiedRoomCodes(others);
      merged = withReservedRooms(merged, key, reserved);
    } else if (this.shouldMergePeers(tool, key, before)) {
      const peers = await this.loadPeerEngines(key, before);
      for (const other of peers) {
        loaded.set(other.device_key, other.state);
        merged = absorbPeer(merged, other.device_key, other.state);
      }
    }

    const engine = new GameEngine();
    engine.loadState(merged);
    const result = await engine.handle(input.command);
    const next = stripReservedRooms(engine.exportState(), key, reserved);
    await this.saveChanged(key, loaded, next);
    for (const push of result.pushes) {
      await this.route(push.deviceId, push.delivery);
    }
    if (!result.caller && input.command.tool === "wait_event") {
      const parked = await this.park(key, input.sessionId, input.rpcId);
      console.log(
        "mcp rest",
        key,
        Date.now() - started,
        "ms",
        parked ? "wait-hit" : "wait",
        loaded.size,
      );
      return parked;
    }
    if (result.caller && input.command.tool === "submit_lobby_text") {
      const notices = await this.takePendingSays(key);
      if (notices.length > 0) {
        result.caller.say = `${notices.join("")}${result.caller.say}`;
        if (result.caller.phase === "LOBBY") result.caller.wait = true;
      }
    }
    const body = result.caller
      ? rpcResult(input.rpcId, result.caller)
      : rpcResult(input.rpcId, EMPTY);
    // 本机 SSE / streamable 立刻送到；跨 isolate 再落库。不挡 HTTP 回包。
    if (!this.send(input.sessionId, body)) {
      await this.publish(input.sessionId, body);
    }
    console.log(
      "mcp rest",
      key,
      Date.now() - started,
      "ms",
      input.command.tool,
      loaded.size,
    );
    return body;
  }

  private shouldMergePeers(
    tool: string,
    key: string,
    state: EngineSnapshot | null,
  ): boolean {
    if (!state) return false;
    // wait/ack/begin 只读本机已合并快照即可；出招、大厅口令才拉对手。
    if (
      tool === "wait_event" || tool === "ack_playback" ||
      tool === "begin_cast" || tool === "cancel_cast"
    ) {
      return false;
    }
    return this.peerDeviceIds(key, state).length > 0;
  }

  private peerDeviceIds(
    key: string,
    state: EngineSnapshot,
  ): string[] {
    const peers = new Set<string>();
    for (const actor of state.actors) {
      if (actor.mode === "ONLINE" && actor.deviceId !== key) {
        peers.add(actor.deviceId);
      }
    }
    for (const room of state.rooms) {
      if (!roomTouches(room, key)) continue;
      peers.add(deviceIdOf(room.hostKey));
      if (room.guestKey) peers.add(deviceIdOf(room.guestKey));
    }
    peers.delete(key);
    return [...peers];
  }

  private async loadPeerEngines(
    key: string,
    state: EngineSnapshot | null,
  ): Promise<Array<{ device_key: string; state: EngineSnapshot }>> {
    if (!state) return [];
    const out: Array<{ device_key: string; state: EngineSnapshot }> = [];
    for (const peerKey of this.peerDeviceIds(key, state)) {
      const snap = await this.loadEngine(peerKey);
      if (snap) out.push({ device_key: peerKey, state: snap });
    }
    return out;
  }

  private async loadOtherEngines(
    key: string,
  ): Promise<Array<{ device_key: string; state: EngineSnapshot }>> {
    return await this.rpc<Array<{ device_key: string; state: EngineSnapshot }>>(
      "GET",
      "ly_device_engine",
      {
        query: `device_key=neq.${
          encodeURIComponent(key)
        }&select=device_key,state`,
      },
    );
  }

  private async saveChanged(
    key: string,
    loaded: Map<string, EngineSnapshot | null>,
    next: EngineSnapshot,
  ): Promise<void> {
    // 只回写本次读过的设备，以及本房主客。绝不把并进来的旁观设备整表覆盖掉。
    const writeKeys = new Set<string>([key, ...loaded.keys()]);
    for (const room of next.rooms) {
      if (!roomTouches(room, key)) continue;
      writeKeys.add(deviceIdOf(room.hostKey));
      if (room.guestKey) writeKeys.add(deviceIdOf(room.guestKey));
    }
    for (const deviceId of writeKeys) {
      const previous = loaded.get(deviceId) ?? null;
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      await this.saveEngine(deviceId, next);
    }
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    this.chains.set(key, run.then(() => {}, () => {}));
    return run;
  }

  private async route(key: string, delivery: SayDelivery): Promise<void> {
    const subs = await this.rpc<Array<{ session_id: string; rpc_id: string }>>(
      "GET",
      "ly_mcp_sub",
      {
        query: `device_key=eq.${
          encodeURIComponent(key)
        }&select=session_id,rpc_id`,
      },
    );
    const sub = subs[0];
    if (!sub) {
      await this.rpc("POST", "ly_mcp_pending", {
        body: [{ device_key: key, body: delivery }],
      });
      return;
    }
    await this.rpc("DELETE", "ly_mcp_sub", {
      query: `device_key=eq.${encodeURIComponent(key)}`,
    });
    await this.publish(
      sub.session_id,
      rpcResult(restoreRpcId(sub.rpc_id), delivery),
    );
  }

  /**
   * 挂起等待。若已有 pending（对手加入等），直接作为本次 wait 结果返回，
   * 避免 publish 后再 return null 被 hold 成「。」。
   * 登记 sub 后再扫一次 pending，堵上「先写 pending、后写 sub」的竞态。
   */
  private async park(
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<unknown | null> {
    const hit = await this.deliverPending(key, sessionId, rpcId);
    if (hit) return hit;
    await this.rpc("POST", "ly_mcp_sub", {
      body: [{
        device_key: key,
        session_id: sessionId,
        rpc_id: String(rpcId),
      }],
      headers: { Prefer: "resolution=merge-duplicates" },
      query: "on_conflict=device_key",
    });
    const raced = await this.deliverPending(key, sessionId, rpcId);
    if (raced) {
      await this.rpc("DELETE", "ly_mcp_sub", {
        query: `device_key=eq.${encodeURIComponent(key)}`,
      });
      return raced;
    }
    return null;
  }

  /** 挂起中定时：有 pending 就解开 sub，送到本会话。 */
  private async pullWaiting(sessionId: string): Promise<void> {
    const key = this.bound.get(sessionId);
    if (!key) {
      await this.drain(sessionId);
      return;
    }
    const subs = await this.rpc<Array<{ session_id: string; rpc_id: string }>>(
      "GET",
      "ly_mcp_sub",
      {
        query: `device_key=eq.${encodeURIComponent(key)}&session_id=eq.${
          encodeURIComponent(sessionId)
        }&select=session_id,rpc_id`,
      },
    );
    const sub = subs[0];
    if (sub) {
      const hit = await this.deliverPending(
        key,
        sessionId,
        restoreRpcId(sub.rpc_id),
      );
      if (hit) {
        await this.rpc("DELETE", "ly_mcp_sub", {
          query: `device_key=eq.${encodeURIComponent(key)}`,
        });
      }
    }
    await this.drain(sessionId);
  }

  private async deliverPending(
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<unknown | null> {
    const pending = await this.rpc<Array<{ id: number; body: SayDelivery }>>(
      "GET",
      "ly_mcp_pending",
      {
        query: `device_key=eq.${
          encodeURIComponent(key)
        }&select=id,body&order=id.asc`,
      },
    );
    if (pending.length === 0) return null;
    await this.rpc("DELETE", "ly_mcp_pending", {
      query: `device_key=eq.${encodeURIComponent(key)}`,
    });
    const last = pending[pending.length - 1]!.body;
    const say = pending.map((row) => row.body.say).filter((line) => line)
      .join("");
    const body = rpcResult(rpcId, {
      ...last,
      say,
      wait: last.phase === "BATTLE" ? last.wait : true,
    });
    await this.publish(sessionId, body);
    return body;
  }

  private async takePendingSays(key: string): Promise<string[]> {
    const pending = await this.rpc<Array<{ id: number; body: SayDelivery }>>(
      "GET",
      "ly_mcp_pending",
      {
        query: `device_key=eq.${
          encodeURIComponent(key)
        }&select=id,body&order=id.asc`,
      },
    );
    if (pending.length === 0) return [];
    await this.rpc("DELETE", "ly_mcp_pending", {
      query: `device_key=eq.${encodeURIComponent(key)}`,
    });
    return pending
      .map((row) => row.body.say)
      .filter((line) => line.includes("对手"));
  }

  private async loadEngine(key: string): Promise<EngineSnapshot | null> {
    const rows = await this.rpc<Array<{ state: EngineSnapshot }>>(
      "GET",
      "ly_device_engine",
      {
        query: `device_key=eq.${encodeURIComponent(key)}&select=state`,
      },
    );
    return rows[0]?.state ?? null;
  }

  private async saveEngine(
    key: string,
    state: EngineSnapshot,
  ): Promise<void> {
    await this.rpc("POST", "ly_device_engine", {
      body: [{ device_key: key, state, updated_at: new Date().toISOString() }],
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      query: "on_conflict=device_key",
    });
  }

  private async insertMessage(
    sessionId: string,
    deviceKeyValue: string | null,
    body: unknown,
  ): Promise<void> {
    await this.rpc("POST", "ly_mcp_message", {
      body: [{
        session_id: sessionId,
        device_key: deviceKeyValue,
        body,
      }],
    });
  }

  private async drain(sessionId: string): Promise<void> {
    if (!this.owns(sessionId)) return;
    const rows = await this.rpc<Array<{ id: number; body: unknown }>>(
      "GET",
      "ly_mcp_message",
      {
        query: `session_id=eq.${
          encodeURIComponent(sessionId)
        }&select=id,body&order=id.asc`,
      },
    );
    for (const row of rows) {
      if (this.send(sessionId, row.body)) {
        await this.rpc("DELETE", "ly_mcp_message", {
          query: `id=eq.${row.id}`,
        });
      }
    }
  }

  private async rpc<T = unknown>(
    method: string,
    table: string,
    options: {
      query?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const query = options.query ? `?${options.query}` : "";
    const response = await this.rest.request(
      `${this.rest.url}/rest/v1/${table}${query}`,
      {
        method,
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        headers: {
          apikey: this.rest.key,
          Authorization: `Bearer ${this.rest.key}`,
          "Content-Type": "application/json",
          ...(method === "GET" ? {} : { Prefer: "return=minimal" }),
          ...options.headers,
        },
        body: options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${table} ${response.status}: ${text}`);
    }
    if (response.status === 204) return [] as T;
    const text = await response.text();
    if (!text) return [] as T;
    return JSON.parse(text) as T;
  }
}

function restoreRpcId(value: string): RpcId {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}

function deviceIdOf(actorKey: string): string {
  const cut = actorKey.lastIndexOf(":");
  if (cut > 0 && (actorKey.endsWith(":A") || actorKey.endsWith(":B"))) {
    return actorKey.slice(0, cut);
  }
  return actorKey;
}

function roomTouches(
  room: { hostKey: string; guestKey: string | null },
  key: string,
): boolean {
  return room.hostKey === key || room.hostKey.startsWith(`${key}:`) ||
    room.guestKey === key || (room.guestKey?.startsWith(`${key}:`) ?? false);
}

function occupiedRoomCodes(
  others: Array<{ state: EngineSnapshot }>,
): Set<string> {
  const codes = new Set<string>();
  for (const other of others) {
    for (const room of other.state.rooms ?? []) {
      if (room.code) codes.add(room.code);
    }
  }
  return codes;
}

/** 开房时临时占住别人已用的号，防止撞号；不算真实房主。 */
function withReservedRooms(
  base: EngineSnapshot | null,
  selfKey: string,
  codes: Set<string>,
): EngineSnapshot | null {
  if (codes.size === 0) return base;
  const into = base ? structuredClone(base) : {
    devices: [],
    actors: [],
    rooms: [],
    metas: [],
    seen: [],
    seq: 0,
    battles: [],
  };
  const have = new Set(into.rooms.map((room) => room.code));
  for (const code of codes) {
    if (have.has(code)) continue;
    into.rooms.push({
      code,
      hostKey: `reserved:${selfKey}`,
      guestKey: null,
      terminal: "voice",
      status: "OPEN",
    });
  }
  return into;
}

function stripReservedRooms(
  state: EngineSnapshot,
  selfKey: string,
  _reserved: Set<string>,
): EngineSnapshot {
  const marker = `reserved:${selfKey}`;
  if (!state.rooms.some((room) => room.hostKey === marker)) return state;
  return {
    ...state,
    rooms: state.rooms.filter((room) => room.hostKey !== marker),
  };
}
