import {
  BattleController,
  type BattleResponse,
  type ControllerOptions,
  type RuleErrorCode,
  type SubmitActionInput,
} from "../rules/controller.ts";
import {
  BattleAlreadyExistsError,
  type BattleRecord,
  type BattleRepository,
  BattleVersionConflictError,
} from "../store/repository.ts";
import type { BattleEvent, BattleState } from "../rules/state.ts";

export type SessionErrorCode =
  | "BATTLE_NOT_FOUND"
  | "BATTLE_ALREADY_EXISTS"
  | "VERSION_CONFLICT";

export type SessionError = {
  code: SessionErrorCode | RuleErrorCode;
  message: string;
};

export type BattleSessionResponse<T = void> =
  | {
    ok: true;
    version: number;
    state: BattleState;
    events: BattleEvent[];
    value: T | undefined;
  }
  | {
    ok: false;
    version: number | null;
    state: BattleState | null;
    events: BattleEvent[];
    error: SessionError;
  };

export type MutationGuard = {
  expectedVersion?: number;
};

type MutateOptions = MutationGuard & {
  retryOnConflict?: boolean;
};

function sameState(left: BattleState, right: BattleState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 面向请求的对局应用服务，统一负责控制器的创建、恢复和销毁。
 * 请求层只能调用这里暴露的方法，不能持有状态机或直接写入对局快照。
 */
export class BattleSessionService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly repository: BattleRepository) {}

  async createBattle(input: {
    battleId: string;
    playerIds: string[];
    options?: ControllerOptions;
  }): Promise<BattleSessionResponse> {
    return await this.runExclusive(input.battleId, async () => {
      const options = structuredClone(input.options ?? {});
      const controller = new BattleController(
        input.battleId,
        input.playerIds,
        options,
      );
      try {
        // 固化创建时的完整角色配置，避免代码发布后改变正在进行的对局规则。
        const record = await this.repository.create({
          battleId: input.battleId,
          state: controller.getState(),
          controllerOptions: controller.getControllerOptions(),
        });
        return this.readResponse(record);
      } catch (error) {
        if (!(error instanceof BattleAlreadyExistsError)) throw error;
        const current = await this.repository.load(input.battleId);
        return this.sessionError(
          "BATTLE_ALREADY_EXISTS",
          current,
          error.message,
        );
      }
    });
  }

  async getBattle(battleId: string): Promise<BattleSessionResponse> {
    return await this.runExclusive(battleId, async () => {
      const record = await this.repository.load(battleId);
      return record
        ? this.readResponse(record)
        : this.sessionError("BATTLE_NOT_FOUND", null);
    });
  }

  async preparePlayer(
    battleId: string,
    playerId: string,
    characterId: string,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.preparePlayer(playerId, characterId),
      { ...guard, retryOnConflict: guard.expectedVersion === undefined },
    );
  }

  async setReady(
    battleId: string,
    playerId: string,
    ready = true,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.setReady(playerId, ready),
      { ...guard, retryOnConflict: guard.expectedVersion === undefined },
    );
  }

  async startBattle(
    battleId: string,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.startBattle(),
      { ...guard, retryOnConflict: guard.expectedVersion === undefined },
    );
  }

  async submitAction(
    battleId: string,
    input: SubmitActionInput,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.submitAction(input),
      { ...guard, retryOnConflict: guard.expectedVersion === undefined },
    );
  }

  async advance(
    battleId: string,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.advance(),
      guard,
    );
  }

  async concede(
    battleId: string,
    playerId: string,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.concede(playerId),
      guard,
    );
  }

  async archiveBattle(
    battleId: string,
    guard: MutationGuard = {},
  ): Promise<BattleSessionResponse> {
    return await this.mutate(
      battleId,
      (controller) => controller.archiveBattle(),
      { ...guard, retryOnConflict: guard.expectedVersion === undefined },
    );
  }

  private async mutate<T>(
    battleId: string,
    operation: (controller: BattleController) => BattleResponse<T>,
    options: MutateOptions,
  ): Promise<BattleSessionResponse<T>> {
    return await this.runExclusive(battleId, async () => {
      // 抢招等带业务前置条件的操作可在版本冲突后重新校验；阶段推进不能自动重试，
      // 否则同一次请求可能连续跨过 SETTLING 和 ENDING 两个阶段。
      const maxAttempts = options.retryOnConflict ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const record = await this.repository.load(battleId);
        if (!record) return this.sessionError("BATTLE_NOT_FOUND", null);
        if (
          options.expectedVersion !== undefined &&
          options.expectedVersion !== record.version
        ) {
          // 调用方基于旧快照发起的请求不能覆盖当前权威状态。
          return this.sessionError("VERSION_CONFLICT", record);
        }

        // 每次请求都从仓库快照恢复一个临时控制器，请求结束后不缓存控制器实例。
        const controller = BattleController.restore(
          record.state,
          record.controllerOptions,
        );
        const response = operation(controller);
        if (sameState(record.state, response.state)) {
          // 幂等重放没有产生新状态，不递增仓库版本号。
          return this.controllerResponse(response, record.version);
        }

        try {
          const savedVersion = await this.repository.save(
            battleId,
            record.version,
            response.state,
          );
          return this.controllerResponse(response, savedVersion);
        } catch (error) {
          if (!(error instanceof BattleVersionConflictError)) throw error;
          if (attempt + 1 < maxAttempts) continue;
          const current = await this.repository.load(battleId);
          return this.sessionError("VERSION_CONFLICT", current);
        }
      }
      throw new Error("unreachable battle mutation attempt");
    });
  }

  private async runExclusive<T>(
    battleId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // 同一进程内按 battleId 排队；跨进程并发由仓库的版本号 CAS 处理。
    const previous = this.queues.get(battleId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.queues.set(battleId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(battleId) === tail) this.queues.delete(battleId);
    }
  }

  private readResponse(record: BattleRecord): BattleSessionResponse {
    return {
      ok: true,
      version: record.version,
      state: structuredClone(record.state),
      events: [],
      value: undefined,
    };
  }

  private controllerResponse<T>(
    response: BattleResponse<T>,
    version: number,
  ): BattleSessionResponse<T> {
    return { ...response, version };
  }

  private sessionError(
    code: SessionErrorCode,
    record: BattleRecord | null,
    message: string = code,
  ): BattleSessionResponse<never> {
    return {
      ok: false,
      version: record?.version ?? null,
      state: record ? structuredClone(record.state) : null,
      events: [],
      error: { code, message },
    };
  }
}
