"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Heart,
  History,
  Laptop,
  Mic,
  Shield,
  Sparkles,
  Swords,
  Volume2,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BattleEvent } from "@core/battle/state.ts";
import type { SkillEffect } from "@core/battle/skills.ts";
import type {
  WebBattleView,
  WebPlayerView,
  WebSkillView,
} from "@core/web/dto.ts";
import { webApi } from "@web/api/client";
import { useBrowserSpeechRecognition } from "@web/audio/use-browser-speech-recognition";
import { useVoiceRecorder } from "@web/audio/use-voice-recorder";

type Mode = "prepare" | "battle" | "result";
type SpeechMode = "browser" | "qiniu";

const portraits: Record<string, string> = {
  swordsman: "/characters/swordsman.svg",
  guardian: "/characters/guardian.svg",
  warlock: "/characters/warlock.svg",
  archer: "/characters/archer.svg",
};

const tierNames = { SHORT: "短咒", MEDIUM: "中咒", LONG: "长咒" } as const;

function effectText(effect: SkillEffect): string {
  switch (effect.type) {
    case "DAMAGE":
      return `伤害 ${effect.amount}`;
    case "HEAL":
      return `治疗 ${effect.amount}`;
    case "SHIELD":
      return `护盾 ${effect.amount}`;
    case "BREAK_SHIELD":
      return effect.amount === null ? "破除全部护盾" : `破盾 ${effect.amount}`;
    case "SELF_BUFF":
      return `${effect.tag} ${effect.value}% / ${effect.durationRounds}回合`;
    case "OPPONENT_DEBUFF":
      return `${effect.tag} ${effect.value} / ${effect.durationRounds}回合`;
    case "REMOVE_OPPONENT_BUFF":
      return "驱散敌方增益";
    case "CLEANSE_SELF_DEBUFF":
      return "净化自身减益";
    case "ACTION_RESTRICTION":
      return `封锁行动 ${effect.durationRounds}回合`;
  }
}

function eventText(event: BattleEvent): string {
  switch (event.type) {
    case "ROUND_STARTED":
      return `第 ${event.roundNo} 回合开始`;
    case "ACTION_ACCEPTED":
      return `技能发动，完成度 ${Number(event.payload.perfection ?? 100)}%`;
    case "DAMAGE_APPLIED":
      return `造成 ${Number(event.payload.hpDamage ?? 0)} 点生命伤害`;
    case "HEAL_APPLIED":
      return `恢复 ${Number(event.payload.amount ?? 0)} 点生命`;
    case "SHIELD_APPLIED":
      return `获得 ${Number(event.payload.amount ?? 0)} 点护盾`;
    case "STATUS_APPLIED":
      return "状态效果已生效";
    case "STATUS_TICK":
      return `持续效果结算 ${Number(event.payload.value ?? 0)} 点`;
    case "BATTLE_FINISHED":
      return "胜负已定";
    default:
      return event.type.replaceAll("_", " ");
  }
}

function VitalBar(
  { value, max, tone }: { value: number; max: number; tone: "hp" | "shield" },
) {
  const percent = max ? Math.max(0, Math.min(100, value / max * 100)) : 0;
  return (
    <div className={`vital-row ${tone}`}>
      {tone === "hp"
        ? <Heart aria-hidden="true" />
        : <Shield aria-hidden="true" />}
      <div className="vital-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <strong>{value}</strong>
      <small>/{max}</small>
    </div>
  );
}

function FighterPanel(
  { player, side }: { player: WebPlayerView; side: "self" | "opponent" },
) {
  return (
    <article className={`fighter ${side}`}>
      <div className="fighter-heading">
        <div>
          <span>{side === "self" ? "YOU" : "RIVAL"}</span>
          <h2>{player.nickname}</h2>
        </div>
        <p>{player.characterName ?? "选择中"}</p>
      </div>
      <VitalBar value={player.hp} max={player.maxHp} tone="hp" />
      <VitalBar value={player.shield} max={player.maxShield} tone="shield" />
      <div className="status-strip">
        {player.statuses.map((status) => (
          <span key={status.id} title={status.tag}>
            {status.tag} · {status.remainingRounds}
          </span>
        ))}
        {player.actionDisabled && <span className="danger">行动封锁</span>}
      </div>
    </article>
  );
}

function PrepareView(
  { battle, battleId }: { battle: WebBattleView; battleId: string },
) {
  const queryClient = useQueryClient();
  const characters = useQuery({
    queryKey: ["characters"],
    queryFn: webApi.characters,
    staleTime: Infinity,
  });
  const select = useMutation({
    mutationFn: (characterId: string) =>
      webApi.selectCharacter(battleId, characterId),
    onSuccess: (data) => queryClient.setQueryData(["battle", battleId], data),
  });
  const ready = useMutation({
    mutationFn: (value: boolean) => webApi.ready(battleId, value),
    onSuccess: (data) => queryClient.setQueryData(["battle", battleId], data),
  });

  return (
    <main className="prepare-shell">
      <header className="stage-header">
        <div>
          <p className="eyebrow">DUEL FOUND</p>
          <h1>选择你的角色</h1>
        </div>
        <div className="versus-names">
          <span>{battle.self.nickname}</span>
          <Swords />
          <span>{battle.opponent.nickname}</span>
        </div>
      </header>
      <section className="character-grid">
        {characters.data?.map((character) => {
          const selected = battle.self.characterId === character.id;
          return (
            <button
              key={character.id}
              className={`character-card ${selected ? "selected" : ""}`}
              onClick={() => select.mutate(character.id)}
              disabled={select.isPending}
            >
              <div
                className="portrait-wrap"
                style={{ "--accent": character.accent } as React.CSSProperties}
              >
                <Image
                  src={character.portrait}
                  alt=""
                  width={360}
                  height={420}
                  priority
                />
                <span>{character.role}</span>
              </div>
              <div className="character-info">
                <div>
                  <h2>{character.name}</h2>
                  {selected && <Check aria-label="已选择" />}
                </div>
                <p>{character.summary}</p>
                <div className="spell-preview">
                  {character.skills.map((skill) => (
                    <span key={skill.id}>{skill.name}</span>
                  ))}
                </div>
              </div>
            </button>
          );
        })}
      </section>
      <footer className="ready-bar">
        <div className={`ready-state ${battle.opponent.ready ? "active" : ""}`}>
          <span />对手{battle.opponent.ready ? "已准备" : "选择中"}
        </div>
        <button
          className="primary-button"
          disabled={!battle.self.characterId || ready.isPending}
          onClick={() => ready.mutate(!battle.self.ready)}
        >
          {battle.self.ready ? "取消准备" : "准备出战"}
          <ChevronRight aria-hidden="true" />
        </button>
      </footer>
    </main>
  );
}

function SkillTile({ skill }: { skill: WebSkillView }) {
  return (
    <div
      className={`skill-tile ${skill.available ? "" : "disabled"}`}
      title={skill.unavailableReason ?? undefined}
    >
      <div>
        <strong>{skill.name}</strong>
        <span className={`tier ${skill.phraseLengthTier.toLowerCase()}`}>
          {tierNames[skill.phraseLengthTier]}
        </span>
      </div>
      <p>{skill.effects.map(effectText).join(" · ")}</p>
      <small>
        {skill.remainingUses === null
          ? `已用 ${skill.used} 次`
          : `剩余 ${skill.remainingUses} 次`}
      </small>
    </div>
  );
}

function BattleView(
  { battle, battleId }: { battle: WebBattleView; battleId: string },
) {
  const queryClient = useQueryClient();
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [speechMode, setSpeechMode] = useState<SpeechMode>("browser");
  const spokenSequence = useRef(battle.latestSequence);
  const sendVoice = useCallback(async (audio: Blob) => {
    if (!battle.roundNo) return;
    const result = await webApi.voice(
      battleId,
      crypto.randomUUID(),
      battle.roundNo,
      audio,
    );
    setLastAction(`${result.transcript} · ${result.perfection}%`);
    queryClient.setQueryData(["battle", battleId], result.battle);
  }, [battle.roundNo, battleId, queryClient]);
  const recorder = useVoiceRecorder(sendVoice);
  const sendRecognized = useCallback(async (
    result: { transcript: string; confidence?: number },
  ) => {
    if (!battle.roundNo) return;
    const action = await webApi.recognized(
      battleId,
      crypto.randomUUID(),
      battle.roundNo,
      result.transcript,
      result.confidence,
    );
    setLastAction(`${action.transcript} · ${action.perfection}%`);
    queryClient.setQueryData(["battle", battleId], action.battle);
  }, [battle.roundNo, battleId, queryClient]);
  const browserSpeech = useBrowserSpeechRecognition(sendRecognized);
  const activeSpeech = speechMode === "browser" ? browserSpeech : recorder;
  const speechBusy = recorder.status === "requesting" ||
    recorder.status === "recording" || recorder.status === "encoding" ||
    browserSpeech.status === "requesting" ||
    browserSpeech.status === "recording" ||
    browserSpeech.status === "encoding";
  const browserUnavailable = speechMode === "browser" &&
    browserSpeech.supported === false;

  useEffect(() => {
    const narratable = new Set([
      "ACTION_ACCEPTED",
      "BATTLE_RESULT",
      "ROUND_STARTED",
      "BATTLE_FINISHED",
    ]);
    const pending = battle.events.filter((event) =>
      event.sequence > spokenSequence.current && narratable.has(event.type)
    );
    spokenSequence.current = Math.max(
      spokenSequence.current,
      battle.latestSequence,
    );
    let cancelled = false;
    void (async () => {
      for (const event of pending) {
        if (cancelled) break;
        const audio = new Audio(
          `/api/web/v1/battles/${battleId}/events/${event.sequence}/audio`,
        );
        try {
          await audio.play();
        } catch {
          continue;
        }
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 8_000);
          const done = () => {
            clearTimeout(timeout);
            resolve();
          };
          audio.onended = done;
          audio.onerror = done;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [battle.events, battle.latestSequence, battleId]);

  return (
    <main className="battle-shell">
      <header className="battle-topbar">
        <span>
          ROUND <strong>{battle.roundNo}</strong>
        </span>
        <div className="round-state">
          <span className="status-dot" />等待招式
        </div>
        <button
          className="icon-button"
          onClick={() => setLogOpen(!logOpen)}
          aria-label="战斗记录"
        >
          <History />
        </button>
      </header>
      <section className="arena">
        <FighterPanel player={battle.opponent} side="opponent" />
        <div className="combat-stage">
          <div className="fighter-portrait opponent">
            {battle.opponent.characterId && (
              <Image
                src={portraits[battle.opponent.characterId]}
                alt={battle.opponent.characterName ?? "对手"}
                width={360}
                height={420}
                priority
              />
            )}
          </div>
          <div className="turn-sigil">
            <Sparkles />
            <span>{lastAction ?? "VOICE READY"}</span>
          </div>
          <div className="fighter-portrait self">
            {battle.self.characterId && (
              <Image
                src={portraits[battle.self.characterId]}
                alt={battle.self.characterName ?? "自己"}
                width={360}
                height={420}
                priority
              />
            )}
          </div>
        </div>
        <FighterPanel player={battle.self} side="self" />
      </section>
      <section className="command-deck">
        <div className="skills-grid">
          {battle.skills.map((skill) => (
            <SkillTile key={skill.id} skill={skill} />
          ))}
        </div>
        <div className="voice-control">
          <div className="speech-mode" role="group" aria-label="语音识别方式">
            <button
              type="button"
              className={speechMode === "browser" ? "active" : ""}
              aria-pressed={speechMode === "browser"}
              onClick={() => setSpeechMode("browser")}
              disabled={speechBusy}
            >
              <Laptop aria-hidden="true" />浏览器
            </button>
            <button
              type="button"
              className={speechMode === "qiniu" ? "active" : ""}
              aria-pressed={speechMode === "qiniu"}
              onClick={() => setSpeechMode("qiniu")}
              disabled={speechBusy}
            >
              <Cloud aria-hidden="true" />七牛
            </button>
          </div>
          <button
            className={`mic-button ${activeSpeech.status}`}
            onPointerDown={() => void activeSpeech.start()}
            onPointerUp={() => void activeSpeech.stop()}
            onPointerCancel={() => void activeSpeech.stop()}
            disabled={battle.roundStatus !== "WAITING_COMMAND" ||
              activeSpeech.status === "encoding" || browserUnavailable ||
              battle.self.actionDisabled}
            aria-label="按住发动招式"
          >
            {activeSpeech.status === "encoding" ? <Activity /> : <Mic />}
          </button>
          <span>
            {activeSpeech.status === "recording"
              ? "正在聆听"
              : activeSpeech.status === "requesting"
              ? "等待授权"
              : activeSpeech.status === "encoding"
              ? "判定中"
              : "咒音就绪"}
          </span>
          {browserUnavailable
            ? <small>当前浏览器不支持语音识别</small>
            : activeSpeech.error && <small>{activeSpeech.error}</small>}
        </div>
      </section>
      {logOpen && (
        <aside className="battle-log">
          <header>
            <h2>战斗记录</h2>
            <button
              className="icon-button"
              onClick={() => setLogOpen(false)}
              aria-label="关闭记录"
            >
              <ChevronRight />
            </button>
          </header>
          {[...battle.events].reverse().map((event) => (
            <div key={event.sequence}>
              <span>{String(event.sequence).padStart(2, "0")}</span>
              <p>{eventText(event)}</p>
            </div>
          ))}
        </aside>
      )}
    </main>
  );
}

function ResultView({ battle }: { battle: WebBattleView }) {
  const router = useRouter();
  const won = battle.winnerPlayerId === battle.self.playerId;
  return (
    <main className={`result-shell ${won ? "victory" : "defeat"}`}>
      <div className="result-character">
        {battle.self.characterId && (
          <Image
            src={portraits[battle.self.characterId]}
            alt=""
            width={360}
            height={420}
            priority
          />
        )}
      </div>
      <section>
        <p className="eyebrow">MATCH COMPLETE</p>
        <h1>{won ? "胜利" : "落败"}</h1>
        <p>{battle.self.nickname} · {battle.self.characterName}</p>
        <div className="result-stats">
          <div>
            <Clock3 />
            <span>回合</span>
            <strong>{battle.roundNo}</strong>
          </div>
          <div>
            <Heart />
            <span>剩余生命</span>
            <strong>{battle.self.hp}</strong>
          </div>
          <div>
            <Volume2 />
            <span>出招次数</span>
            <strong>
              {battle.skills.reduce((sum, skill) => sum + skill.used, 0)}
            </strong>
          </div>
        </div>
        <button className="primary-button" onClick={() => router.push("/")}>
          返回大厅<ChevronRight />
        </button>
      </section>
    </main>
  );
}

export function GameScreen(
  { battleId, mode }: { battleId: string; mode: Mode },
) {
  const router = useRouter();
  const battle = useQuery({
    queryKey: ["battle", battleId],
    queryFn: () => webApi.battle(battleId),
    refetchInterval: (query) =>
      query.state.data?.status === "PREPARING" ? 1000 : 450,
  });

  useEffect(() => {
    if (!battle.data) return;
    if (battle.data.status === "RUNNING" && mode !== "battle") {
      router.replace(`/battle/${battleId}`);
    }
    if (battle.data.status === "FINISHED" && mode !== "result") {
      router.replace(`/result/${battleId}`);
    }
    if (battle.data.status === "PREPARING" && mode !== "prepare") {
      router.replace(`/prepare/${battleId}`);
    }
  }, [battle.data, battleId, mode, router]);

  if (battle.isPending) {
    return (
      <main className="loading-screen">
        <Swords />
        <p>载入战局</p>
      </main>
    );
  }
  if (battle.isError || !battle.data) {
    return (
      <main className="loading-screen error">
        <p>无法读取该对局</p>
        <button className="quiet-button" onClick={() => router.push("/")}>
          返回大厅
        </button>
      </main>
    );
  }
  if (mode === "prepare") {
    return <PrepareView battle={battle.data} battleId={battleId} />;
  }
  if (mode === "result") return <ResultView battle={battle.data} />;
  return <BattleView battle={battle.data} battleId={battleId} />;
}
