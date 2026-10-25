import {
  type EngineCommand,
  GameEngine,
  type SayDelivery,
} from "../../engine/service/game.ts";
import { type RpcId, rpcResult } from "./protocol.ts";

export function deviceKey(deviceId: string, seat?: "A" | "B"): string {
  return seat ? `${deviceId}:${seat}` : deviceId;
}

export type HubCall = {
  sessionId: string;
  rpcId: RpcId;
  command: EngineCommand;
};

/** 本进程能直接写到的 SSE。写成功返回 true。 */
export type LocalSend = (sessionId: string, body: unknown) => boolean;

export class MemoryHub {
  private readonly parked = new Map<
    string,
    { sessionId: string; rpcId: RpcId }
  >();
  private readonly pending = new Map<string, SayDelivery[]>();

  constructor(
    private readonly engine: GameEngine,
    private readonly send: LocalSend,
  ) {}

  watch(_sessionId: string): void {}

  unwatch(_sessionId: string): void {}

  publish(sessionId: string, body: unknown): Promise<void> {
    this.send(sessionId, body);
    return Promise.resolve();
  }

  cancel(sessionId: string, rpcId: RpcId): Promise<void> {
    for (const [key, waiter] of this.parked) {
      if (
        waiter.sessionId === sessionId &&
        String(waiter.rpcId) === String(rpcId)
      ) {
        this.parked.delete(key);
      }
    }
    return Promise.resolve();
  }

  async call(input: HubCall): Promise<unknown | null> {
    const result = await this.engine.handle(input.command);
    if (result.caller) {
      const body = rpcResult(input.rpcId, result.caller);
      await this.publish(input.sessionId, body);
      for (const push of result.pushes) {
        this.enqueue(deviceKey(push.deviceId, push.seat), push.delivery);
      }
      return body;
    }
    for (const push of result.pushes) {
      this.enqueue(deviceKey(push.deviceId, push.seat), push.delivery);
    }
    if (input.command.tool === "wait_event") {
      this.park(
        deviceKey(input.command.deviceId, input.command.seat),
        input.sessionId,
        input.rpcId,
      );
      return null;
    }
    const body = rpcResult(input.rpcId, {
      code: "ACCEPTED",
      event_id: "",
      say: "",
      clips: [],
      stop_clips: false,
      ack_required: false,
      phase: "LOBBY",
      wait: true,
    });
    await this.publish(input.sessionId, body);
    return body;
  }

  private enqueue(key: string, delivery: SayDelivery): void {
    const waiter = this.parked.get(key);
    if (
      waiter &&
      this.send(waiter.sessionId, rpcResult(waiter.rpcId, delivery))
    ) {
      this.parked.delete(key);
      return;
    }
    if (waiter) this.parked.delete(key);
    const queue = this.pending.get(key) ?? [];
    queue.push(delivery);
    this.pending.set(key, queue);
  }

  private park(key: string, sessionId: string, rpcId: RpcId): void {
    const queue = this.pending.get(key);
    if (queue?.length) {
      const delivery = queue.shift()!;
      if (queue.length === 0) this.pending.delete(key);
      this.send(sessionId, rpcResult(rpcId, delivery));
      return;
    }
    this.parked.set(key, { sessionId, rpcId });
  }
}
