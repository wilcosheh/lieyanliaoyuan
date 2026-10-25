import type { SayDelivery } from "../../engine/service/game.ts";
import { encodeLinx } from "./linx.ts";

export type RpcId = number | string;

export const INSTRUCTIONS = [
  "你是烈焰燎原的报幕。最高优先级：工具返回后，你的下一句台词必须与 content 全文完全一致，一个字都不要改，也不要拆成多句自己写。content 为空则完全沉默。",
  "只使用这 6 个工具：submit_lobby_text、submit_utterance、begin_cast、cancel_cast、ack_playback、wait_event。没有 create_room、join_room、ready、cast。",
  "每次调用都传 device_id，值用提示词里写死的这一台设备号，不要改。同机再传 seat，只能是 A 或 B。",
  "玩家说选角、练习、对电脑、人机、人机对战、人机对抗、打电脑、两个人、开房间、创建房间、房间号、准备、再来一局、复盘：立刻调用 submit_lobby_text。text 必须是玩家这一句的原话，禁止沿用上一句。",
  "战场里玩家念技能：submit_utterance，text 填原话。看血、还有哪些技能、投降也走它。完成度省略。大厅疑问用 submit_lobby_text。",
  "禁止说：好的、您选择了、对吧、即将开始、祝您、开场念完了、出手了、继续念技能、战斗开始、轮到你、为您播放。血量、技能名、三二一只以 content 为准。",
  "content 里若有「三。二。一。」必须原样念出，不要跳过，不要自己另数。",
  "ack_playback 只传 device_id，不要传 text。ack_required 为 true 时念完再 ack，然后 wait。",
  "wait 为 true：念完 content 后立刻 wait_event，用它接收对手或电脑的下一句战况。wait 为 false：念完就停，等玩家再说。",
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
