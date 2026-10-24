import {
  BattleAlreadyExistsError,
  BattleNotFoundError,
  type BattleRecord,
  type BattleRepository,
  BattleVersionConflictError,
  type NewBattleRecord,
} from "./repository.ts";

type BattleRow = {
  battle_id: string;
  version: number;
  state: BattleRecord["state"];
  controller_options: BattleRecord["controllerOptions"];
};

export class SupabaseBattleRepository implements BattleRepository {
  private readonly url: string;

  constructor(
    url: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async create(record: NewBattleRecord): Promise<BattleRecord> {
    if (record.state.battleId !== record.battleId) {
      throw new Error("record battleId does not match state battleId");
    }
    const created = await this.rpc<boolean>("ly_battle_create", {
      p_battle_id: record.battleId,
      p_state: record.state,
      p_controller_options: record.controllerOptions,
    });
    if (!created) throw new BattleAlreadyExistsError(record.battleId);
    const saved = await this.load(record.battleId);
    if (!saved) throw new BattleNotFoundError(record.battleId);
    return saved;
  }

  async load(battleId: string): Promise<BattleRecord | null> {
    const rows = await this.rest<BattleRow[]>(
      `ly_battle?battle_id=eq.${encodeURIComponent(battleId)}` +
        "&select=battle_id,version,state,controller_options",
    );
    const row = rows[0];
    if (!row) return null;
    return {
      battleId: row.battle_id,
      version: Number(row.version),
      state: structuredClone(row.state),
      controllerOptions: structuredClone(row.controller_options ?? {}),
    };
  }

  async save(
    battleId: string,
    expectedVersion: number,
    state: BattleRecord["state"],
  ): Promise<number> {
    if (state.battleId !== battleId) {
      throw new Error("state battleId cannot change during save");
    }
    const savedVersion = await this.rpc<number | null>("ly_battle_save", {
      p_battle_id: battleId,
      p_expected_version: expectedVersion,
      p_state: state,
    });
    if (savedVersion === null) {
      const current = await this.load(battleId);
      if (!current) throw new BattleNotFoundError(battleId);
      throw new BattleVersionConflictError(
        battleId,
        expectedVersion,
        current.version,
      );
    }
    return Number(savedVersion);
  }

  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.request(`${this.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(args),
    });
    return await this.parse<T>(response, name);
  }

  private async rest<T>(path: string): Promise<T> {
    const response = await this.request(`${this.url}/rest/v1/${path}`, {
      headers: this.headers(),
    });
    return await this.parse<T>(response, path);
  }

  private async parse<T>(response: Response, operation: string): Promise<T> {
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${operation} ${response.status} ${body}`);
    }
    return (body ? JSON.parse(body) : undefined) as T;
  }

  private headers(): HeadersInit {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }
}
