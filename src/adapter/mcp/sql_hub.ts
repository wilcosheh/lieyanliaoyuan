import { GameEngine, type SayDelivery } from "../../engine/service/game.ts";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { extractJoinCode } from "../../engine/service/game.ts";
import { deviceKey, type HubCall, type LocalSend } from "./hub.ts";
import { type RpcId, rpcResult } from "./protocol.ts";
import { absorbPeer, peerIsRelevant } from "./room_sync.ts";

type Sql = {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
  <T = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

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

const CALL_BUDGET_MS = 12000;

/** 按设备直接读写 Postgres，不经过 PostgREST，也不 LISTEN。 */
export class SqlHub {
  private sql: Sql | null = null;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly databaseUrl: string,
    private readonly owns: (sessionId: string) => boolean,
    private readonly send: LocalSend,
  ) {}

  watch(sessionId: string): void {
    this.drain(sessionId).catch((error) => console.error("mcp drain", error));
  }

  unwatch(_sessionId: string): void {}

  tick(sessionId: string): Promise<void> {
    return this.drain(sessionId).catch((error) => {
      console.error("mcp drain", error);
    });
  }

  async publish(sessionId: string, body: unknown): Promise<void> {
    if (this.send(sessionId, body)) return;
    const sql = await this.query();
    await sql`
      insert into ly_mcp_message (session_id, body)
      values (${sessionId}, ${sql.json(body)})
    `;
  }

  async cancel(sessionId: string, rpcId: RpcId): Promise<void> {
    const sql = await this.query();
    await sql`
      delete from ly_mcp_sub
      where session_id = ${sessionId} and rpc_id = ${String(rpcId)}
    `;
  }

  async call(input: HubCall): Promise<unknown | null> {
    const key = deviceKey(input.command.deviceId, input.command.seat);
    try {
      return await this.serialize(
        key,
        () => this.withBudget(CALL_BUDGET_MS, () => this.runCall(input, key)),
      );
    } catch (error) {
      return await this.fallback(input, error);
    }
  }

  private async runCall(
    input: HubCall,
    key: string,
  ): Promise<unknown | null> {
    const sql = await this.query();
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('ly-rooms'))`;
      await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
      const [row] = await tx<{ state: EngineSnapshot }[]>`
        select state from ly_device_engine where device_key = ${key}
      `;
      const before = row?.state ?? null;
      const joinCode = extractJoinCode(input.command.text ?? "");
      const loaded = new Map<string, EngineSnapshot | null>([[key, before]]);
      let merged = before;
      if (this.needsPeers(key, before, joinCode)) {
        const others = await tx<
          { device_key: string; state: EngineSnapshot }[]
        >`
          select device_key, state from ly_device_engine
          where device_key <> ${key}
        `;
        for (const other of others) {
          if (!peerIsRelevant(other.device_key, other.state, key, joinCode)) {
            continue;
          }
          loaded.set(other.device_key, other.state);
          merged = absorbPeer(merged, other.device_key, other.state);
        }
      }
      const engine = new GameEngine();
      engine.loadState(merged);
      const result = await engine.handle(input.command);
      const next = engine.exportState();
      const deviceIds = new Set<string>([key]);
      for (const actor of next.actors) deviceIds.add(actor.deviceId);
      for (const device of next.devices) deviceIds.add(device.deviceId);
      for (const deviceId of deviceIds) {
        const previous = loaded.get(deviceId) ?? null;
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        await tx`
          insert into ly_device_engine (device_key, state, updated_at)
          values (${deviceId}, ${tx.json(next)}, now())
          on conflict (device_key) do update
          set state = excluded.state, updated_at = excluded.updated_at
        `;
      }
      if (
        result.caller && input.command.tool === "submit_lobby_text"
      ) {
        const notices = await this.takeNotices(tx, key);
        if (notices.length > 0) {
          result.caller.say = `${notices.join("")}${result.caller.say}`;
          if (result.caller.phase === "LOBBY") result.caller.wait = true;
        }
      }
      let body: unknown | null = null;
      if (result.caller) {
        body = rpcResult(input.rpcId, result.caller);
        await this.deliver(tx, input.sessionId, body);
      }
      for (const push of result.pushes) {
        await this.route(
          tx,
          deviceKey(push.deviceId, push.seat),
          push.delivery,
        );
      }
      if (!result.caller && input.command.tool === "wait_event") {
        await this.park(
          tx,
          key,
          input.sessionId,
          input.rpcId,
        );
        return null;
      }
      if (!result.caller) {
        body = rpcResult(input.rpcId, EMPTY);
        await this.deliver(tx, input.sessionId, body);
      }
      return body;
    });
  }

  private needsPeers(
    key: string,
    state: EngineSnapshot | null,
    joinCode: string | null,
  ): boolean {
    if (joinCode) return true;
    if (!state) return false;
    return state.rooms.length > 0 ||
      state.actors.some((actor) =>
        actor.mode === "ONLINE" && actor.deviceId !== key
      );
  }

  private async takeNotices(tx: Sql, key: string): Promise<string[]> {
    const rows = await tx<{ body: SayDelivery }[]>`
      with doomed as (
        select id from ly_mcp_pending
        where device_key = ${key}
        order by id
      ),
      removed as (
        delete from ly_mcp_pending as pending
        using doomed
        where pending.id = doomed.id
        returning pending.id, pending.body
      )
      select body from removed order by id
    `;
    return rows.flatMap((row) =>
      row.body?.say.includes("对手") ? [row.body.say] : []
    );
  }

  private async deliver(
    tx: Sql,
    sessionId: string,
    body: unknown,
  ): Promise<void> {
    if (this.send(sessionId, body)) return;
    await tx`
      insert into ly_mcp_message (session_id, body)
      values (${sessionId}, ${tx.json(body)})
    `;
  }

  private async route(
    tx: Sql,
    key: string,
    delivery: SayDelivery,
  ): Promise<void> {
    const [sub] = await tx<{ session_id: string; rpc_id: string }[]>`
      select session_id, rpc_id from ly_mcp_sub
      where device_key = ${key}
    `;
    if (!sub) {
      await tx`
        insert into ly_mcp_pending (device_key, body)
        values (${key}, ${tx.json(delivery)})
      `;
      return;
    }
    await tx`delete from ly_mcp_sub where device_key = ${key}`;
    await this.deliver(
      tx,
      sub.session_id,
      rpcResult(restoreRpcId(sub.rpc_id), delivery),
    );
  }

  private async park(
    tx: Sql,
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<void> {
    const pending = await tx<{ id: number; body: SayDelivery }[]>`
      with doomed as (
        select id from ly_mcp_pending
        where device_key = ${key}
        order by id
      ),
      removed as (
        delete from ly_mcp_pending as pending
        using doomed
        where pending.id = doomed.id
        returning pending.id, pending.body
      )
      select id, body from removed order by id
    `;
    const last = pending[pending.length - 1]?.body;
    if (last) {
      const say = pending.map((row) => row.body.say).filter((line) => line)
        .join("");
      await this.deliver(
        tx,
        sessionId,
        rpcResult(rpcId, {
          ...last,
          say,
          wait: last.phase === "BATTLE" ? last.wait : true,
        }),
      );
      return;
    }
    await tx`
      insert into ly_mcp_sub (device_key, session_id, rpc_id)
      values (${key}, ${sessionId}, ${String(rpcId)})
      on conflict (device_key) do update
      set session_id = excluded.session_id, rpc_id = excluded.rpc_id
    `;
  }

  private async fallback(input: HubCall, error: unknown): Promise<unknown> {
    console.error("mcp sql call", error);
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

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(work, work);
    this.chains.set(key, run.then(() => {}, () => {}));
    return run;
  }

  private async withBudget<T>(ms: number, work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`mcp call budget ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async query(): Promise<Sql> {
    if (this.sql) return this.sql;
    const { default: postgres } = await import("postgres");
    const ssl = this.databaseUrl.includes("sslmode=disable")
      ? false
      : "require" as const;
    this.sql = postgres(this.databaseUrl, {
      max: 1,
      ssl,
      idle_timeout: 20,
      connect_timeout: 5,
      prepare: false,
    }) as unknown as Sql;
    return this.sql;
  }

  private async drain(sessionId: string): Promise<void> {
    if (!this.owns(sessionId)) return;
    const sql = await this.query();
    const rows = await sql<{ body: unknown }[]>`
      delete from ly_mcp_message
      where session_id = ${sessionId}
      returning body
    `;
    for (const row of rows) this.send(sessionId, row.body);
  }
}

function restoreRpcId(value: string): RpcId {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}
