import {
  BattleController,
  type BattleResponse,
  type ControllerOptions,
  type RuleErrorCode,
} from "./controller.ts";
import {
  BattleAlreadyExistsError,
  type BattleRecord,
  type BattleRepository,
  BattleVersionConflictError,
} from "./repository.ts";
import type { BattleEvent, BattleState } from "./state.ts";

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

/** Request-facing application service. It is the only owner of controller lifetimes. */
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
    input: {
      playerId: string;
      commandId: string;
      roundNo: number;
      skillText: string;
    },
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
      const maxAttempts = options.retryOnConflict ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const record = await this.repository.load(battleId);
        if (!record) return this.sessionError("BATTLE_NOT_FOUND", null);
        if (
          options.expectedVersion !== undefined &&
          options.expectedVersion !== record.version
        ) {
          return this.sessionError("VERSION_CONFLICT", record);
        }

        const controller = BattleController.restore(
          record.state,
          record.controllerOptions,
        );
        const response = operation(controller);
        if (sameState(record.state, response.state)) {
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
