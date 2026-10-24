import {
  bumpAudio,
  cleanName,
  emptyRoom,
  makePlayer,
  type OutItem,
  peekAudio,
  reduce,
  roomCodeFromArgs,
  type RoomState,
  type RpcId,
  speak,
  toolResult,
} from "../game/logic.ts";
import type { ChantLookup } from "./audio.ts";
import type { CallInput, Delivery, Store } from "./store.ts";

type RoomRow = { version: number; state: RoomState };

export class SupabaseStore implements Store {
  constructor(
    private url: string,
    private key: string,
    private log = false,
  ) {}

  async call(input: CallInput): Promise<void> {
    if (input.name === "set_name") {
      const name = cleanName(String(input.args.name ?? ""));
      if (name) await this.upsertName(input.deviceId, name);
    }
    if (input.name === "create_room") {
      await this.createRoom(input);
      return;
    }
    if (input.name === "join_room") {
      await this.joinRoom(input);
      return;
    }
    const code = await this.roomOf(input.deviceId);
    if (!code) {
      if (input.name === "set_name") {
        const name = cleanName(String(input.args.name ?? ""));
        await this.deliver(
          input.deviceId,
          toolResult(
            input.rpcId,
            speak(name ? `已记下，你是${name}。` : "没听清名字。"),
          ),
        );
        return;
      }
      await this.deliver(
        input.deviceId,
        toolResult(input.rpcId, speak("先开房间或加入。")),
      );
      return;
    }
    const saved = await this.deviceName(input.deviceId);
    await this.mutate(code, (state) =>
      reduce(state, {
        type: "tool",
        deviceId: input.deviceId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        rpcId: input.rpcId,
        name: input.name,
        args: { ...input.args, name: input.args.name ?? saved },
        audioEnabled: input.audioEnabled,
        sfxBase: input.sfxBase,
        now: input.now,
      }));
  }

  async tick(
    now: number,
    sfxBase: string,
    deviceId?: string | null,
  ): Promise<void> {
    const codes = new Set(await this.battleCodes());
    if (deviceId) {
      const code = await this.roomOf(deviceId);
      if (code) codes.add(code);
    }
    for (const code of codes) {
      await this.mutate(
        code,
        (state) => reduce(state, { type: "tick", now, sfxBase }),
      );
    }
  }

  async audioPass(now: number, lookup: ChantLookup): Promise<void> {
    for (const code of await this.battleCodes()) {
      const row = await this.getRoom(code);
      if (!row) continue;
      for (const job of peekAudio(row.state, now)) {
        let url: string | null = null;
        try {
          url = await lookup({
            deviceId: job.deviceId,
            utterance: job.job.utterance,
            agentId: job.job.agentId,
            sessionId: job.job.sessionId,
          });
        } catch (error) {
          console.error("chant lookup failed", error);
        }
        await this.mutate(code, (state) => {
          if (!state.audio[job.deviceId]) return { state, outbox: [] };
          if (!url) {
            return { state: bumpAudio(state, job.deviceId, now), outbox: [] };
          }
          return reduce(state, {
            type: "audio",
            deviceId: job.deviceId,
            url,
            now,
          });
        });
      }
    }
  }

  cancel(deviceId: string, rpcId: RpcId): Promise<void> {
    return this.withRoom(
      deviceId,
      (state) => reduce(state, { type: "cancel", deviceId, rpcId }),
    );
  }

  async deliver(deviceId: string, body: unknown): Promise<void> {
    await this.insertOutbox([{ deviceId, body }]);
  }

  async hold(deviceId: string): Promise<void> {
    const ok = await this.rpc("ly_hold", { p_device: deviceId });
    if (ok === false) console.error("ly_hold failed", deviceId);
  }

  async release(deviceId: string): Promise<void> {
    const ok = await this.rpc("ly_release", { p_device: deviceId });
    if (ok === false) console.error("ly_release failed", deviceId);
  }

  async drain(deviceId: string | null, holder = false): Promise<Delivery[]> {
    const res = await this.rpc("ly_peek", {
      p_device: deviceId,
      p_holder: holder,
    });
    if (!Array.isArray(res)) return [];
    const out: Delivery[] = [];
    for (const row of res) {
      if (!row || typeof row !== "object") continue;
      const item = row as { id?: unknown; body?: unknown };
      const id = item.id;
      if (typeof id !== "number" && typeof id !== "string") continue;
      out.push({ id, body: item.body });
    }
    return out;
  }

  async ack(ids: Array<number | string>): Promise<void> {
    if (!ids.length) return;
    await this.rpc("ly_ack", { p_ids: ids });
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async createRoom(input: CallInput): Promise<void> {
    await this.removeFrom(input.deviceId, input.now, input.sfxBase);
    const saved = cleanName(String(input.args.name ?? "")) ||
      await this.deviceName(input.deviceId) || "玩家";
    const host = makePlayer(input.deviceId, saved, input.now);
    host.agentId = input.agentId;
    host.sessionId = input.sessionId;
    const state = emptyRoom("0000", host);
    const line = (code: string) =>
      toolResult(input.rpcId, speak(`房间${code}。等对手加入。`));
    for (let i = 0; i < 6; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      state.world.code = code;
      const ok = await this.rpc("ly_create", {
        p_code: code,
        p_state: state,
        p_outbox: [{ device_id: input.deviceId, body: line(code) }],
      }, true);
      if (ok !== false) {
        if (this.log) {
          console.log(`${input.deviceId} 房间${code}。等对手加入。`);
        }
        return;
      }
    }
    await this.deliver(
      input.deviceId,
      toolResult(input.rpcId, speak("开房失败，再说一次。")),
    );
  }

  private async joinRoom(input: CallInput): Promise<void> {
    const code = roomCodeFromArgs(input.args);
    if (!code || !await this.getRoom(code)) {
      await this.deliver(
        input.deviceId,
        toolResult(input.rpcId, speak("没有这个房间。")),
      );
      return;
    }
    if (await this.roomOf(input.deviceId) !== code) {
      await this.removeFrom(input.deviceId, input.now, input.sfxBase);
    }
    const saved = await this.deviceName(input.deviceId);
    await this.mutate(code, (state) =>
      reduce(state, {
        type: "tool",
        deviceId: input.deviceId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        rpcId: input.rpcId,
        name: "join_room",
        args: { ...input.args, name: input.args.name ?? saved },
        audioEnabled: input.audioEnabled,
        sfxBase: input.sfxBase,
        now: input.now,
      }));
  }

  private async removeFrom(deviceId: string, now: number, sfxBase: string) {
    const code = await this.roomOf(deviceId);
    if (!code) return;
    await this.mutate(
      code,
      (state) => reduce(state, { type: "remove", deviceId, now, sfxBase }),
    );
  }

  private async withRoom(
    deviceId: string,
    fn: (state: RoomState) => { state: RoomState; outbox: OutItem[] },
  ) {
    const code = await this.roomOf(deviceId);
    if (!code) return;
    await this.mutate(code, fn);
  }

  private async mutate(
    code: string,
    fn: (state: RoomState) => { state: RoomState; outbox: OutItem[] },
  ) {
    for (let i = 0; i < 16; i++) {
      const row = await this.getRoom(code);
      if (!row) return;
      const before = JSON.stringify(row.state);
      const next = fn(row.state);
      if (
        next.outbox.length === 0 && JSON.stringify(next.state) === before
      ) {
        return;
      }
      const ok = await this.rpc("ly_apply", {
        p_code: code,
        p_expected: row.version,
        p_state: next.state,
        p_outbox: next.outbox.map((item) => ({
          device_id: item.deviceId,
          body: item.body,
        })),
      });
      if (ok === true) {
        if (this.log) {
          for (const item of next.outbox) {
            const text = item.body.result.content[0]?.text ?? "";
            console.log(`${item.deviceId} ${text}`);
          }
        }
        return;
      }
    }
    throw new Error(`room ${code} busy`);
  }

  private async roomOf(deviceId: string): Promise<string | null> {
    const rows = await this.rest<Array<{ room_code: string | null }>>(
      `ly_device?device_id=eq.${encodeURIComponent(deviceId)}&select=room_code`,
    );
    return rows[0]?.room_code ?? null;
  }

  private async deviceName(deviceId: string): Promise<string> {
    const rows = await this.rest<Array<{ name: string | null }>>(
      `ly_device?device_id=eq.${encodeURIComponent(deviceId)}&select=name`,
    );
    return rows[0]?.name ?? "";
  }

  private async battleCodes(): Promise<string[]> {
    const rows = await this.rest<Array<{ code: string }>>(
      "ly_room?phase=eq.battle&select=code",
    );
    return rows.map((row) => row.code);
  }

  private async getRoom(code: string): Promise<RoomRow | null> {
    const rows = await this.rest<RoomRow[]>(
      `ly_room?code=eq.${encodeURIComponent(code)}&select=version,state`,
    );
    return rows[0] ?? null;
  }

  private async upsertName(deviceId: string, name: string) {
    await this.rest("ly_device", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ device_id: deviceId, name }),
    });
  }

  private async insertOutbox(
    items: Array<{ deviceId: string; body: unknown }>,
  ) {
    if (!items.length) return;
    await this.rest("ly_outbox", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(
        items.map((item) => ({ device_id: item.deviceId, body: item.body })),
      ),
    });
  }

  private async rpc(
    name: string,
    args: Record<string, unknown>,
    allowConflict = false,
  ): Promise<unknown> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    if (allowConflict && res.status === 409) return false;
    if (!res.ok) {
      console.error(name, res.status, await res.text());
      return false;
    }
    if (res.status === 204) return true;
    const text = await res.text();
    if (!text) return true;
    return JSON.parse(text);
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: { ...this.headers(init.headers), ...(init.body ? {} : {}) },
    });
    if (!res.ok) {
      throw new Error(`${path} ${res.status} ${await res.text()}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(extra).entries()),
    };
  }
}
