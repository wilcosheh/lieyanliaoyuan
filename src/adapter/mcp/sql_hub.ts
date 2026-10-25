import { GameEngine, type SayDelivery } from "../../engine/service/game.ts";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { extractJoinCode } from "../../engine/service/game.ts";
import { deviceKey, type HubCall, type LocalSend } from "./hub.ts";
import { poolerDatabaseUrl } from "./postgres.ts";
import { type RpcId, rpcResult } from "./protocol.ts";
import { absorbPeer, peerIsRelevant, textNeedsRoomLock } from "./room_sync.ts";

type Sql = {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  json(value: unknown): unknown;
  end(options?: { timeout?: number }): Promise<void>;
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

type CallOutcome = {
  body: unknown | null;
  deliverCaller: boolean;
};

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
    const text = input.command.text ?? "";
    const outcome = await this.transact(
      input,
      key,
      textNeedsRoomLock(text),
    );
    if (outcome.deliverCaller && outcome.body !== null) {
      // 状态事务已提交。调用方句子走 HTTP/SSE，不再占着设备锁等 insert。
      await this.publish(input.sessionId, outcome.body);
    }
    return outcome.body;
  }

  private async transact(
    input: HubCall,
    key: string,
    crossHint: boolean,
  ): Promise<CallOutcome> {
    const sql = await this.query();
    const joinCode = extractJoinCode(input.command.text ?? "");
    const wantNotices = input.command.tool === "submit_lobby_text";
    return await sql.begin(async (tx) => {
      if (crossHint) {
        await tx`
          select
            pg_advisory_xact_lock(hashtext('ly-rooms')),
            pg_advisory_xact_lock(hashtext(${key}))
        `;
      } else {
        await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
      }

      const boot = await this.loadBoot(tx, key, wantNotices);
      const before = boot.state;
      const loaded = new Map<string, EngineSnapshot | null>([[key, before]]);
      let merged = before;

      const needPeers = this.needsPeers(key, before, joinCode);
      if (needPeers && !crossHint) {
        await tx`select pg_advisory_xact_lock(hashtext('ly-rooms'))`;
      }
      if (needPeers) {
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
      await this.saveChanged(tx, key, loaded, next);

      if (result.caller && wantNotices && boot.notices.length > 0) {
        result.caller.say = `${boot.notices.join("")}${result.caller.say}`;
        if (result.caller.phase === "LOBBY") result.caller.wait = true;
      }

      for (const push of result.pushes) {
        await this.route(
          tx,
          deviceKey(push.deviceId, push.seat),
          push.delivery,
        );
      }

      if (!result.caller && input.command.tool === "wait_event") {
        await this.park(tx, key, input.sessionId, input.rpcId);
        return { body: null, deliverCaller: false };
      }

      if (result.caller) {
        return {
          body: rpcResult(input.rpcId, result.caller),
          deliverCaller: true,
        };
      }
      return {
        body: rpcResult(input.rpcId, EMPTY),
        deliverCaller: true,
      };
    });
  }

  private async loadBoot(
    tx: Sql,
    key: string,
    wantNotices: boolean,
  ): Promise<{ state: EngineSnapshot | null; notices: string[] }> {
    if (!wantNotices) {
      const [row] = await tx<{ state: EngineSnapshot }[]>`
        select state from ly_device_engine where device_key = ${key}
      `;
      return { state: row?.state ?? null, notices: [] };
    }
    const [row] = await tx<{
      state: EngineSnapshot | null;
      notices: SayDelivery[];
    }[]>`
      with self as (
        select state from ly_device_engine where device_key = ${key}
      ),
      removed as (
        delete from ly_mcp_pending
        where device_key = ${key}
        returning id, body
      )
      select
        (select state from self) as state,
        coalesce(
          (select json_agg(body order by id) from removed),
          '[]'::json
        ) as notices
    `;
    const notices = (row?.notices ?? []).flatMap((body) =>
      body?.say.includes("对手") ? [body.say] : []
    );
    return { state: row?.state ?? null, notices };
  }

  private async saveChanged(
    tx: Sql,
    key: string,
    loaded: Map<string, EngineSnapshot | null>,
    next: EngineSnapshot,
  ): Promise<void> {
    const deviceIds = new Set<string>([key]);
    for (const actor of next.actors) deviceIds.add(actor.deviceId);
    for (const device of next.devices) deviceIds.add(device.deviceId);
    const dirty: string[] = [];
    for (const deviceId of deviceIds) {
      const previous = loaded.get(deviceId) ?? null;
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      dirty.push(deviceId);
    }
    if (dirty.length === 0) return;
    if (dirty.length === 1) {
      const deviceId = dirty[0]!;
      await tx`
        insert into ly_device_engine (device_key, state, updated_at)
        values (${deviceId}, ${tx.json(next)}, now())
        on conflict (device_key) do update
        set state = excluded.state, updated_at = excluded.updated_at
      `;
      return;
    }
    for (const deviceId of dirty) {
      await tx`
        insert into ly_device_engine (device_key, state, updated_at)
        values (${deviceId}, ${tx.json(next)}, now())
        on conflict (device_key) do update
        set state = excluded.state, updated_at = excluded.updated_at
      `;
    }
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
    const task = work();
    task.catch(() => {});
    try {
      return await Promise.race([
        task,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            const sql = this.sql;
            this.sql = null;
            sql?.end({ timeout: 1 }).catch(() => {});
            reject(new Error(`mcp call budget ${ms}ms`));
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async query(): Promise<Sql> {
    if (this.sql) return this.sql;
    const { default: postgres } = await import("postgres");
    const databaseUrl = poolerDatabaseUrl(this.databaseUrl);
    const ssl = databaseUrl.includes("sslmode=disable")
      ? false
      : "require" as const;
    this.sql = postgres(databaseUrl, {
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
