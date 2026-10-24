export {
  BattleController,
  type BattleError,
  type BattleResponse,
  type ControllerOptions,
  type RuleErrorCode,
} from "./controller.ts";
export {
  BattleAlreadyExistsError,
  BattleNotFoundError,
  type BattleRecord,
  type BattleRepository,
  BattleVersionConflictError,
  InMemoryBattleRepository,
  type NewBattleRecord,
} from "./repository.ts";
export { SupabaseBattleRepository } from "./supabase_repository.ts";
export {
  type BattleSessionResponse,
  BattleSessionService,
  type MutationGuard,
  type SessionError,
  type SessionErrorCode,
} from "./session.ts";
export {
  type CharacterConfig,
  CHARACTERS,
  type PhraseLengthTier,
  type ReuseRule,
  type SkillConfig,
  type SkillEffect,
  type SkillSlot,
  validateCharacterConfig,
} from "./skills.ts";
export type {
  ActionState,
  BattleEvent,
  BattleState,
  BattleStatus,
  PlayerBattleState,
  ProcessedCommandState,
  RoundState,
  RoundStatus,
  StatusEffectState,
} from "./state.ts";
