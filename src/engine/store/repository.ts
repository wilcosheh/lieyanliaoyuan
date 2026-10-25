import type { ControllerOptions } from "../rules/controller.ts";
import type { BattleState } from "../rules/state.ts";

export type BattleRecord = {
  battleId: string;
  version: number;
  state: BattleState;
  controllerOptions: ControllerOptions;
};

export type NewBattleRecord = Omit<BattleRecord, "version">;

/**
 * 对局权威状态仓库。save 必须以原子方式比较 expectedVersion，比较成功后才能写入。
 */
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
 * 仅用于测试和单进程开发的内存仓库。
 * 生产环境必须使用所有服务实例共享的数据库或 Redis 实现，并保持相同的原子 CAS 契约。
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

  dump(): BattleRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  restore(records: BattleRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.battleId, structuredClone(record));
    }
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
