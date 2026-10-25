import { assertEquals } from "@std/assert";
import type { SayDelivery } from "../../engine/service/game.ts";
import { encodeLinx } from "./linx.ts";

const delivery: SayDelivery = {
  code: "ACCEPTED",
  event_id: "e1",
  say: "疾风剑命中。你1000血。对手935血。",
  clips: [{ kind: "cpu_spell", url: "https://example.com/a.wav" }],
  stop_clips: true,
  ack_required: true,
  phase: "BATTLE",
  wait: true,
};

Deno.test("linx encodes only clips that already have a url", () => {
  const encoded = encodeLinx(delivery);
  assertEquals(encoded.content, [{
    type: "text",
    text: "疾风剑命中。你1000血。对手935血。",
  }]);
  assertEquals(encoded.funcs, [
    { name: "linx_stop", arguments: {} },
    {
      name: "linx_play",
      arguments: { audio_url: "https://example.com/a.wav" },
    },
  ]);
  assertEquals(
    encodeLinx({ ...delivery, clips: [], stop_clips: true }).funcs,
    [],
  );
});

Deno.test("countdown is its own content block after the battle line", () => {
  const encoded = encodeLinx({
    ...delivery,
    say: "双方各1000血。血量先到0的一方落败。三。二。一。",
    clips: [],
  });
  assertEquals(encoded.content, [
    { type: "text", text: "双方各1000血。血量先到0的一方落败。" },
    { type: "text", text: "三。二。一。" },
  ]);
});
