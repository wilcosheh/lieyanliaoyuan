import "server-only";
import { WebBattleApplication } from "../../../src/adapter/http/battle_application.ts";
import { InMemoryWebLobbyRepository } from "../../../src/adapter/http/lobby/repository.ts";
import { SupabaseWebLobbyRepository } from "../../../src/adapter/http/lobby/supabase_repository.ts";
import { BattleSessionService } from "../../../src/engine/service/session.ts";
import { InMemoryBattleRepository } from "../../../src/engine/store/repository.ts";
import { SupabaseBattleRepository } from "../../../src/engine/store/supabase_repository.ts";
import { QiniuSpeechProvider } from "../../../src/speech/qiniu_provider.ts";
import type { SpeechProvider } from "../../../src/speech/provider.ts";

class UnconfiguredSpeechProvider implements SpeechProvider {
  recognize(): Promise<never> {
    return Promise.reject(new Error("QINIU_SPEECH_NOT_CONFIGURED"));
  }
  synthesize(): Promise<never> {
    return Promise.reject(new Error("QINIU_SPEECH_NOT_CONFIGURED"));
  }
}

function speechProvider(): SpeechProvider {
  const accessKey = process.env.QINIU_DORA_ACCESS_KEY;
  const secretKey = process.env.QINIU_DORA_SECRET_KEY;
  if (!accessKey || !secretKey) {
    return new UnconfiguredSpeechProvider();
  }
  const ttsBaseUrl = process.env.QINIU_AI_BASE_URL;
  const ttsApiKey = process.env.QINIU_AI_API_KEY;
  const ttsModel = process.env.QINIU_TTS_MODEL;
  return new QiniuSpeechProvider({
    accessKey,
    secretKey,
    asrUrl: process.env.QINIU_DORA_ASR_URL,
    tts: ttsBaseUrl && ttsApiKey && ttsModel
      ? {
        baseUrl: ttsBaseUrl,
        apiKey: ttsApiKey,
        model: ttsModel,
        defaultVoice: process.env.QINIU_TTS_VOICE,
        path: process.env.QINIU_TTS_PATH,
      }
      : undefined,
  });
}

function buildStatefulRuntime() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const battleRepository = url && key
    ? new SupabaseBattleRepository(url, key)
    : new InMemoryBattleRepository();
  const lobby = url && key
    ? new SupabaseWebLobbyRepository(url, key)
    : new InMemoryWebLobbyRepository();
  const battles = new BattleSessionService(battleRepository);
  return { battles, lobby };
}

type StatefulRuntime = ReturnType<typeof buildStatefulRuntime>;

function buildRuntime(stateful: StatefulRuntime) {
  const speech = speechProvider();
  return {
    ...stateful,
    speech,
    application: new WebBattleApplication(
      stateful.battles,
      stateful.lobby,
      speech,
    ),
  };
}

type Runtime = ReturnType<typeof buildRuntime>;
const globalRuntime = globalThis as typeof globalThis & {
  __lieyanWebStatefulRuntime?: StatefulRuntime;
  // 兼容修复前开发进程中已经缓存的完整运行时。
  __lieyanWebRuntime?: Runtime;
};

const legacyRuntime = globalRuntime.__lieyanWebRuntime;
const statefulRuntime = globalRuntime.__lieyanWebStatefulRuntime ??
  (legacyRuntime
    ? { battles: legacyRuntime.battles, lobby: legacyRuntime.lobby }
    : buildStatefulRuntime());

/** 只缓存有状态服务；控制器和外部 Provider 每次热更新都使用最新实现。 */
export const runtime = buildRuntime(statefulRuntime);
if (process.env.NODE_ENV !== "production") {
  globalRuntime.__lieyanWebStatefulRuntime = statefulRuntime;
  delete globalRuntime.__lieyanWebRuntime;
}
