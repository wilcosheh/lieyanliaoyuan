import {
  type BattleEvent,
  type BattleState,
  BattleStateMachine,
  type PlayerBattleState,
  type StatusEffectState,
} from "./state.ts";
import {
  type CharacterConfig,
  CHARACTERS,
  type SkillConfig,
  type SkillEffect,
  validateCharacterConfig,
} from "./skills.ts";

export type RuleErrorCode =
  | "BATTLE_NOT_PREPARING"
  | "BATTLE_NOT_RUNNING"
  | "PLAYER_NOT_FOUND"
  | "CHARACTER_NOT_FOUND"
  | "PLAYER_NOT_READY"
  | "CHARACTER_NOT_SELECTED"
  | "PLAYERS_NOT_READY"
  | "ROUND_MISMATCH"
  | "ROUND_NOT_WAITING"
  | "ROUND_ALREADY_WON"
  | "ACTOR_DEAD"
  | "ACTION_DISABLED"
  | "INVALID_PERFECTION"
  | "ASR_FAILED"
  | "SKILL_NOT_FOUND"
  | "SKILL_EXHAUSTED"
  | "BASIC_CONSECUTIVE_REJECTED"
  | "REUSE_LIMIT_REJECTED"
  | "COMMAND_ALREADY_PROCESSED"
  | "BATTLE_ALREADY_FINISHED";

export type BattleError = {
  code: RuleErrorCode;
  message: string;
};

export type BattleResponse<T = void> =
  | {
    ok: true;
    state: BattleState;
    events: BattleEvent[];
    value: T | undefined;
  }
  | {
    ok: false;
    state: BattleState;
    events: BattleEvent[];
    error: BattleError;
  };

export type ControllerOptions = {
  maxHp?: number;
  maxShield?: number;
  characters?: CharacterConfig[];
};

export type SubmitActionInput = {
  playerId: string;
  commandId: string;
  roundNo: number;
  skillText: string;
  /** 技能完美程度百分比，范围为 0-100；省略时按 100 处理。 */
  perfection?: number;
};

type DamageContext = {
  sourcePlayerId: string;
  sourceSkillId: string;
  roundNo: number;
  perfection: number;
  isDot?: boolean;
};

const emptyValue = undefined;

export class BattleController {
  private machine: BattleStateMachine;
  private readonly characters: CharacterConfig[];

  constructor(
    battleId: string,
    playerIds: string[],
    options: ControllerOptions = {},
  ) {
    if (playerIds.length !== 2 || new Set(playerIds).size !== 2) {
      throw new Error("a battle requires exactly two unique players");
    }
    this.characters = structuredClone(options.characters ?? CHARACTERS);
    const configErrors = this.characters.flatMap(validateCharacterConfig);
    if (
      new Set(this.characters.map((character) => character.id)).size !==
        this.characters.length
    ) {
      configErrors.push("character ids must be unique");
    }
    if (configErrors.length > 0) {
      throw new Error(
        `invalid character configuration: ${configErrors.join("; ")}`,
      );
    }
    this.machine = BattleStateMachine.create(
      battleId,
      playerIds.map((playerId) => ({
        playerId,
        maxHp: options.maxHp,
        maxShield: options.maxShield,
      })),
      options,
    );
  }

  /** 从仓库保存的权威快照恢复控制器，恢复后仍只能通过控制器规则修改状态。 */
  static restore(
    snapshot: BattleState,
    options: ControllerOptions = {},
  ): BattleController {
    const controller = new BattleController(
      snapshot.battleId,
      snapshot.players.map((player) => player.playerId),
      options,
    );
    controller.machine = BattleStateMachine.restore(snapshot);
    return controller;
  }

  getState(): BattleState {
    return this.machine.snapshot();
  }

  getControllerOptions(): ControllerOptions {
    return { characters: structuredClone(this.characters) };
  }

  getPlayerState(playerId: string): PlayerBattleState | undefined {
    return this.machine.getPlayer(playerId);
  }

  private get state(): BattleState {
    return this.machine.snapshot();
  }

  preparePlayer(
    playerId: string,
    characterId: string,
  ): BattleResponse {
    const start = this.startEventIndex();
    if (this.state.status !== "PREPARING") {
      return this.reject(start, "BATTLE_NOT_PREPARING", playerId);
    }
    if (!this.machine.getPlayer(playerId)) {
      return this.reject(start, "PLAYER_NOT_FOUND", playerId);
    }
    if (!this.getCharacter(characterId)) {
      return this.reject(start, "CHARACTER_NOT_FOUND", playerId);
    }
    this.machine.updatePlayer(playerId, {
      characterId,
      ready: false,
    });
    this.emit("PLAYER_CHARACTER_SELECTED", playerId, null, null, {
      characterId,
    });
    return this.success(start);
  }

  setReady(playerId: string, ready = true): BattleResponse {
    const start = this.startEventIndex();
    if (this.state.status !== "PREPARING") {
      return this.reject(start, "BATTLE_NOT_PREPARING", playerId);
    }
    const player = this.machine.getPlayer(playerId);
    if (!player) return this.reject(start, "PLAYER_NOT_FOUND", playerId);
    if (!player.characterId) {
      return this.reject(start, "CHARACTER_NOT_SELECTED", playerId);
    }
    this.machine.updatePlayer(playerId, { ready });
    this.emit("PLAYER_READY_CHANGED", playerId, null, null, { ready });
    return this.success(start);
  }

  startBattle(): BattleResponse {
    const start = this.startEventIndex();
    if (this.state.status !== "PREPARING") {
      return this.reject(start, "BATTLE_NOT_PREPARING");
    }
    if (this.state.players.some((player) => !player.characterId)) {
      return this.reject(start, "CHARACTER_NOT_SELECTED");
    }
    if (this.state.players.some((player) => !player.ready)) {
      return this.reject(start, "PLAYERS_NOT_READY");
    }
    this.machine.setBattleStatus("RUNNING");
    this.emit("BATTLE_STARTED");
    this.openRound(1);
    return this.success(start);
  }

  submitAction(input: SubmitActionInput): BattleResponse {
    const perfection: unknown = input.perfection === undefined
      ? 100
      : input.perfection;
    const signature = JSON.stringify([
      input.playerId,
      input.roundNo,
      input.skillText,
      String(perfection),
    ]);
    const previous = this.machine.getProcessedCommand(input.commandId);
    if (previous) {
      if (previous.signature === signature) {
        if (previous.ok) return this.success(this.startEventIndex());
        const code = (previous.errorCode ??
          "COMMAND_ALREADY_PROCESSED") as RuleErrorCode;
        return {
          ok: false,
          state: this.getState(),
          events: [],
          error: { code, message: code },
        };
      }
      return this.reject(
        this.startEventIndex(),
        "COMMAND_ALREADY_PROCESSED",
        input.playerId,
      );
    }

    const start = this.startEventIndex();
    if (
      typeof perfection !== "number" || !Number.isFinite(perfection) ||
      perfection < 0 || perfection > 100
    ) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, "INVALID_PERFECTION", input.playerId),
      );
    }
    if (this.state.status !== "RUNNING") {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(
          start,
          this.state.status === "FINISHED"
            ? "BATTLE_ALREADY_FINISHED"
            : "BATTLE_NOT_RUNNING",
          input.playerId,
        ),
      );
    }
    const round = this.state.currentRound;
    if (!round || input.roundNo !== round.roundNo) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(
          start,
          round && input.roundNo < round.roundNo
            ? "ROUND_ALREADY_WON"
            : "ROUND_MISMATCH",
          input.playerId,
        ),
      );
    }
    if (round.status !== "WAITING_COMMAND") {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(
          start,
          round.winnerPlayerId ? "ROUND_ALREADY_WON" : "ROUND_NOT_WAITING",
          input.playerId,
        ),
      );
    }
    const actor = this.machine.getPlayer(input.playerId);
    if (!actor) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, "PLAYER_NOT_FOUND", input.playerId),
      );
    }
    if (!actor.alive) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, "ACTOR_DEAD", input.playerId),
      );
    }
    if (actor.actionState === "ACTION_DISABLED") {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, "ACTION_DISABLED", input.playerId),
      );
    }
    const skill = this.findSkillByText(actor, input.skillText);
    if (!skill) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, "ASR_FAILED", input.playerId),
      );
    }
    const usability = this.skillUsability(actor, skill, round.roundNo);
    if (!usability.ok) {
      return this.storeCommand(
        input.commandId,
        signature,
        this.reject(start, usability.code, input.playerId, skill.id),
      );
    }

    // 只有控制层可以锁定本回合行动者，外部请求不能直接指定回合胜者。
    this.machine.setCurrentRound({
      ...round,
      status: "SETTLING",
      winnerPlayerId: input.playerId,
      commandId: input.commandId,
      skillId: skill.id,
      perfection,
    });
    this.emit("ACTION_ACCEPTED", input.playerId, null, skill.id, {
      roundNo: round.roundNo,
      perfection,
    });
    this.machine.incrementSkillUse(
      input.playerId,
      skill.id,
      round.roundNo,
    );
    this.machine.recordProcessedCommand({
      commandId: input.commandId,
      signature,
      ok: true,
      errorCode: null,
    });
    return this.success(start);
  }

  advance(): BattleResponse {
    const start = this.startEventIndex();
    if (this.state.status !== "RUNNING") {
      return this.reject(
        start,
        this.state.status === "FINISHED"
          ? "BATTLE_ALREADY_FINISHED"
          : "BATTLE_NOT_RUNNING",
      );
    }
    const round = this.state.currentRound;
    if (!round) return this.reject(start, "ROUND_NOT_WAITING");
    if (round.status === "SETTLING") {
      const actor = round.winnerPlayerId
        ? this.machine.getPlayer(round.winnerPlayerId)
        : undefined;
      const skill = actor?.characterId && round.skillId
        ? this.getCharacter(actor.characterId)?.skills.find((candidate) =>
          candidate.id === round.skillId
        )
        : undefined;
      if (!actor || !skill) return this.reject(start, "SKILL_NOT_FOUND");
      this.resolveBattlePhase(
        actor.playerId,
        skill,
        round.roundNo,
        round.perfection ?? 100,
      );
      return this.success(start);
    }
    if (round.status === "ENDING") {
      this.resolveEndRound(round.roundNo, round.winnerPlayerId, round.skillId);
      return this.success(start);
    }
    return this.reject(start, "ROUND_NOT_WAITING");
  }

  archiveBattle(): BattleResponse {
    const start = this.startEventIndex();
    if (this.state.status !== "FINISHED") {
      return this.reject(start, "BATTLE_NOT_RUNNING");
    }
    this.machine.setBattleStatus("ARCHIVED");
    this.emit("BATTLE_ARCHIVED");
    return this.success(start);
  }

  private resolveBattlePhase(
    playerId: string,
    skill: SkillConfig,
    roundNo: number,
    perfection: number,
  ): void {
    const target = this.machine.getOpponent(playerId);
    if (!target) return;
    const before = this.combatSnapshot();
    this.applySkillEffects(
      playerId,
      target.playerId,
      skill,
      roundNo,
      perfection,
    );
    this.emit("BATTLE_RESULT", playerId, target.playerId, skill.id, {
      perfection,
      before,
      after: this.combatSnapshot(),
    });

    if (!this.allAlive()) {
      this.finishBattle(playerId, roundNo, "ACTION_DAMAGE");
      return;
    }
    this.machine.setCurrentRound({
      ...this.state.currentRound!,
      status: "ENDING",
    });
    this.emit("ROUND_ENDING", playerId, target.playerId, skill.id);
  }

  private resolveEndRound(
    roundNo: number,
    actorId: string | null,
    skillId: string | null,
  ): void {
    this.processPeriodicEffects(roundNo);
    this.refreshActionStates(roundNo);
    if (!this.allAlive()) {
      const alive = this.state.players.filter((player) => player.alive);
      const winner = alive.length === 1 ? alive[0] : undefined;
      const loser = winner
        ? this.state.players.find((player) => !player.alive)
        : undefined;
      this.finishBattle(
        winner?.playerId ?? null,
        roundNo,
        "END_ROUND_EFFECT",
        loser?.playerId,
      );
      return;
    }
    this.machine.setCurrentRound({
      ...this.state.currentRound!,
      status: "FINISHED",
    });
    this.emit("ROUND_FINISHED", actorId, null, skillId);
    this.openRound(roundNo + 1);
  }

  private openRound(roundNo: number): void {
    this.machine.setCurrentRound({
      roundNo,
      status: "WAITING_COMMAND",
      winnerPlayerId: null,
      commandId: null,
      skillId: null,
      perfection: 100,
    });
    this.refreshActionStates(roundNo);
    this.emit("ROUND_STARTED", null, null, null, { roundNo });
    if (
      this.state.players.every((player) =>
        player.actionState === "ACTION_DISABLED"
      )
    ) {
      this.machine.setCurrentRound({
        ...this.state.currentRound!,
        status: "ENDING",
      });
      this.emit("ROUND_SKIPPED", null, null, null, {
        reason: "ALL_PLAYERS_ACTION_DISABLED",
      });
    }
  }

  private applySkillEffects(
    actorId: string,
    targetId: string,
    skill: SkillConfig,
    roundNo: number,
    perfection: number,
  ): void {
    skill.effects.forEach((effect, index) => {
      const context: DamageContext = {
        sourcePlayerId: actorId,
        sourceSkillId: skill.id,
        roundNo,
        perfection,
      };
      switch (effect.type) {
        case "DAMAGE":
          this.applyDamage(targetId, effect.amount, context);
          this.consumeTriggers(actorId, ["DAMAGE_BOOST", "NEXT_EFFECT_BOOST"]);
          break;
        case "HEAL":
          this.applyHeal(actorId, effect.amount);
          this.consumeTriggers(actorId, ["HEAL_BOOST", "NEXT_EFFECT_BOOST"]);
          break;
        case "SHIELD":
          this.applyShield(actorId, effect.amount);
          this.consumeTriggers(actorId, ["SHIELD_BOOST", "NEXT_EFFECT_BOOST"]);
          break;
        case "SELF_BUFF":
          this.addConfiguredStatusWithNextEffect(
            actorId,
            actorId,
            effect,
            context,
            index,
          );
          break;
        case "OPPONENT_DEBUFF":
          this.addConfiguredStatusWithNextEffect(
            actorId,
            targetId,
            effect,
            context,
            index,
          );
          break;
        case "BREAK_SHIELD":
          if (effect.amount === null) {
            this.breakShield(targetId, null, skill.id);
          } else {
            const boost = this.statusValue(
              this.machine.getPlayer(actorId),
              "NEXT_EFFECT_BOOST",
            );
            this.breakShield(
              targetId,
              Math.round(effect.amount * (1 + boost / 100)),
              skill.id,
            );
            this.consumeTriggers(actorId, ["NEXT_EFFECT_BOOST"]);
          }
          break;
        case "REMOVE_OPPONENT_BUFF":
          this.removeStatuses(
            targetId,
            (status) =>
              status.kind === "BUFF" &&
              status.dispellable &&
              (!effect.tag || status.tag === effect.tag),
          );
          break;
        case "CLEANSE_SELF_DEBUFF":
          this.removeStatuses(
            actorId,
            (status) =>
              (status.kind === "DEBUFF" || status.kind === "DOT") &&
              status.dispellable &&
              (!effect.tag || status.tag === effect.tag),
          );
          break;
        case "ACTION_RESTRICTION":
          this.addConfiguredStatus(targetId, effect, context, index);
          break;
      }
    });
  }

  private addConfiguredStatus(
    targetId: string,
    effect: Extract<SkillEffect, {
      type: "SELF_BUFF" | "OPPONENT_DEBUFF" | "ACTION_RESTRICTION";
    }>,
    context: DamageContext,
    effectIndex: number,
    valueOverride?: number,
  ): void {
    const kind = effect.type === "ACTION_RESTRICTION"
      ? "ACTION_RESTRICTION"
      : effect.type === "OPPONENT_DEBUFF" && effect.tag === "DOT"
      ? "DOT"
      : effect.type === "OPPONENT_DEBUFF"
      ? "DEBUFF"
      : "BUFF";
    const tag = effect.type === "ACTION_RESTRICTION"
      ? "ACTION_RESTRICTION"
      : effect.tag;
    const value = effect.type === "ACTION_RESTRICTION"
      ? 1
      : valueOverride ?? effect.value;
    const remainingRounds = effect.durationRounds;
    const remainingTriggers = effect.type === "ACTION_RESTRICTION"
      ? null
      : effect.triggerCount ?? null;
    const status: StatusEffectState = {
      id:
        `${context.roundNo}:${context.sourceSkillId}:${effectIndex}:${targetId}`,
      kind,
      tag,
      value,
      remainingRounds,
      remainingTriggers,
      stacks: 1,
      sourcePlayerId: context.sourcePlayerId,
      sourceSkillId: context.sourceSkillId,
      sourcePerfection: context.perfection,
      appliedRound: context.roundNo,
      dispellable: effect.type === "ACTION_RESTRICTION"
        ? true
        : effect.dispellable ?? true,
    };
    this.removeStatuses(
      targetId,
      (existing) => existing.kind === kind && existing.tag === tag,
    );
    this.machine.addStatusEffect(targetId, status);
    this.emit(
      "STATUS_APPLIED",
      context.sourcePlayerId,
      targetId,
      context.sourceSkillId,
      {
        status,
      },
    );
  }

  private addConfiguredStatusWithNextEffect(
    actorId: string,
    targetId: string,
    effect: Extract<SkillEffect, {
      type: "SELF_BUFF" | "OPPONENT_DEBUFF";
    }>,
    context: DamageContext,
    effectIndex: number,
  ): void {
    const boost = this.statusValue(
      this.machine.getPlayer(actorId),
      "NEXT_EFFECT_BOOST",
    );
    const value = Math.round(effect.value * (1 + boost / 100));
    this.consumeTriggers(actorId, ["NEXT_EFFECT_BOOST"]);
    this.addConfiguredStatus(targetId, effect, context, effectIndex, value);
  }

  private processPeriodicEffects(roundNo: number): void {
    for (const player of [...this.state.players]) {
      for (const status of [...player.statusEffects]) {
        if (status.appliedRound >= roundNo || status.remainingRounds <= 0) {
          continue;
        }
        if (status.kind === "DOT") {
          const amount = this.applyDamage(player.playerId, status.value, {
            sourcePlayerId: status.sourcePlayerId,
            sourceSkillId: status.sourceSkillId,
            roundNo,
            perfection: status.sourcePerfection ?? 100,
            isDot: true,
          });
          this.consumeTriggers(status.sourcePlayerId, ["DOT_BOOST"]);
          this.emit(
            "STATUS_TICK",
            status.sourcePlayerId,
            player.playerId,
            status.sourceSkillId,
            {
              statusId: status.id,
              tag: status.tag,
              rawValue: status.value,
              perfection: status.sourcePerfection ?? 100,
              value: amount,
            },
          );
        } else if (status.kind === "BUFF" && status.tag === "HEAL_OVER_TIME") {
          this.applyHeal(player.playerId, status.value);
          this.emit(
            "STATUS_TICK",
            status.sourcePlayerId,
            player.playerId,
            status.sourceSkillId,
            {
              statusId: status.id,
              tag: status.tag,
              value: status.value,
            },
          );
        }
        const updated = this.machine.getPlayer(player.playerId);
        if (!updated) continue;
        const current = updated.statusEffects.find((effect) =>
          effect.id === status.id
        );
        if (!current) continue;
        const remainingTriggers = current.remainingTriggers === null
          ? null
          : Math.max(0, current.remainingTriggers);
        const nextRounds = Math.max(0, current.remainingRounds - 1);
        if (nextRounds === 0 || remainingTriggers === 0) {
          this.removeStatuses(
            player.playerId,
            (effect) => effect.id === status.id,
          );
          this.emit(
            "STATUS_EXPIRED",
            status.sourcePlayerId,
            player.playerId,
            status.sourceSkillId,
            {
              statusId: status.id,
              tag: status.tag,
            },
          );
        } else {
          this.machine.updatePlayer(player.playerId, {
            statusEffects: updated.statusEffects.map((effect) =>
              effect.id === status.id
                ? { ...effect, remainingRounds: nextRounds }
                : effect
            ),
          });
        }
      }
    }
  }

  private refreshActionStates(roundNo: number): void {
    for (const player of this.state.players) {
      const disabled = player.statusEffects.some((effect) =>
        effect.kind === "ACTION_RESTRICTION" &&
        effect.appliedRound < roundNo &&
        effect.remainingRounds > 0
      );
      this.machine.updatePlayer(player.playerId, {
        actionState: disabled ? "ACTION_DISABLED" : "READY",
      });
    }
  }

  private applyDamage(
    playerId: string,
    rawAmount: number,
    context: DamageContext,
  ): number {
    const target = this.machine.getPlayer(playerId);
    const source = this.machine.getPlayer(context.sourcePlayerId);
    if (!target || !target.alive) return 0;
    const sourceBoost = this.statusValue(source, "DAMAGE_BOOST") +
      this.statusValue(source, "NEXT_EFFECT_BOOST") +
      (context.isDot ? this.statusValue(source, "DOT_BOOST") : 0);
    const sourcePenalty = this.statusValue(source, "DAMAGE_DEALT_DOWN");
    const targetReduction = this.statusValue(target, "DAMAGE_REDUCTION");
    const targetTakenUp = this.statusValue(target, "DAMAGE_TAKEN_UP");
    const perfection = Math.min(100, Math.max(0, context.perfection));
    const amount = Math.max(
      0,
      Math.round(
        rawAmount * (perfection / 100) * (1 + sourceBoost / 100) *
          (1 - sourcePenalty / 100) *
          (1 - targetReduction / 100) * (1 + targetTakenUp / 100),
      ),
    );
    const absorbed = Math.min(target.shield, amount);
    const hpDamage = amount - absorbed;
    const hp = Math.max(0, target.hp - hpDamage);
    this.machine.updatePlayer(playerId, {
      shield: target.shield - absorbed,
      hp,
      alive: hp > 0,
    });
    this.emit(
      "DAMAGE_APPLIED",
      context.sourcePlayerId,
      playerId,
      context.sourceSkillId,
      {
        rawAmount,
        perfection,
        amount,
        absorbed,
        hpDamage,
        roundNo: context.roundNo,
      },
    );
    return amount;
  }

  private applyHeal(playerId: string, rawAmount: number): number {
    const player = this.machine.getPlayer(playerId);
    if (!player || !player.alive) return 0;
    const amount = Math.max(
      0,
      Math.round(
        rawAmount * (1 + this.statusValue(player, "HEAL_BOOST") / 100),
      ),
    );
    const actual = Math.min(amount, player.maxHp - player.hp);
    this.machine.updatePlayer(playerId, { hp: player.hp + actual });
    this.emit("HEAL_APPLIED", playerId, playerId, null, { amount: actual });
    return actual;
  }

  private applyShield(playerId: string, rawAmount: number): number {
    const player = this.machine.getPlayer(playerId);
    if (!player || !player.alive) return 0;
    const amount = Math.max(
      0,
      Math.round(
        rawAmount * (1 + this.statusValue(player, "SHIELD_BOOST") / 100),
      ),
    );
    const actual = Math.min(amount, player.maxShield - player.shield);
    this.machine.updatePlayer(playerId, {
      shield: player.shield + actual,
    });
    this.emit("SHIELD_APPLIED", playerId, playerId, null, { amount: actual });
    return actual;
  }

  private breakShield(
    playerId: string,
    amount: number | null,
    skillId: string,
  ): void {
    const target = this.machine.getPlayer(playerId);
    if (!target) return;
    const removed = amount === null
      ? target.shield
      : Math.min(target.shield, amount);
    this.machine.updatePlayer(playerId, {
      shield: target.shield - removed,
    });
    this.emit("SHIELD_BROKEN", null, playerId, skillId, { amount: removed });
  }

  private removeStatuses(
    playerId: string,
    predicate: (effect: StatusEffectState) => boolean,
  ): void {
    const before = this.machine.getPlayer(playerId)?.statusEffects.length ?? 0;
    this.machine.removeStatusEffects(playerId, predicate);
    const after = this.machine.getPlayer(playerId)?.statusEffects.length ??
      before;
    if (after < before) {
      this.emit("STATUS_REMOVED", null, playerId, null, {
        count: before - after,
      });
    }
  }

  private consumeTriggers(playerId: string, tags: string[]): void {
    const player = this.machine.getPlayer(playerId);
    if (!player) return;
    const next = player.statusEffects.flatMap((effect) => {
      if (!tags.includes(effect.tag) || effect.remainingTriggers === null) {
        return [effect];
      }
      const remaining = effect.remainingTriggers - 1;
      if (remaining <= 0) return [];
      return [{ ...effect, remainingTriggers: remaining }];
    });
    this.machine.updatePlayer(playerId, { statusEffects: next });
  }

  private statusValue(
    player: PlayerBattleState | undefined,
    tag: string,
  ): number {
    return player?.statusEffects
      .filter((effect) => effect.tag === tag && effect.remainingRounds > 0)
      .reduce((sum, effect) => sum + effect.value, 0) ?? 0;
  }

  private skillUsability(
    player: PlayerBattleState,
    skill: SkillConfig,
    roundNo: number,
  ): { ok: true } | { ok: false; code: RuleErrorCode } {
    const usage = player.skillUsage[skill.id] ?? 0;
    const lastRound = player.skillLastUsedRound[skill.id];
    if (skill.reuseRule === "ONCE_PER_MATCH") {
      return usage === 0
        ? { ok: true }
        : { ok: false, code: "SKILL_EXHAUSTED" };
    }
    if (skill.reuseRule === "BASIC_NON_CONSECUTIVE") {
      return lastRound === undefined || roundNo - lastRound >= 2
        ? { ok: true }
        : { ok: false, code: "BASIC_CONSECUTIVE_REJECTED" };
    }
    const usable = usage < (skill.maxUsesPerMatch ?? 0) &&
      (lastRound === undefined || roundNo - lastRound >= skill.minRoundGap);
    return usable ? { ok: true } : { ok: false, code: "REUSE_LIMIT_REJECTED" };
  }

  private findSkillByText(
    player: PlayerBattleState,
    skillText: string,
  ): SkillConfig | undefined {
    if (!player.characterId) return undefined;
    const character = this.getCharacter(player.characterId);
    if (!character) return undefined;
    return character.skills.find((skill) => skill.name === skillText);
  }

  private getCharacter(characterId: string): CharacterConfig | undefined {
    return this.characters.find((character) => character.id === characterId);
  }

  private finishBattle(
    winnerPlayerId: string | null,
    roundNo: number,
    reason: string,
    loserPlayerId?: string,
  ): void {
    const loser = winnerPlayerId === null ? null : loserPlayerId ??
      this.state.players.find((player) => player.playerId !== winnerPlayerId)
        ?.playerId ??
      null;
    this.machine.setCurrentRound({
      ...this.state.currentRound!,
      status: "FINISHED",
    });
    this.machine.setWinner(winnerPlayerId, loser);
    this.machine.setBattleStatus("FINISHED");
    this.emit("BATTLE_FINISHED", winnerPlayerId, loser, null, {
      reason,
      roundNo,
    });
  }

  private allAlive(): boolean {
    return this.state.players.every((player) => player.alive);
  }

  private combatSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.state.players.map((player) => [
      player.playerId,
      {
        hp: player.hp,
        shield: player.shield,
        alive: player.alive,
        actionState: player.actionState,
      },
    ]));
  }

  private emit(
    type: string,
    playerId: string | null = null,
    targetPlayerId: string | null = null,
    skillId: string | null = null,
    payload: Record<string, unknown> = {},
  ): void {
    this.machine.appendEvent({
      type,
      roundNo: this.state.currentRound?.roundNo ?? null,
      playerId,
      targetPlayerId,
      skillId,
      payload,
    });
  }

  private startEventIndex(): number {
    return this.machine.getEventCount();
  }

  private success(start: number): BattleResponse {
    return {
      ok: true,
      state: this.getState(),
      events: this.machine.getEventsSince(start),
      value: emptyValue,
    };
  }

  private reject(
    start: number,
    code: RuleErrorCode,
    playerId: string | null = null,
    skillId: string | null = null,
  ): BattleResponse {
    this.emit("COMMAND_REJECTED", playerId, null, skillId, { code });
    return {
      ok: false,
      state: this.getState(),
      events: this.machine.getEventsSince(start),
      error: { code, message: code },
    };
  }

  private storeCommand(
    commandId: string,
    signature: string,
    response: BattleResponse,
  ): BattleResponse {
    this.machine.recordProcessedCommand({
      commandId,
      signature,
      ok: response.ok,
      errorCode: response.ok ? null : response.error.code,
    });
    response.state = this.getState();
    return response;
  }
}
