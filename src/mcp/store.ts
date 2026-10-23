import {
  bumpAudio,
  cleanName,
  emptyRoom,
  makePlayer,
  peekAudio,
  reduce,
  roomCodeOf,
  type RoomState,
  type RpcId,
  speak,
  toolResult,
} from "../game/logic.ts";
import type { ChantLookup } from "./audio.ts";

export type CallInput = {
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

export interface Store {
  call(input: CallInput): Promise<void>;
  tick(now: number, sfxBase: string): Promise<void>;
  audioPass(now: number, lookup: ChantLookup): Promise<void>;
  cancel(deviceId: string, rpcId: RpcId): Promise<void>;
  deliver(deviceId: string, body: unknown): Promise<void>;
  drain(deviceId: string | null): Promise<unknown[]>;
  wait(ms: number): Promise<void>;
}

type Box = { key: string; body: unknown };

export class MemoryStore implements Store {
  private rooms = new Map<string, RoomState>();
  private where = new Map<string, string>();
  private names = new Map<string, string>();
  private out: Box[] = [];
  private lock: Promise<void> = Promise.resolve();
  private kick = new Set<() => void>();

  constructor(private log = false) {}

  call(input: CallInput): Promise<void> {
    return this.run(async () => {
      if (input.name === "set_name") {
        const name = cleanName(String(input.args.name ?? ""));
        if (name) this.names.set(input.deviceId, name);
      }
      if (input.name === "create_room") {
        await this.createRoom(input);
        return;
      }
      if (input.name === "join_room") {
        await this.joinRoom(input);
        return;
      }
      const code = this.where.get(input.deviceId);
      if (!code || !this.rooms.has(code)) {
        if (input.name === "set_name") {
          const name = this.names.get(input.deviceId);
          this.push([{
            deviceId: input.deviceId,
            body: toolResult(
              input.rpcId,
              speak(name ? `已记下，你是${name}。` : "没听清名字。"),
            ),
          }]);
          return;
        }
        this.push([{
          deviceId: input.deviceId,
          body: toolResult(input.rpcId, speak("先开房间或加入。")),
        }]);
        return;
      }
      this.apply(code, input);
    });
  }

  tick(now: number, sfxBase: string): Promise<void> {
    return this.run(() => {
      for (const [code, state] of [...this.rooms]) {
        if (state.world.phase !== "battle") continue;
        const reduced = reduce(state, { type: "tick", now, sfxBase });
        this.push(reduced.outbox);
        this.commit(code, reduced.state);
      }
    });
  }

  audioPass(now: number, lookup: ChantLookup): Promise<void> {
    return this.run(async () => {
      for (const [code, state] of [...this.rooms]) {
        const jobs = peekAudio(state, now);
        let current = this.rooms.get(code) ?? state;
        for (const job of jobs) {
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
            url = null;
          }
          if (url) {
            const reduced = reduce(current, {
              type: "audio",
              deviceId: job.deviceId,
              url,
              now,
            });
            current = reduced.state;
            this.push(reduced.outbox);
          } else {
            current = bumpAudio(current, job.deviceId, now);
          }
        }
        this.rooms.set(code, current);
      }
    });
  }

  cancel(deviceId: string, rpcId: RpcId): Promise<void> {
    return this.run(() => {
      const code = this.where.get(deviceId);
      if (!code) return;
      const state = this.rooms.get(code);
      if (!state) return;
      const reduced = reduce(state, { type: "cancel", deviceId, rpcId });
      this.commit(code, reduced.state);
    });
  }

  deliver(deviceId: string, body: unknown): Promise<void> {
    return this.run(() => {
      this.push([{ deviceId, body }]);
    });
  }

  drain(deviceId: string | null): Promise<unknown[]> {
    return this.run(() => {
      if (deviceId === null) {
        const all = this.out.splice(0);
        return all.map((item) => item.body);
      }
      const keep: Box[] = [];
      const taken: unknown[] = [];
      for (const item of this.out) {
        if (item.key === deviceId) taken.push(item.body);
        else keep.push(item);
      }
      this.out = keep;
      return taken;
    });
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.kick.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.kick.add(wake);
    });
  }

  private apply(code: string, input: CallInput) {
    const state = this.rooms.get(code);
    if (!state) return;
    const reduced = reduce(state, {
      type: "tool",
      deviceId: input.deviceId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      rpcId: input.rpcId,
      name: input.name,
      args: {
        ...input.args,
        name: input.args.name ?? this.names.get(input.deviceId) ?? "",
      },
      audioEnabled: input.audioEnabled,
      sfxBase: input.sfxBase,
      now: input.now,
    });
    this.push(reduced.outbox);
    this.commit(code, reduced.state);
  }

  private createRoom(input: CallInput) {
    this.removeFrom(input.deviceId, input.now, input.sfxBase);
    const name = cleanName(String(input.args.name ?? "")) ||
      this.names.get(input.deviceId) || "玩家";
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const host = makePlayer(input.deviceId, name, input.now);
    host.agentId = input.agentId;
    host.sessionId = input.sessionId;
    this.commit(code, emptyRoom(code, host));
    this.push([{
      deviceId: input.deviceId,
      body: toolResult(input.rpcId, speak(`房间${code}。等对手加入。`)),
    }]);
  }

  private joinRoom(input: CallInput) {
    const code = roomCodeOf(input.args.code);
    if (!code || !this.rooms.has(code)) {
      this.push([{
        deviceId: input.deviceId,
        body: toolResult(input.rpcId, speak("没有这个房间。")),
      }]);
      return;
    }
    if (this.where.get(input.deviceId) !== code) {
      this.removeFrom(input.deviceId, input.now, input.sfxBase);
    }
    this.apply(code, input);
  }

  private removeFrom(deviceId: string, now: number, sfxBase: string) {
    const code = this.where.get(deviceId);
    if (!code) return;
    const state = this.rooms.get(code);
    if (!state) return;
    const reduced = reduce(state, { type: "remove", deviceId, now, sfxBase });
    this.push(reduced.outbox);
    this.commit(code, reduced.state);
  }

  private commit(code: string, state: RoomState) {
    if (state.world.players.length === 0) {
      this.rooms.delete(code);
      for (const [id, room] of this.where) {
        if (room === code) this.where.delete(id);
      }
      return;
    }
    this.rooms.set(code, state);
    for (const [id, room] of this.where) {
      if (
        room === code && !state.world.players.some((p) => p.deviceId === id)
      ) {
        this.where.delete(id);
      }
    }
    for (const player of state.world.players) {
      this.where.set(player.deviceId, code);
    }
  }

  private push(items: Array<{ deviceId: string; body: unknown }>) {
    for (const item of items) {
      this.out.push({ key: item.deviceId, body: item.body });
      const line = brief(item.deviceId, item.body);
      if (this.log && line.trim() !== item.deviceId) console.log(line);
    }
    if (items.length) {
      for (const wake of this.kick) wake();
    }
  }

  private run<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => {}, () => {});
    return run;
  }
}

function randomCode(): string {
  return String(1000 + Math.floor(Math.random() * 9000));
}

function brief(deviceId: string, body: unknown): string {
  const text =
    (body as { result?: { content?: Array<{ text?: string }> } }).result
      ?.content?.[0]?.text ?? "";
  return `${deviceId} ${text}`;
}
