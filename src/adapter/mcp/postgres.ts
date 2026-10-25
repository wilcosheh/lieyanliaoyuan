import { GameEngine, type SayDelivery } from "../../engine/service/game.ts";
import type { EngineSnapshot } from "../../engine/service/game.ts";
import { deviceKey, type HubCall, type LocalSend } from "./hub.ts";
import { type RpcId, rpcResult } from "./protocol.ts";

type Sql = {
  begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  listen(channel: string, callback: (payload: string) => void): Promise<void>;
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
  wait: true,
};

export class PostgresHub {
  private sql: Sql | null = null;
  private listening = false;
  private readonly watchers = new Set<string>();

  constructor(
    private readonly databaseUrl: string,
    private readonly owns: (sessionId: string) => boolean,
    private readonly send: LocalSend,
  ) {}

  /** SSE 打开时调用，让本实例开始收 NOTIFY。 */
  watch(sessionId: string): void {
    this.watchers.add(sessionId);
    this.ensureListen().catch((error) => {
      console.error("mcp listen", error);
    });
    this.drain(sessionId).catch((error) => {
      console.error("mcp drain", error);
    });
  }

  unwatch(sessionId: string): void {
    this.watchers.delete(sessionId);
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
    const sql = await this.query();
    return await sql.begin(async (tx) => {
      const engine = new GameEngine();
      const [row] = await tx<{ state: EngineSnapshot }[]>`
        select state from ly_engine where id = 1 for update
      `;
      engine.loadState(row?.state);
      const result = await engine.handle(input.command);
      await tx`
        update ly_engine set state = ${
        tx.json(engine.exportState())
      } where id = 1
      `;
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
          deviceKey(input.command.deviceId, input.command.seat),
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
      select session_id, rpc_id from ly_mcp_sub where device_key = ${key} for update
    `;
    if (!sub) {
      await tx`
        insert into ly_mcp_pending (device_key, body)
        values (${key}, ${tx.json(delivery)})
      `;
      return;
    }
    await tx`delete from ly_mcp_sub where device_key = ${key}`;
    const rpcId = restoreRpcId(sub.rpc_id);
    await this.deliver(tx, sub.session_id, rpcResult(rpcId, delivery));
  }

  private async park(
    tx: Sql,
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<void> {
    const [pending] = await tx<{ id: number; body: SayDelivery }[]>`
      delete from ly_mcp_pending
      where id = (
        select id from ly_mcp_pending
        where device_key = ${key}
        order by id
        for update
        limit 1
      )
      returning id, body
    `;
    if (pending) {
      await this.deliver(tx, sessionId, rpcResult(rpcId, pending.body));
      return;
    }
    await this.rebind(tx, key, sessionId, rpcId);
    await tx`
      insert into ly_mcp_sub (device_key, session_id, rpc_id)
      values (${key}, ${sessionId}, ${String(rpcId)})
      on conflict (device_key) do update
      set session_id = excluded.session_id, rpc_id = excluded.rpc_id
    `;
  }

  private async rebind(
    tx: Sql,
    key: string,
    sessionId: string,
    rpcId: RpcId,
  ): Promise<void> {
    const rows = await tx<{ id: number; body: { id?: RpcId } }[]>`
      select id, body from ly_mcp_message
      where device_key = ${key} and session_id <> ${sessionId}
      for update
    `;
    for (const row of rows) {
      await tx`
        update ly_mcp_message
        set session_id = ${sessionId}, body = ${
        tx.json({ ...row.body, id: rpcId })
      }
        where id = ${row.id}
      `;
    }
  }

  private async ensureListen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    const sql = await this.query();
    await sql.listen("mcp", (payload) => {
      const sessionId = String(payload);
      if (!this.owns(sessionId) && !this.watchers.has(sessionId)) return;
      this.drain(sessionId).catch((error) => {
        console.error("mcp drain", error);
      });
    });
    for (const sessionId of this.watchers) {
      this.drain(sessionId).catch((error) => {
        console.error("mcp drain", error);
      });
    }
  }

  /** SSE 心跳时再抽一次，防止 NOTIFY 丢失。 */
  tick(sessionId: string): void {
    this.drain(sessionId).catch((error) => {
      console.error("mcp drain", error);
    });
  }

  private async query(): Promise<Sql> {
    if (this.sql) return this.sql;
    const { default: postgres } = await import("postgres");
    const databaseUrl = listenDatabaseUrl(this.databaseUrl);
    const ssl = databaseUrl.includes("sslmode=disable")
      ? false
      : "require" as const;
    this.sql = postgres(databaseUrl, {
      max: 4,
      ssl,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    }) as unknown as Sql;
    return this.sql;
  }

  private async drain(sessionId: string): Promise<void> {
    if (!this.owns(sessionId) || !this.sql) return;
    const rows = await this.sql<{ body: unknown }[]>`
      delete from ly_mcp_message
      where session_id = ${sessionId}
      returning body
    `;
    for (const row of rows) this.send(sessionId, row.body);
  }
}

/** 6543 是事务池化，收不到 LISTEN。同一账号改走 5432 会话模式。 */
export function listenDatabaseUrl(raw: string): string {
  return raw.replace(":6543/", ":5432/");
}

function restoreRpcId(value: string): RpcId {
  return /^-?\d+$/.test(value) ? Number(value) : value;
}
