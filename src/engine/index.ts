export {
  BattleController,
  type BattleError,
  type BattleResponse,
  type ControllerOptions,
  type RuleErrorCode,
  type SubmitActionInput,
} from "./rules/controller.ts";
export {
  BattleAlreadyExistsError,
  BattleNotFoundError,
  type BattleRecord,
  type BattleRepository,
  BattleVersionConflictError,
  InMemoryBattleRepository,
  type NewBattleRecord,
} from "./store/repository.ts";
export { SupabaseBattleRepository } from "./store/supabase_repository.ts";
export {
  type BattleSessionResponse,
  BattleSessionService,
  type MutationGuard,
  type SessionError,
  type SessionErrorCode,
} from "./service/session.ts";
export {
  type CharacterConfig,
  CHARACTERS,
  type PhraseLengthTier,
  type ReuseRule,
  type SkillConfig,
  type SkillEffect,
  type SkillSlot,
  validateCharacterConfig,
} from "./characters/skills.ts";
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
} from "./rules/state.ts";
