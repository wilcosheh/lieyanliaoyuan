import type {
  BattleEvent,
  BattleStatus,
  RoundStatus,
  StatusEffectState,
} from "../../engine/rules/state.ts";
import type {
  PhraseLengthTier,
  SkillEffect,
} from "../../engine/characters/skills.ts";

export type WebPlayerView = {
  playerId: string;
  nickname: string;
  characterId: string | null;
  characterName: string | null;
  ready: boolean;
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  alive: boolean;
  actionDisabled: boolean;
  statuses: StatusEffectState[];
};

export type WebSkillView = {
  id: string;
  name: string;
  phraseLengthTier: PhraseLengthTier;
  effects: SkillEffect[];
  used: number;
  remainingUses: number | null;
  available: boolean;
  unavailableReason: string | null;
};

export type WebBattleView = {
  battleId: string;
  version: number;
  status: BattleStatus;
  roundNo: number | null;
  roundStatus: RoundStatus | null;
  self: WebPlayerView;
  opponent: WebPlayerView;
  skills: WebSkillView[];
  events: BattleEvent[];
  latestSequence: number;
  winnerPlayerId: string | null;
};

export type WebCharacterView = {
  id: string;
  name: string;
  role: string;
  summary: string;
  accent: string;
  portrait: string;
  skills: Array<{
    id: string;
    name: string;
    phraseLengthTier: PhraseLengthTier;
    effects: SkillEffect[];
  }>;
};

export type MatchTicketView = {
  id: string;
  status: "WAITING" | "MATCHED" | "CANCELLED";
  battleId: string | null;
};

export type VoiceActionResult = {
  transcript: string;
  perfection: number;
  confidenceSource: "provider" | "fallback";
  battle: WebBattleView;
};
