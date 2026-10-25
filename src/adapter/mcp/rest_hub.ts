import { GameEngine, type SayDelivery } from "../../engine/service/game.ts";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { settleHubCall } from "./call_budget.ts";
import { deviceKey, type HubCall, type LocalSend } from "./hub.ts";
import { type RpcId, rpcResult } from "./protocol.ts";

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
      this.drain(sessionId).catch((error) => console.error("mcp drain", error));
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
    return this.drain(sessionId).catch((error) => {
      console.error("mcp drain", error);
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
    const key = deviceKey(input.command.deviceId, input.command.seat);
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
    const seat = key.endsWith(":A")
      ? "A"
      : key.endsWith(":B")
      ? "B"
      : undefined;
    const deviceId = seat ? key.slice(0, -2) : key;
    engine.markDisconnected(deviceId, seat);
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
    const snapshot = await this.loadEngine(key);
    const engine = new GameEngine();
    engine.loadState(snapshot);
    const result = await engine.handle(input.command);
    const next = engine.exportState();
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) {
      await this.saveEngine(key, next);
    }
    for (const push of result.pushes) {
      await this.route(
        deviceKey(push.deviceId, push.seat),
        push.delivery,
      );
    }
    if (!result.caller && input.command.tool === "wait_event") {
      await this.park(key, input.sessionId, input.rpcId);
      return null;
    }
    const body = result.caller
      ? rpcResult(input.rpcId, result.caller)
      : rpcResult(input.rpcId, EMPTY);
    // 本机 SSE / streamable 立刻送到；跨 isolate 再落库。不挡 HTTP 回包。
    if (!this.send(input.sessionId, body)) {
      await this.publish(input.sessionId, body);
    }
    return body;
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

  private async park(
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<void> {
    const pending = await this.rpc<Array<{ id: number; body: SayDelivery }>>(
      "GET",
      "ly_mcp_pending",
      {
        query: `device_key=eq.${
          encodeURIComponent(key)
        }&select=id,body&order=id.asc&limit=1`,
      },
    );
    const first = pending[0];
    if (first) {
      await this.rpc("DELETE", "ly_mcp_pending", {
        query: `id=eq.${first.id}`,
      });
      await this.publish(sessionId, rpcResult(rpcId, first.body));
      return;
    }
    await this.rpc("POST", "ly_mcp_sub", {
      body: [{
        device_key: key,
        session_id: sessionId,
        rpc_id: String(rpcId),
      }],
      headers: { Prefer: "resolution=merge-duplicates" },
      query: "on_conflict=device_key",
    });
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
