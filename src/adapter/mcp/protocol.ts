import type { SayDelivery } from "../../engine/service/game.ts";
import { encodeLinx } from "./linx.ts";

export type RpcId = number | string;

export const INSTRUCTIONS = [
  "你是烈焰燎原的报幕。最高优先级：工具返回后，下一句台词必须与 content 全文完全一致，一次说完。禁止拆成多条消息。禁止在 content 前后加任何字。content 为空则完全沉默，一个字都不要说。",
  "只使用这 6 个工具：submit_lobby_text、submit_utterance、begin_cast、cancel_cast、ack_playback、wait_event。没有 create_room、join_room、ready、cast、set_name。",
  "每次调用都传 device_id，值用提示词里写死的这一台设备号，不要改。禁止把 device_id 写成烈焰燎原、角色名或玩家名字。同机再传 seat，只能是 A 或 B。",
  "玩家一开口，先调用工具，再出声。禁止在工具返回前说话。禁止说：好的、请告诉我你的名字、你叫什么、人机对战已就绪、请说出房间号、想选哪个角色、接下来要。没有记名。玩家自报姓名时不要接话，把原话交给 submit_lobby_text。",
  "玩家说选角、练习、对电脑、人机、人机对战、人机对抗、打电脑、两个人、开房间、创建房间、房间号、准备、再来一局、复盘：立刻调用 submit_lobby_text。text 必须是玩家这一句的原话，禁止沿用上一句。",
  "战场里玩家念技能：submit_utterance，text 填原话。看血、还有哪些技能、投降也走它。完成度省略。大厅疑问用 submit_lobby_text。",
  "content 里的「三。二。一。」必须连成一句原样念完，含「一。」。禁止拆成「三。」「二。」两条，禁止漏掉「一。」，禁止自己另数。",
  "ack_playback 只传 device_id，不要传 text。只有 ack_required 为 true 时才调用 ack_playback。ack_required 为 false 时禁止 ack。",
  "wait 为 true：整句 content 念完后立刻 wait_event。wait 为 false：念完就停，等玩家再说，禁止 wait_event。",
  "不要替电脑提交，不要改写玩家的话。",
].join("");

export function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return toolArguments(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function messageEndpoint(req: Request, sessionId: string): string {
  const url = new URL(req.url);
  const configured = Deno.env.get("PUBLIC_BASE_URL")?.replace(/\/$/, "");
  const path = url.pathname.replace(/\/$/, "");
  const base = configured || `${url.origin}${path}`;
  const params = new URLSearchParams();
  params.set("sessionId", sessionId);
  const key = url.searchParams.get("key");
  if (key) params.set("key", key);
  return `${base}/message?${params.toString()}`;
}

export function rpcResult(id: RpcId, delivery: SayDelivery) {
  const encoded = encodeLinx(delivery);
  const structured: Record<string, unknown> = {
    code: delivery.code,
    phase: delivery.phase,
    say: delivery.say,
    wait: delivery.wait,
    ack_required: delivery.ack_required,
    event_id: delivery.event_id,
    clips: delivery.clips,
    stop_clips: delivery.stop_clips,
    funcs: encoded.funcs,
  };
  if (delivery.opens_at) {
    structured.opens_at = delivery.opens_at;
    structured.opens_in_ms = delivery.opens_in_ms;
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: encoded.content,
      structuredContent: structured,
    },
  };
}
