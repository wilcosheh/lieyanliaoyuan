export type BattleStatus =
  | "PREPARING"
  | "RUNNING"
  | "FINISHED"
  | "ARCHIVED";

export type RoundStatus =
  | "WAITING_COMMAND"
  | "SETTLING"
  | "ENDING"
  | "FINISHED";

export type ActionState = "READY" | "ACTION_DISABLED";

export type StatusEffectKind =
  | "BUFF"
  | "DEBUFF"
  | "DOT"
  | "ACTION_RESTRICTION";

export type StatusEffectState = {
  id: string;
  kind: StatusEffectKind;
  tag: string;
  value: number;
  remainingRounds: number;
  remainingTriggers: number | null;
  stacks: number;
  sourcePlayerId: string;
  sourceSkillId: string;
  appliedRound: number;
  dispellable: boolean;
};

export type PlayerBattleState = {
  playerId: string;
  characterId: string | null;
  ready: boolean;
  maxHp: number;
  hp: number;
  maxShield: number;
  shield: number;
  alive: boolean;
  actionState: ActionState;
  skillUsage: Record<string, number>;
  skillLastUsedRound: Record<string, number>;
  statusEffects: StatusEffectState[];
};

export type RoundState = {
  roundNo: number;
  status: RoundStatus;
  winnerPlayerId: string | null;
  commandId: string | null;
  skillId: string | null;
};

export type BattleEvent = {
  sequence: number;
  type: string;
  roundNo: number | null;
  playerId: string | null;
  targetPlayerId: string | null;
  skillId: string | null;
  payload: Record<string, unknown>;
};

export type ProcessedCommandState = {
  commandId: string;
  signature: string;
  ok: boolean;
  errorCode: string | null;
};

export type BattleState = {
  battleId: string;
  status: BattleStatus;
  players: PlayerBattleState[];
  currentRound: RoundState | null;
  winnerPlayerId: string | null;
  loserPlayerId: string | null;
  settlementSequence: number;
  events: BattleEvent[];
  processedCommands: Record<string, ProcessedCommandState>;
};

export type InitialPlayer = {
  playerId: string;
  maxHp?: number;
  maxShield?: number;
};

/**
 * Owns all mutable battle state. Methods intentionally perform no rule checks;
 * the controller decides whether each mutation is legal.
 */
export class BattleStateMachine {
  private state: BattleState;

  private constructor(state: BattleState) {
    this.state = structuredClone(state);
  }

  static create(
    battleId: string,
    players: InitialPlayer[],
    defaults: { maxHp?: number; maxShield?: number } = {},
  ): BattleStateMachine {
    const maxHp = defaults.maxHp ?? 1000;
    const maxShield = defaults.maxShield ?? 500;
    return new BattleStateMachine({
      battleId,
      status: "PREPARING",
      players: players.map((player) => ({
        playerId: player.playerId,
        characterId: null,
        ready: false,
        maxHp: player.maxHp ?? maxHp,
        hp: player.maxHp ?? maxHp,
        maxShield: player.maxShield ?? maxShield,
        shield: 0,
        alive: true,
        actionState: "READY",
        skillUsage: {},
        skillLastUsedRound: {},
        statusEffects: [],
      })),
      currentRound: null,
      winnerPlayerId: null,
      loserPlayerId: null,
      settlementSequence: 0,
      events: [],
      processedCommands: {},
    });
  }

  static restore(snapshot: BattleState): BattleStateMachine {
    return new BattleStateMachine({
      ...snapshot,
      processedCommands: snapshot.processedCommands ?? {},
    });
  }

  snapshot(): BattleState {
    return structuredClone(this.state);
  }

  getPlayer(playerId: string): PlayerBattleState | undefined {
    const player = this.state.players.find((item) =>
      item.playerId === playerId
    );
    return player ? structuredClone(player) : undefined;
  }

  getOpponent(playerId: string): PlayerBattleState | undefined {
    const player = this.state.players.find((item) =>
      item.playerId !== playerId
    );
    return player ? structuredClone(player) : undefined;
  }

  getCurrentRound(): RoundState | null {
    return this.state.currentRound
      ? structuredClone(this.state.currentRound)
      : null;
  }

  getPlayers(): PlayerBattleState[] {
    return structuredClone(this.state.players);
  }

  getEventCount(): number {
    return this.state.events.length;
  }

  getEventsSince(index: number): BattleEvent[] {
    return structuredClone(this.state.events.slice(index));
  }

  getProcessedCommand(commandId: string): ProcessedCommandState | undefined {
    const command = this.state.processedCommands[commandId];
    return command ? structuredClone(command) : undefined;
  }

  setBattleStatus(status: BattleStatus): void {
    this.state.status = status;
  }

  setWinner(
    winnerPlayerId: string | null,
    loserPlayerId: string | null,
  ): void {
    this.state.winnerPlayerId = winnerPlayerId;
    this.state.loserPlayerId = loserPlayerId;
  }

  setCurrentRound(currentRound: RoundState | null): void {
    this.state.currentRound = currentRound
      ? structuredClone(currentRound)
      : null;
  }

  updatePlayer(
    playerId: string,
    patch: Partial<PlayerBattleState>,
  ): void {
    const index = this.state.players.findIndex((player) =>
      player.playerId === playerId
    );
    if (index < 0) return;
    this.state.players[index] = {
      ...this.state.players[index]!,
      ...structuredClone(patch),
    };
  }

  addStatusEffect(playerId: string, effect: StatusEffectState): void {
    const player = this.getPlayer(playerId);
    if (!player) return;
    this.updatePlayer(playerId, {
      statusEffects: [...player.statusEffects, structuredClone(effect)],
    });
  }

  removeStatusEffects(
    playerId: string,
    predicate: (effect: StatusEffectState) => boolean,
  ): void {
    const player = this.getPlayer(playerId);
    if (!player) return;
    this.updatePlayer(playerId, {
      statusEffects: player.statusEffects.filter((effect) =>
        !predicate(structuredClone(effect))
      ),
    });
  }

  incrementSkillUse(
    playerId: string,
    skillId: string,
    roundNo: number,
  ): void {
    const player = this.getPlayer(playerId);
    if (!player) return;
    this.updatePlayer(playerId, {
      skillUsage: {
        ...player.skillUsage,
        [skillId]: (player.skillUsage[skillId] ?? 0) + 1,
      },
      skillLastUsedRound: {
        ...player.skillLastUsedRound,
        [skillId]: roundNo,
      },
    });
  }

  appendEvent(event: Omit<BattleEvent, "sequence">): BattleEvent {
    const sequence = this.state.settlementSequence + 1;
    const stored = structuredClone({ ...event, sequence });
    this.state.settlementSequence = sequence;
    this.state.events.push(stored);
    return structuredClone(stored);
  }

  recordProcessedCommand(command: ProcessedCommandState): void {
    this.state.processedCommands[command.commandId] = structuredClone(command);
  }
}
