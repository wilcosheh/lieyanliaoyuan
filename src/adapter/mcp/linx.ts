import type { SayDelivery } from "../../engine/service/game.ts";
import { COUNTDOWN_SAY } from "../../engine/narration/lines.ts";

export type LinxFunc = {
  name: "linx_stop" | "linx_play";
  arguments: { audio_url?: string };
};

/** 只编码引擎已经给了地址的片段。没有地址就不播放。 */
export function encodeLinx(
  delivery: Pick<SayDelivery, "say" | "clips" | "stop_clips">,
): {
  content: Array<{ type: "text"; text: string }>;
  funcs: LinxFunc[];
} {
  const funcs: LinxFunc[] = [];
  const clips = delivery.clips.filter((clip) => clip.url.length > 0);
  if (delivery.stop_clips && clips.length > 0) {
    funcs.push({ name: "linx_stop", arguments: {} });
  }
  for (const clip of clips) {
    funcs.push({ name: "linx_play", arguments: { audio_url: clip.url } });
  }
  return {
    content: speakableContent(delivery.say),
    funcs,
  };
}

/** 倒数单独一段。接在长句尾上时，模型会把「三。二。一。」整段丢掉。 */
function speakableContent(say: string): Array<{ type: "text"; text: string }> {
  if (say.endsWith(COUNTDOWN_SAY) && say !== COUNTDOWN_SAY) {
    return [
      { type: "text", text: say.slice(0, -COUNTDOWN_SAY.length) },
      { type: "text", text: COUNTDOWN_SAY },
    ];
  }
  return [{ type: "text", text: say }];
}
