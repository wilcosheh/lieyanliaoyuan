import type { ControllerOptions } from "./controller.ts";
import type { BattleState } from "./state.ts";

export type BattleRecord = {
  battleId: string;
  version: number;
  state: BattleState;
  controllerOptions: ControllerOptions;
};

export type NewBattleRecord = Omit<BattleRecord, "version">;

export interface BattleRepository {
  create(record: NewBattleRecord): Promise<BattleRecord>;
  load(battleId: string): Promise<BattleRecord | null>;
  save(
    battleId: string,
    expectedVersion: number,
    state: BattleState,
  ): Promise<number>;
}

export class BattleAlreadyExistsError extends Error {
  constructor(readonly battleId: string) {
    super(`battle already exists: ${battleId}`);
    this.name = "BattleAlreadyExistsError";
  }
}

export class BattleNotFoundError extends Error {
  constructor(readonly battleId: string) {
    super(`battle not found: ${battleId}`);
    this.name = "BattleNotFoundError";
  }
}

export class BattleVersionConflictError extends Error {
  constructor(
    readonly battleId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `battle version conflict: ${battleId}, expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "BattleVersionConflictError";
  }
}

/**
 * Process-local repository for tests and single-process development. Production
 * deployments must provide a shared database/Redis implementation with the same
 * atomic compare-and-swap contract.
 */
export class InMemoryBattleRepository implements BattleRepository {
  private readonly records = new Map<string, BattleRecord>();

  create(record: NewBattleRecord): Promise<BattleRecord> {
    if (this.records.has(record.battleId)) {
      throw new BattleAlreadyExistsError(record.battleId);
    }
    if (record.state.battleId !== record.battleId) {
      throw new Error("record battleId does not match state battleId");
    }
    const created = structuredClone({ ...record, version: 1 });
    this.records.set(record.battleId, created);
    return Promise.resolve(structuredClone(created));
  }

  load(battleId: string): Promise<BattleRecord | null> {
    const record = this.records.get(battleId);
    return Promise.resolve(record ? structuredClone(record) : null);
  }

  save(
    battleId: string,
    expectedVersion: number,
    state: BattleState,
  ): Promise<number> {
    const current = this.records.get(battleId);
    if (!current) throw new BattleNotFoundError(battleId);
    if (current.version !== expectedVersion) {
      throw new BattleVersionConflictError(
        battleId,
        expectedVersion,
        current.version,
      );
    }
    if (state.battleId !== battleId) {
      throw new Error("state battleId cannot change during save");
    }
    const saved = structuredClone({
      ...current,
      version: current.version + 1,
      state,
    });
    this.records.set(battleId, saved);
    return Promise.resolve(saved.version);
  }
}
